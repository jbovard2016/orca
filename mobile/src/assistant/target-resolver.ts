// Resolves what the user said ("the truemarket agent", "sinns") to exact Orca
// identifiers, using fresh worktree.ps and terminal.list data. Never guesses:
// zero or several plausible matches return `ambiguous` so the assistant asks.

export type AgentStatusState = 'working' | 'blocked' | 'waiting' | 'done'

export type PsAgent = {
  paneKey: string
  state: AgentStatusState | string
  agentType: string
  prompt?: string | null
  lastAssistantMessage?: string | null
  toolName?: string | null
  stateStartedAt?: number
}

export type PsWorktree = {
  worktreeId: string
  repo: string
  branch: string
  displayName: string
  comment?: string
  isArchived?: boolean
  agents?: PsAgent[]
}

export type TerminalSummary = {
  handle: string
  title: string
  worktreeId: string
  incarnationId?: string
  agentIdentity?: string
  connected?: boolean
  writable?: boolean
}

export type WorktreeMatch = { kind: 'match'; worktree: PsWorktree }
export type AmbiguousMatch = { kind: 'ambiguous'; candidates: string[] }
export type NoMatch = { kind: 'none' }
export type ResolveWorktreeResult = WorktreeMatch | AmbiguousMatch | NoMatch

export type TerminalMatch = { kind: 'match'; terminal: TerminalSummary }
export type ResolveTerminalResult = TerminalMatch | AmbiguousMatch | NoMatch

export function normalizeName(value: string): string {
  return value
    .toLowerCase()
    .replace(/^refs\/heads\//, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

function tokens(value: string): string[] {
  return normalizeName(value).split(' ').filter(Boolean)
}

function candidateNames(w: PsWorktree): string[] {
  const branchLeaf =
    (w.branch || '')
      .replace(/^refs\/heads\//, '')
      .split('/')
      .pop() || ''
  return [w.displayName, w.repo, branchLeaf, w.comment || ''].filter(Boolean)
}

function scoreAgainst(spoken: string, names: string[]): number {
  const s = normalizeName(spoken)
  if (!s) {
    return 0
  }
  const sTokens = tokens(spoken)
  let best = 0
  for (const name of names) {
    const n = normalizeName(name)
    if (!n) {
      continue
    }
    if (n === s) {
      return 3
    }
    if (n.startsWith(s) || s.startsWith(n)) {
      best = Math.max(best, 2)
    }
    const nTokens = tokens(name)
    if (sTokens.some((t) => t.length >= 3 && nTokens.includes(t))) {
      best = Math.max(best, 1)
    }
  }
  return best
}

export function resolveWorktree(spoken: string, worktrees: PsWorktree[]): ResolveWorktreeResult {
  const live = worktrees.filter((w) => !w.isArchived)
  const scored = live
    .map((w) => ({ w, score: scoreAgainst(spoken, candidateNames(w)) }))
    .filter((x) => x.score > 0)
  if (scored.length === 0) {
    return { kind: 'none' }
  }
  const top = Math.max(...scored.map((x) => x.score))
  const winners = scored.filter((x) => x.score === top)
  if (winners.length === 1) {
    return { kind: 'match', worktree: winners[0].w }
  }
  return { kind: 'ambiguous', candidates: winners.map((x) => x.w.displayName) }
}

/**
 * Picks the agent terminal inside a worktree. With no spoken title, the single
 * agent terminal wins; several agent terminals and no title is ambiguous.
 */
export function resolveTerminal(
  terminals: TerminalSummary[],
  worktreeId: string,
  spokenTitle?: string
): ResolveTerminalResult {
  const inWorktree = terminals.filter((t) => t.worktreeId === worktreeId && t.connected !== false)
  if (inWorktree.length === 0) {
    return { kind: 'none' }
  }
  if (spokenTitle && normalizeName(spokenTitle)) {
    const scored = inWorktree
      .map((t) => ({ t, score: scoreAgainst(spokenTitle, [t.title]) }))
      .filter((x) => x.score > 0)
    // Why: the model sometimes invents a title (e.g. the repo name); an unmatched
    // title falls through to the agent-terminal rule instead of failing outright.
    if (scored.length > 0) {
      const top = Math.max(...scored.map((x) => x.score))
      const winners = scored.filter((x) => x.score === top)
      if (winners.length === 1) {
        return { kind: 'match', terminal: winners[0].t }
      }
      return { kind: 'ambiguous', candidates: winners.map((x) => x.t.title) }
    }
  }
  const agentTerminals = inWorktree.filter((t) => Boolean(t.agentIdentity))
  if (agentTerminals.length === 1) {
    return { kind: 'match', terminal: agentTerminals[0] }
  }
  if (agentTerminals.length > 1) {
    return { kind: 'ambiguous', candidates: agentTerminals.map((t) => t.title) }
  }
  return { kind: 'none' }
}
