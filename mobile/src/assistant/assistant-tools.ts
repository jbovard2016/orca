// The five voice tools: their JSON schemas for the Realtime session and the
// executor that maps them onto the phone's existing paired RPC methods.
// Read-only tools run at once. Mutating tools only create a pending action in
// the gate; execution happens in `executeApproved` after the user's own yes.

import { stripAnsiEscapeSequences } from '../../../src/shared/ansi-escape-sequences'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import { PendingActionGate, type FrozenTarget, type PendingAction } from './pending-action'
export { ASSISTANT_TOOLS, type ToolDefinition } from './assistant-tool-schemas'
import {
  resolveTerminal,
  resolveWorktree,
  type PsWorktree,
  type TerminalSummary
} from './target-resolver'

export type ToolClient = Pick<RpcClient, 'sendRequest'>

export const SPOKEN_TEXT_BUDGET = 1200
export const HISTORY_READ_LINES = 120
export const TUI_IDLE_TIMEOUT_MS = 15_000

export type ToolContext = {
  client: ToolClient
  gate: PendingActionGate
}

export type ToolResult = Record<string, unknown>

function unwrap<T>(response: RpcResponse): T {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as T
}

async function fetchWorktrees(client: ToolClient): Promise<PsWorktree[]> {
  const result = unwrap<{ worktrees?: unknown }>(
    await client.sendRequest('worktree.ps', { limit: 500 })
  )
  return Array.isArray(result.worktrees) ? (result.worktrees as PsWorktree[]) : []
}

async function fetchTerminals(client: ToolClient, worktreeId: string): Promise<TerminalSummary[]> {
  const result = unwrap<{ terminals?: unknown }>(
    await client.sendRequest('terminal.list', { worktree: `id:${worktreeId}` })
  )
  return Array.isArray(result.terminals) ? (result.terminals as TerminalSummary[]) : []
}

