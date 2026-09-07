import { describe, expect, it } from 'vitest'
import { PendingActionGate } from './pending-action'
import { executeApproved, executeTool } from './assistant-tools'
import { fakeClient, terminals, worktrees } from './test-fixtures'

describe('send_agent', () => {
  it('stages, never sends, until approved; then waits for idle and sends', async () => {
    const { client, calls } = fakeClient({ worktrees, terminals })
    const gate = new PendingActionGate()
    const ctx = { client, gate }
    const staged = await executeTool(ctx, 'send_agent', {
      target: 'omniroute',
      text: 'run the tests'
    })
    expect(staged.status).toBe('needs_confirmation')
    expect(staged.readBack).toContain('run the tests')
    expect(calls.some((c) => c.method === 'terminal.send')).toBe(false)

    // Forged execution without approval
    expect((await executeApproved(ctx, staged.actionId as string)).error).toBe('not_approved')

    gate.markReadBackDone()
    expect(gate.onUserUtterance('yes')).toBe('approved')
    const done = await executeApproved(ctx, staged.actionId as string)
    expect(done.status).toBe('sent')
    const idx = calls.findIndex((c) => c.method === 'terminal.wait')
    expect(idx).toBeGreaterThan(-1)
    expect(calls[idx + 1].method).toBe('terminal.send')
    expect(calls[idx + 1].params).toEqual({ terminal: 'h1', text: 'run the tests', enter: true })
    // Replay
    expect((await executeApproved(ctx, staged.actionId as string)).error).toBe('already_executed')
  })

  it('refuses a plain shell even when named', async () => {
    const { client } = fakeClient({ worktrees, terminals })
    const r = await executeTool({ client, gate: new PendingActionGate() }, 'send_agent', {
      target: 'omniroute',
      terminal: 'terminal 1',
      text: 'ls'
    })
    expect(r.error).toBe('not_an_agent_terminal')
  })

  it('refuses to execute when the terminal was replaced after approval', async () => {
    const state = { worktrees, terminals: { ...terminals } }
    const { client } = fakeClient(state)
    const gate = new PendingActionGate()
    const ctx = { client, gate }
    const staged = await executeTool(ctx, 'send_agent', { target: 'sinns', text: 'continue' })
    gate.markReadBackDone()
    gate.onUserUtterance('yes')
    state.terminals.w2 = [{ ...terminals.w2[0], incarnationId: 'i99' }]
    const r = await executeApproved(ctx, staged.actionId as string)
    expect(r.error).toBe('target_changed')
  })

  it('reports a locked-input receipt as rejected, not sent', async () => {
    const { client } = fakeClient({
      worktrees,
      terminals,
      sendReceipt: { accepted: false, reason: 'locked' }
    })
    const gate = new PendingActionGate()
    const ctx = { client, gate }
    const staged = await executeTool(ctx, 'send_agent', { target: 'sinns', text: 'continue' })
    gate.approveByTap()
    const r = await executeApproved(ctx, staged.actionId as string)
    expect(r.status).toBe('rejected')
  })
})

