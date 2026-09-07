import { describe, expect, it } from 'vitest'
import {
  resolveTerminal,
  resolveWorktree,
  type PsWorktree,
  type TerminalSummary
} from './target-resolver'

const wt = (
  id: string,
  displayName: string,
  repo: string,
  branch: string,
  extra: Partial<PsWorktree> = {}
): PsWorktree => ({
  worktreeId: id,
  displayName,
  repo,
  branch,
  ...extra
})

const worktrees: PsWorktree[] = [
  wt(
    'a',
    'fix/valp-324-cre-browser-use-first',
    'app',
    'refs/heads/fix/valp-324-cre-browser-use-first',
    { comment: 'truemarket valuation' }
  ),
  wt('b', 'codex-sinns', 'sinns-beach-club', 'refs/heads/codex-sinns'),
  wt('c', 'OmniRoute', 'OmniRoute', 'refs/heads/release/v3.8.51'),
  wt('d', 'old-thing', 'app', 'refs/heads/old', { isArchived: true })
]

describe('resolveWorktree', () => {
  it('matches a repo name exactly', () => {
    const r = resolveWorktree('omniroute', worktrees)
    expect(r.kind).toBe('match')
    expect(r.kind === 'match' && r.worktree.worktreeId).toBe('c')
  })
  it('matches a token inside a display name', () => {
    const r = resolveWorktree('sinns', worktrees)
    expect(r.kind === 'match' && r.worktree.worktreeId).toBe('b')
  })
  it('matches the comment', () => {
    const r = resolveWorktree('truemarket', worktrees)
    expect(r.kind === 'match' && r.worktree.worktreeId).toBe('a')
  })
  it('ignores archived worktrees', () => {
    expect(resolveWorktree('old thing', worktrees).kind).toBe('none')
  })
  it('returns none for nonsense', () => {
    expect(resolveWorktree('zzz', worktrees).kind).toBe('none')
  })
  it('is ambiguous when two worktrees share the spoken token', () => {
    const two = [...worktrees, wt('e', 'app-hotfix', 'app', 'refs/heads/hotfix')]
    const r = resolveWorktree('app', two)
    expect(r.kind).toBe('ambiguous')
    expect(r.kind === 'ambiguous' && r.candidates.length).toBe(2)
  })
})

const terms: TerminalSummary[] = [
  {
    handle: 't1',
    title: 'Orca voice agent integration',
    worktreeId: 'c',
    agentIdentity: 'claude',
    connected: true
  },
  { handle: 't2', title: 'Terminal 1', worktreeId: 'c', connected: true },
  { handle: 't3', title: 'builder', worktreeId: 'a', agentIdentity: 'codex', connected: true },
  { handle: 't4', title: 'tests', worktreeId: 'a', agentIdentity: 'claude', connected: true }
]

describe('resolveTerminal', () => {
  it('picks the only agent terminal when no title is spoken', () => {
    const r = resolveTerminal(terms, 'c')
    expect(r.kind === 'match' && r.terminal.handle).toBe('t1')
  })
  it('is ambiguous with two agent terminals and no title', () => {
    expect(resolveTerminal(terms, 'a').kind).toBe('ambiguous')
  })
  it('resolves by spoken title', () => {
    const r = resolveTerminal(terms, 'a', 'tests')
    expect(r.kind === 'match' && r.terminal.handle).toBe('t4')
  })
  it('can target a plain shell by title (the executor, not the resolver, refuses sends to it)', () => {
    const r = resolveTerminal(terms, 'c', 'terminal 1')
    expect(r.kind === 'match' && r.terminal.handle).toBe('t2')
  })
  it('falls back to the single agent terminal when the spoken title matches nothing', () => {
    const r = resolveTerminal(terms, 'c', 'jbovard2016/codex-sinns')
    expect(r.kind === 'match' && r.terminal.handle).toBe('t1')
  })
  it('an unmatched title with two agent terminals is still ambiguous', () => {
    expect(resolveTerminal(terms, 'a', 'nonsense').kind).toBe('ambiguous')
  })
  it('returns none for an unknown worktree', () => {
    expect(resolveTerminal(terms, 'zzz').kind).toBe('none')
  })
})
