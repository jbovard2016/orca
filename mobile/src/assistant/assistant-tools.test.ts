import { describe, expect, it } from 'vitest'
import { PendingActionGate } from './pending-action'
import { executeApproved, executeTool, spokenTrim } from './assistant-tools'
import type { RpcResponse } from '../transport/types'

type Call = { method: string; params: unknown }

function fakeClient(state: {
  worktrees: unknown[]
  terminals: Record<string, unknown[]>
  repos?: unknown[]
  read?: unknown
  sendReceipt?: unknown
}) {
  const calls: Call[] = []
  const ok = (result: unknown): RpcResponse => ({
    id: 'x',
    ok: true,
    result,
    _meta: { runtimeId: 'r' }
  })
  const client = {
    sendRequest: async (method: string, params?: unknown): Promise<RpcResponse> => {
      calls.push({ method, params })
      switch (method) {
        case 'worktree.ps':
          return ok({ worktrees: state.worktrees })
        case 'terminal.list': {
          const sel = String((params as { worktree: string }).worktree).replace(/^id:/, '')
          return ok({ terminals: state.terminals[sel] ?? [] })
        }
        case 'repo.list':
          return ok({ repos: state.repos ?? [] })
        case 'terminal.read':
          return ok(state.read ?? { status: 'running', tail: ['hello'], nextCursor: null })
        case 'terminal.wait':
          return ok({ wait: { condition: 'tui-idle', satisfied: true } })
        case 'terminal.send':
          return ok(state.sendReceipt ?? { accepted: true })
        case 'worktree.activate':
          return ok({ activated: true })
        case 'terminal.focus':
          return ok({ focus: true })
        case 'worktree.create':
          return ok({ worktree: { id: 'new-id', displayName: (params as { name: string }).name } })
        default:
          return {
            id: 'x',
            ok: false,
            error: { code: 'nope', message: `unexpected ${method}` },
            _meta: { runtimeId: 'r' }
          }
      }
    }
  }
  return { client, calls }
}

const ESC = '\u001b'

const worktrees = [
  {
    worktreeId: 'w1',
    displayName: 'OmniRoute',
    repo: 'OmniRoute',
    branch: 'refs/heads/release/v3.8.51',
    agents: [
      {
        paneKey: 'p',
        state: 'working',
        agentType: 'claude',
        lastAssistantMessage: 'Running tests now'
      }
    ]
  },
  {
    worktreeId: 'w2',
    displayName: 'codex-sinns',
    repo: 'sinns-beach-club',
    branch: 'refs/heads/codex-sinns',
    agents: [{ paneKey: 'q', state: 'waiting', agentType: 'codex' }]
  },
  {
    worktreeId: 'w3',
    displayName: 'idle-shell',
    repo: 'misc',
    branch: 'refs/heads/main',
    agents: []
  }
]
const terminals = {
  w1: [
    {
      handle: 'h1',
      title: 'Orca voice agent integration',
      worktreeId: 'w1',
      incarnationId: 'i1',
      agentIdentity: 'claude',
      connected: true
    },
    { handle: 'h2', title: 'Terminal 1', worktreeId: 'w1', incarnationId: 'i2', connected: true }
  ],
  w2: [
    {
      handle: 'h3',
      title: 'codex',
      worktreeId: 'w2',
      incarnationId: 'i3',
      agentIdentity: 'codex',
      connected: true
    }
  ],
  w3: [{ handle: 'h4', title: 'shell', worktreeId: 'w3', incarnationId: 'i4', connected: true }]
}

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
