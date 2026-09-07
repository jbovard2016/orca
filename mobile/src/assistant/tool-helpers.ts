// Shared plumbing for the voice tools: RPC unwrapping, worktree/terminal
// fetches, spoken-text trimming, and spoken-name resolution to frozen targets.

import { stripAnsiEscapeSequences } from '../../../src/shared/ansi-escape-sequences'
import type { RpcClient } from '../transport/rpc-client'
import type { RpcResponse } from '../transport/types'
import type { PendingActionGate, FrozenTarget } from './pending-action'
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

export function unwrap<T>(response: RpcResponse): T {
  if (!response.ok) {
    throw new Error(response.error.message)
  }
  return response.result as T
}

export async function fetchWorktrees(client: ToolClient): Promise<PsWorktree[]> {
  const result = unwrap<{ worktrees?: unknown }>(
    await client.sendRequest('worktree.ps', { limit: 500 })
  )
  return Array.isArray(result.worktrees) ? (result.worktrees as PsWorktree[]) : []
}

export async function fetchTerminals(
  client: ToolClient,
  worktreeId: string
): Promise<TerminalSummary[]> {
  const result = unwrap<{ terminals?: unknown }>(
    await client.sendRequest('terminal.list', { worktree: `id:${worktreeId}` })
  )
  return Array.isArray(result.terminals) ? (result.terminals as TerminalSummary[]) : []
}

/** Cursors travel as strings; the RPC wants a non-negative integer or nothing. */
export function parseCursor(value: unknown): number | null {
  if (typeof value === 'number') {
    return Number.isInteger(value) && value >= 0 ? value : null
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value.trim())) {
    return null
  }
  const n = Number.parseInt(value.trim(), 10)
  return Number.isSafeInteger(n) && n >= 0 ? n : null
}

export function branchLeaf(branch: string): string {
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

export type Resolved = {
  worktree: PsWorktree
  terminal: TerminalSummary | null
  terminals: TerminalSummary[]
}

export async function resolveTarget(
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

export function frozen(worktree: PsWorktree, terminal: TerminalSummary | null): FrozenTarget {
  return {
    worktreeId: worktree.worktreeId,
    worktreeName: worktree.displayName,
    terminalHandle: terminal?.handle,
    terminalTitle: terminal?.title,
    incarnationId: terminal?.incarnationId,
    agentIdentity: terminal?.agentIdentity
  }
}

export type LiveTarget = {
  worktreeId: string
  terminalHandle?: string
  incarnationId?: string
  agentIdentity?: string
}

/** What Orca reports right now for a frozen target; null when the worktree or terminal is gone. */
export async function liveTarget(
  client: ToolClient,
  target: FrozenTarget
): Promise<LiveTarget | null> {
  const worktrees = await fetchWorktrees(client)
  if (!worktrees.some((w) => w.worktreeId === target.worktreeId && !w.isArchived)) {
    return null
  }
  if (!target.terminalHandle) {
    return { worktreeId: target.worktreeId }
  }
  const terminals = await fetchTerminals(client, target.worktreeId)
  const t = terminals.find((x) => x.handle === target.terminalHandle)
  return t
    ? {
        worktreeId: t.worktreeId,
        terminalHandle: t.handle,
        incarnationId: t.incarnationId,
        agentIdentity: t.agentIdentity
      }
    : null
}

/** Runs after the gate has been opened by the user's own yes. Re-verifies the target first. */
