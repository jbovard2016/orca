// Read-only voice tools and the Realtime function-call dispatcher.
// Mutating tools live in assistant-actions.ts and only stage a pending action.

import {
  HISTORY_READ_LINES,
  branchLeaf,
  fetchWorktrees,
  parseCursor,
  resolveTarget,
  spokenTrim,
  unwrap,
  type ToolClient,
  type ToolContext,
  type ToolResult
} from './tool-helpers'
import { stageActivateAgent, stageCreateAgent, stageSendAgent } from './assistant-actions'

export { ASSISTANT_TOOLS, type ToolDefinition } from './assistant-tool-schemas'
export { executeApproved, CLAUDE_CODE_SLASH_MAP } from './assistant-actions'
export {
  parseCursor,
  spokenTrim,
  type ToolClient,
  type ToolContext,
  type ToolResult
} from './tool-helpers'

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
  const cursor = parseCursor(args.cursor)
  const params: Record<string, unknown> =
    args.mode === 'history'
      ? {
          terminal: terminal.handle,
          limit: HISTORY_READ_LINES,
          ...(cursor === null ? {} : { cursor })
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
