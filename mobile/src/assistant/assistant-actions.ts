// Mutating voice tools. Each one only *stages* a pending action in the gate
// and returns the read-back text. `executeApproved` runs after the user's own
// yes, re-verifying the frozen target first.

import type { PendingAction } from './pending-action'
import {
  TUI_IDLE_TIMEOUT_MS,
  frozen,
  liveTarget,
  resolveTarget,
  unwrap,
  type ToolClient,
  type ToolContext,
  type ToolResult
} from './tool-helpers'

export const CLAUDE_CODE_SLASH_MAP: Record<string, (value: string) => string> = {
  model: (v) => `/model ${v}`,
  effort: (v) => `/effort ${v}`
}

function staged(action: PendingAction): ToolResult {
  if (action.approvedAt && !action.consumedAt) {
    return { status: 'already_approved', actionId: action.id, readBack: action.readBack }
  }
  return { status: 'needs_confirmation', actionId: action.id, readBack: action.readBack }
}

export async function stageSendAgent(
  ctx: ToolContext,
  args: { target: string; terminal?: string; text: string; enter?: boolean }
): Promise<ToolResult> {
  const r = await resolveTarget(ctx.client, args.target, args.terminal)
  if (!r.ok) {
    return r.result
  }
  const { worktree, terminal } = r.resolved
  if (!terminal) {
    return { error: 'no_agent_terminal', session: worktree.displayName }
  }
  if (!terminal.agentIdentity) {
    return {
      error: 'not_an_agent_terminal',
      session: worktree.displayName,
      terminal: terminal.title
    }
  }
  const text = args.text.trim()
  if (!text) {
    return { error: 'empty_text' }
  }
  const enter = args.enter !== false
  const readBack = `Send "${text}"${enter ? '' : ' without Enter'} to ${terminal.agentIdentity} in ${worktree.displayName}, terminal ${terminal.title}?`
  const action = ctx.gate.create({
    kind: 'send_agent',
    args: { text, enter },
    target: frozen(worktree, terminal),
    readBack
  })
  return staged(action)
}

export async function stageActivateAgent(
  ctx: ToolContext,
  args: { target: string; terminal?: string }
): Promise<ToolResult> {
  const r = await resolveTarget(ctx.client, args.target, args.terminal)
  if (!r.ok) {
    return r.result
  }
  const { worktree, terminal } = r.resolved
  const readBack = `Switch to ${worktree.displayName}${terminal ? `, terminal ${terminal.title}` : ''}?`
  const action = ctx.gate.create({
    kind: 'activate_agent',
    args: {},
    target: frozen(worktree, terminal),
    readBack
  })
  return staged(action)
}

export async function stageCreateAgent(
  ctx: ToolContext,
  args: { repo: string; name: string; baseBranch?: string; agent: string; prompt: string }
): Promise<ToolResult> {
  const result = unwrap<{ repos?: Array<{ id: string; displayName?: string; path?: string }> }>(
    await ctx.client.sendRequest('repo.list', {})
  )
  const repos = result.repos ?? []
  const wanted = args.repo
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
  const matches = repos.filter((r) =>
    [r.displayName, (r.path || '').split(/[\\/]/).pop()].filter(Boolean).some(
      (n) =>
        String(n)
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, ' ')
          .trim() === wanted
    )
  )
  if (matches.length === 0) {
    return { error: 'no_such_repo', repo: args.repo, known: repos.map((r) => r.displayName) }
  }
  if (matches.length > 1) {
    return { error: 'ambiguous_repo', candidates: matches.map((r) => r.displayName) }
  }
  const repo = matches[0]
  const name = args.name.trim()
  const prompt = args.prompt.trim()
  if (!name || !prompt) {
    return { error: 'missing_fields' }
  }
  const readBack = `Create worktree ${name} in ${repo.displayName}${args.baseBranch ? ` from ${args.baseBranch}` : ' from the repo default base'}, start ${args.agent}, and send "${prompt}"?`
  const action = ctx.gate.create({
    kind: 'create_agent',
    args: { repoId: repo.id, name, baseBranch: args.baseBranch, agent: args.agent, prompt },
    target: { worktreeId: `new:${repo.id}:${name}`, worktreeName: name },
    readBack
  })
  return staged(action)
}

export async function executeApproved(ctx: ToolContext, actionId: string): Promise<ToolResult> {
  const pending = ctx.gate.current()
  if (!pending || pending.id !== actionId) {
    return { error: 'no_pending_action' }
  }
  if (pending.consumedAt) {
    return { error: 'already_executed' }
  }
  if (pending.invalidatedReason) {
    return { error: 'action_invalid', reason: pending.invalidatedReason }
  }
  if (pending.kind !== 'create_agent') {
    const live = await liveTarget(ctx.client, pending.target)
    if (!ctx.gate.verifyTarget(live)) {
      return { error: 'target_changed', reason: ctx.gate.current()?.invalidatedReason }
    }
  }
  const action = ctx.gate.take(actionId)
  if (!action) {
    return { error: 'not_approved', reason: ctx.gate.current()?.invalidatedReason ?? 'no_approval' }
  }
  return runAction(ctx.client, action)
}

async function runAction(client: ToolClient, action: PendingAction): Promise<ToolResult> {
  switch (action.kind) {
    case 'send_agent': {
      const { text, enter } = action.args as { text: string; enter: boolean }
      const handle = action.target.terminalHandle as string
      await client.sendRequest('terminal.wait', {
        terminal: handle,
        for: 'tui-idle',
        timeoutMs: TUI_IDLE_TIMEOUT_MS
      })
      const receipt = unwrap<Record<string, unknown>>(
        await client.sendRequest('terminal.send', { terminal: handle, text, enter })
      )
      const accepted = receipt && (receipt as { accepted?: unknown }).accepted !== false
      return {
        status: accepted ? 'sent' : 'rejected',
        receipt,
        session: action.target.worktreeName,
        terminal: action.target.terminalTitle
      }
    }
    case 'activate_agent': {
      unwrap(
        await client.sendRequest('worktree.activate', {
          worktree: `id:${action.target.worktreeId}`,
          notifyClients: true
        })
      )
      if (action.target.terminalHandle) {
        unwrap(
          await client.sendRequest('terminal.focus', { terminal: action.target.terminalHandle })
        )
      }
      return {
        status: 'activated',
        session: action.target.worktreeName,
        terminal: action.target.terminalTitle
      }
    }
    case 'create_agent': {
      const a = action.args as {
        repoId: string
        name: string
        baseBranch?: string
        agent: string
        prompt: string
      }
      const created = unwrap<{
        worktree?: { id?: string; displayName?: string }
        warning?: string
      }>(
        await client.sendRequest(
          'worktree.create',
          {
            repo: `id:${a.repoId}`,
            name: a.name,
            ...(a.baseBranch ? { baseBranch: a.baseBranch } : {}),
            startupAgent: a.agent,
            startupPrompt: a.prompt,
            setupDecision: 'inherit',
            clientMutationId: `voice-${action.id}`
          },
          { timeoutMs: 120_000 }
        )
      )
      return {
        status: 'created',
        worktreeId: created.worktree?.id,
        name: created.worktree?.displayName ?? a.name,
        warning: created.warning
      }
    }
  }
}

/** Dispatch a Realtime function call by name. Returns the JSON-serialisable result. */