function branchLeaf(branch: string): string {
  return (branch || '').replace(/^refs\/heads\//, '')
}

export function spokenTrim(
  text: string,
  budget = SPOKEN_TEXT_BUDGET
): { text: string; truncated: boolean } {
  const clean = stripAnsiEscapeSequences(text)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
  if (clean.length <= budget) {
    return { text: clean, truncated: false }
  }
  return { text: clean.slice(clean.length - budget), truncated: true }
}

type Resolved = {
  worktree: PsWorktree
  terminal: TerminalSummary | null
  terminals: TerminalSummary[]
}

async function resolveTarget(
  client: ToolClient,
  target: string,
  spokenTerminal?: string
): Promise<{ ok: true; resolved: Resolved } | { ok: false; result: ToolResult }> {
  const worktrees = await fetchWorktrees(client)
  const w = resolveWorktree(target, worktrees)
  if (w.kind === 'none') {
    return { ok: false, result: { error: 'no_such_session', target } }
  }
  if (w.kind === 'ambiguous') {
    return { ok: false, result: { error: 'ambiguous_session', candidates: w.candidates } }
  }
  const terminals = await fetchTerminals(client, w.worktree.worktreeId)
  const t = resolveTerminal(terminals, w.worktree.worktreeId, spokenTerminal)
  if (t.kind === 'ambiguous') {
    return { ok: false, result: { error: 'ambiguous_terminal', candidates: t.candidates } }
  }
  return {
    ok: true,
    resolved: { worktree: w.worktree, terminal: t.kind === 'match' ? t.terminal : null, terminals }
  }
}

function frozen(worktree: PsWorktree, terminal: TerminalSummary | null): FrozenTarget {
  return {
    worktreeId: worktree.worktreeId,
    worktreeName: worktree.displayName,
    terminalHandle: terminal?.handle,
    terminalTitle: terminal?.title,
    incarnationId: terminal?.incarnationId,
    agentIdentity: terminal?.agentIdentity
  }
}

export async function listAgents(client: ToolClient): Promise<ToolResult> {
  const worktrees = await fetchWorktrees(client)
  const sessions = worktrees
    .filter((w) => !w.isArchived && (w.agents?.length ?? 0) > 0)
    .map((w) => ({
      name: w.displayName,
      repo: w.repo,
      branch: branchLeaf(w.branch),
      comment: w.comment || undefined,
      agents: (w.agents ?? []).map((a) => ({
        agent: a.agentType,
        state: a.state,
        lastMessage: a.lastAssistantMessage
          ? spokenTrim(a.lastAssistantMessage, 300).text
          : undefined,
        lastPrompt: a.prompt ? spokenTrim(a.prompt, 160).text : undefined
      }))
    }))
  return { sessions, count: sessions.length }
}

export async function readAgent(
  client: ToolClient,
  args: { target: string; terminal?: string; mode?: 'screen' | 'history'; cursor?: string }
): Promise<ToolResult> {
  const r = await resolveTarget(client, args.target, args.terminal)
  if (!r.ok) {
    return r.result
  }
  const { worktree, terminal } = r.resolved
  if (!terminal) {
    return { error: 'no_agent_terminal', session: worktree.displayName }
  }
  const params: Record<string, unknown> =
    args.mode === 'history'
      ? {
          terminal: terminal.handle,
          limit: HISTORY_READ_LINES,
          ...(args.cursor ? { cursor: Number(args.cursor) } : {})
        }
      : { terminal: terminal.handle, screen: true }
  const read = unwrap<{
    status?: string
    tail?: string[]
    oldestCursor?: string
    nextCursor?: string | null
    limited?: boolean
    source?: string
  }>(await client.sendRequest('terminal.read', params))
  const { text, truncated } = spokenTrim((read.tail ?? []).join('\n'))
  const agent = (worktree.agents ?? []).find((a) => a.lastAssistantMessage)
  return {
    session: worktree.displayName,
    terminal: terminal.title,
    agent: terminal.agentIdentity,
    status: read.status,
    source: read.source,
    text,
    truncated,
    moreAvailable: Boolean(read.limited) || truncated,
    oldestCursor: read.oldestCursor,
    lastMessage: agent?.lastAssistantMessage
      ? spokenTrim(agent.lastAssistantMessage, 300).text
      : undefined
  }
}

export const CLAUDE_CODE_SLASH_MAP: Record<string, (value: string) => string> = {
  model: (v) => `/model ${v}`,
  effort: (v) => `/effort ${v}`
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
  return { status: 'needs_confirmation', actionId: action.id, readBack }
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
  return { status: 'needs_confirmation', actionId: action.id, readBack }
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
  return { status: 'needs_confirmation', actionId: action.id, readBack }
}

/** Runs after the gate has been opened by the user's own yes. Re-verifies the target first. */
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
    const terminals = await fetchTerminals(ctx.client, pending.target.worktreeId)
    const live = terminals.find((t) => t.handle === pending.target.terminalHandle) ?? null
    const ok = ctx.gate.verifyTarget(
      pending.target.terminalHandle
        ? live && {
            worktreeId: live.worktreeId,
            terminalHandle: live.handle,
            incarnationId: live.incarnationId,
            agentIdentity: live.agentIdentity
          }
        : { worktreeId: pending.target.worktreeId }
    )
    if (!ok) {
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
export async function executeTool(
  ctx: ToolContext,
  name: string,
  rawArgs: unknown
): Promise<ToolResult> {
  const args = (rawArgs && typeof rawArgs === 'object' ? rawArgs : {}) as Record<
    string,
    string | boolean | undefined
  >
  try {
    switch (name) {
      case 'list_agents':
        return await listAgents(ctx.client)
      case 'read_agent':
        return await readAgent(ctx.client, args as Parameters<typeof readAgent>[1])
      case 'send_agent':
        return await stageSendAgent(ctx, args as Parameters<typeof stageSendAgent>[1])
      case 'activate_agent':
        return await stageActivateAgent(ctx, args as Parameters<typeof stageActivateAgent>[1])
      case 'create_agent':
        return await stageCreateAgent(ctx, args as Parameters<typeof stageCreateAgent>[1])
      default:
        return { error: 'unknown_tool', name }
    }
  } catch (err) {
    return { error: 'rpc_failed', message: err instanceof Error ? err.message : String(err) }
  }
}
