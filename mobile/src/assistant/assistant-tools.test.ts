import { describe, expect, it } from 'vitest'
import { PendingActionGate } from './pending-action'
import { executeTool, parseCursor, spokenTrim } from './assistant-tools'
import { ESC, fakeClient, terminals, worktrees } from './test-fixtures'

describe('spokenTrim', () => {
  it('strips ANSI and keeps the tail within budget', () => {
    const r = spokenTrim(`${ESC}[31mred${ESC}[0m ` + 'x'.repeat(2000), 100)
    expect(r.truncated).toBe(true)
    expect(r.text.length).toBe(100)
    expect(r.text).not.toContain(ESC)
  })
})

describe('list_agents', () => {
  it('lists only worktrees with agents, with state and last message', async () => {
    const { client } = fakeClient({ worktrees, terminals })
    const r = await executeTool({ client, gate: new PendingActionGate() }, 'list_agents', {})
    expect(r.count).toBe(2)
    const sessions = r.sessions as Array<{
      name: string
      agents: Array<{ state: string; lastMessage?: string }>
    }>
    expect(sessions[0].name).toBe('OmniRoute')
    expect(sessions[0].agents[0].state).toBe('working')
    expect(sessions[0].agents[0].lastMessage).toBe('Running tests now')
  })
})

describe('read_agent', () => {
  it('reads the screen of the agent terminal', async () => {
    const { client, calls } = fakeClient({
      worktrees,
      terminals,
      read: { status: 'running', tail: [`${ESC}[1m$ npm test`, 'ok'], source: 'screen' }
    })
    const r = await executeTool({ client, gate: new PendingActionGate() }, 'read_agent', {
      target: 'omniroute'
    })
    expect(r.text).toBe('$ npm test\nok')
    expect(r.terminal).toBe('Orca voice agent integration')
    const read = calls.find((c) => c.method === 'terminal.read')
    expect(read?.params).toEqual({ terminal: 'h1', screen: true })
  })
  it('asks when the session name is ambiguous', async () => {
    const two = [
      ...worktrees,
      {
        worktreeId: 'w9',
        displayName: 'OmniRoute-hotfix',
        repo: 'OmniRoute',
        branch: 'refs/heads/hotfix',
        agents: []
      }
    ]
    const { client } = fakeClient({ worktrees: two, terminals })
    const r = await executeTool({ client, gate: new PendingActionGate() }, 'read_agent', {
      target: 'omniroute'
    })
    expect(r.error).toBe('ambiguous_session')
  })
  it('reports no_such_session', async () => {
    const { client } = fakeClient({ worktrees, terminals })
    const r = await executeTool({ client, gate: new PendingActionGate() }, 'read_agent', {
      target: 'nothing here'
    })
    expect(r.error).toBe('no_such_session')
  })
})

describe('cursor handling', () => {
  it('parseCursor accepts only non-negative integer strings or numbers', async () => {
    expect(parseCursor('42')).toBe(42)
    expect(parseCursor(' 7 ')).toBe(7)
    expect(parseCursor(3)).toBe(3)
    expect(parseCursor('')).toBeNull()
    expect(parseCursor('abc')).toBeNull()
    expect(parseCursor('-1')).toBeNull()
    expect(parseCursor(1.5)).toBeNull()
    expect(parseCursor(undefined)).toBeNull()
  })

  it('history read omits the cursor when it is not a valid integer', async () => {
    const { client, calls } = fakeClient({ worktrees, terminals })
    await executeTool({ client, gate: new PendingActionGate() }, 'read_agent', {
      target: 'omniroute',
      mode: 'history',
      cursor: 'abc'
    })
    const read = calls.find((c) => c.method === 'terminal.read')?.params as Record<string, unknown>
    expect(read.cursor).toBeUndefined()
    expect(read.screen).toBeUndefined()
  })
})