describe('activate_agent and create_agent', () => {
  it('activates a worktree and focuses its agent terminal after approval', async () => {
    const { client, calls } = fakeClient({ worktrees, terminals })
    const gate = new PendingActionGate()
    const ctx = { client, gate }
    const staged = await executeTool(ctx, 'activate_agent', { target: 'sinns' })
    expect(staged.status).toBe('needs_confirmation')
    gate.approveByTap()
    const r = await executeApproved(ctx, staged.actionId as string)
    expect(r.status).toBe('activated')
    expect(calls.map((c) => c.method)).toContain('worktree.activate')
    expect(calls.map((c) => c.method)).toContain('terminal.focus')
  })

  it('creates a worktree with the agent and prompt after approval, with an idempotency key', async () => {
    const { client, calls } = fakeClient({
      worktrees,
      terminals,
      repos: [
        { id: 'r1', displayName: 'OmniRoute', path: 'C:\\Users\\jonbo\\Projects\\OmniRoute' },
        { id: 'r2', displayName: 'truemarket', path: '/home/x/truemarket' }
      ]
    })
    const gate = new PendingActionGate()
    const ctx = { client, gate }
    const staged = await executeTool(ctx, 'create_agent', {
      repo: 'omniroute',
      name: 'voice-test',
      agent: 'claude',
      prompt: 'say hello'
    })
    expect(staged.status).toBe('needs_confirmation')
    expect(staged.readBack).toContain('voice-test')
    gate.approveByTap()
    const r = await executeApproved(ctx, staged.actionId as string)
    expect(r.status).toBe('created')
    const create = calls.find((c) => c.method === 'worktree.create')?.params as Record<
      string,
      unknown
    >
    expect(create.repo).toBe('id:r1')
    expect(create.startupAgent).toBe('claude')
    expect(create.startupPrompt).toBe('say hello')
    expect(String(create.clientMutationId)).toMatch(/^voice-/)
  })

  it('refuses an unknown repo', async () => {
    const { client } = fakeClient({
      worktrees,
      terminals,
      repos: [{ id: 'r1', displayName: 'OmniRoute', path: '/x/OmniRoute' }]
    })
    const r = await executeTool({ client, gate: new PendingActionGate() }, 'create_agent', {
      repo: 'nope',
      name: 'x',
      agent: 'claude',
      prompt: 'y'
    })
    expect(r.error).toBe('no_such_repo')
  })
})

describe('hardening from review', () => {
  it('parseCursor accepts only non-negative integer strings or numbers', async () => {
    const { parseCursor } = await import('./assistant-tools')
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

  it('an approved activate is refused when the worktree vanished', async () => {
    const state = { worktrees: [...worktrees], terminals }
    const { client } = fakeClient(state)
    const gate = new PendingActionGate()
    const ctx = { client, gate }
    const staged = await executeTool(ctx, 'activate_agent', { target: 'idle-shell' })
    expect(staged.status).toBe('needs_confirmation')
    gate.approveByTap()
    state.worktrees = worktrees.filter((w) => (w as { worktreeId: string }).worktreeId !== 'w3')
    const r = await executeApproved(ctx, staged.actionId as string)
    expect(r.error).toBe('target_changed')
    expect(r.reason).toBe('target_missing')
  })

  it('re-staging the same approved action returns already_approved and keeps the approval', async () => {
    const { client, calls } = fakeClient({ worktrees, terminals })
    const gate = new PendingActionGate()
    const ctx = { client, gate }
    const first = await executeTool(ctx, 'send_agent', { target: 'sinns', text: 'continue' })
    gate.markReadBackDone()
    gate.onUserUtterance('yes')
    const again = await executeTool(ctx, 'send_agent', { target: 'sinns', text: 'continue' })
    expect(again.status).toBe('already_approved')
    expect(again.actionId).toBe(first.actionId)
    const done = await executeApproved(ctx, first.actionId as string)
    expect(done.status).toBe('sent')
    expect(calls.filter((c) => c.method === 'terminal.send').length).toBe(1)
  })

  it('re-staging with different text replaces the approved action and needs a new yes', async () => {
    const { client, calls } = fakeClient({ worktrees, terminals })
    const gate = new PendingActionGate()
    const ctx = { client, gate }
    await executeTool(ctx, 'send_agent', { target: 'sinns', text: 'continue' })
    gate.markReadBackDone()
    gate.onUserUtterance('yes')
    const other = await executeTool(ctx, 'send_agent', { target: 'sinns', text: 'deploy' })
    expect(other.status).toBe('needs_confirmation')
    const r = await executeApproved(ctx, other.actionId as string)
    expect(r.error).toBe('not_approved')
    expect(calls.some((c) => c.method === 'terminal.send')).toBe(false)
  })
})
