// Shared fake RPC client and fixtures for the assistant tests.
import type { RpcResponse } from '../transport/types'

export type Call = { method: string; params: unknown }

export function fakeClient(state: {
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
          return ok({
            terminal: state.read ?? { status: 'running', tail: ['hello'], nextCursor: null }
          })
        case 'terminal.wait':
          return ok({ wait: { condition: 'tui-idle', satisfied: true } })
        case 'terminal.send':
          return ok({ send: state.sendReceipt ?? { accepted: true } })
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

export const ESC = '\u001b'

export const worktrees = [
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
export const terminals = {
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
