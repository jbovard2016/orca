import { describe, expect, it } from 'vitest'
import {
  APPROVAL_WINDOW_MS,
  PENDING_ACTION_TTL_MS,
  PendingActionGate,
  classifyApprovalUtterance
} from './pending-action'

function gateAt(start = 1_000_000) {
  let t = start
  let n = 0
  const gate = new PendingActionGate({ now: () => t, makeId: () => `id${(n += 1)}` })
  return { gate, tick: (ms: number) => (t += ms) }
}
const target = {
  worktreeId: 'w1',
  worktreeName: 'OmniRoute',
  terminalHandle: 'h1',
  incarnationId: 'i1',
  agentIdentity: 'claude'
}
const create = (gate: PendingActionGate) =>
  gate.create({
    kind: 'send_agent',
    args: { text: 'run the tests' },
    target,
    readBack: 'Send "run the tests" to OmniRoute?'
  })

describe('classifyApprovalUtterance', () => {
  it('recognises yes/no/unclear', () => {
    expect(classifyApprovalUtterance('yes')).toBe('approved')
    expect(classifyApprovalUtterance('go ahead')).toBe('approved')
    expect(classifyApprovalUtterance('no, cancel that')).toBe('rejected')
    expect(classifyApprovalUtterance('what is running')).toBe('unclear')
    expect(classifyApprovalUtterance('yes wait no')).toBe('rejected')
  })
})

describe('PendingActionGate', () => {
  it('a forged execution with no approval is refused', () => {
    const { gate } = gateAt()
    const a = create(gate)
    expect(gate.take(a.id)).toBeNull()
  })

  it('a yes before the read-back finished is ignored', () => {
    const { gate } = gateAt()
    const a = create(gate)
    expect(gate.onUserUtterance('yes')).toBe('ignored')
    expect(gate.take(a.id)).toBeNull()
  })

  it('approves on a yes after read-back, and consumes once', () => {
    const { gate, tick } = gateAt()
    const a = create(gate)
    gate.markReadBackDone()
    tick(500)
    expect(gate.onUserUtterance('yes, do it')).toBe('approved')
    expect(gate.verifyTarget(target)).toBe(true)
    expect(gate.take(a.id)?.args).toEqual({ text: 'run the tests' })
    expect(gate.take(a.id)).toBeNull() // replay
  })

  it('tap approval works without a transcript', () => {
    const { gate } = gateAt()
    const a = create(gate)
    expect(gate.approveByTap()).toBe(true)
    expect(gate.take(a.id)).not.toBeNull()
  })

  it('a yes after the approval window is ignored and invalidates', () => {
    const { gate, tick } = gateAt()
    const a = create(gate)
    gate.markReadBackDone()
    tick(APPROVAL_WINDOW_MS + 1)
    expect(gate.onUserUtterance('yes')).toBe('ignored')
    expect(gate.take(a.id)).toBeNull()
    expect(gate.current()?.invalidatedReason).toBe('approval_window_elapsed')
  })

  it('a no declines', () => {
    const { gate } = gateAt()
    const a = create(gate)
    gate.markReadBackDone()
    expect(gate.onUserUtterance('no')).toBe('rejected')
    expect(gate.take(a.id)).toBeNull()
  })

  it('changed arguments mean a new action; the old id can never execute', () => {
    const { gate } = gateAt()
    const old = create(gate)
    gate.markReadBackDone()
    const fresh = gate.create({
      kind: 'send_agent',
      args: { text: 'deploy' },
      target,
      readBack: 'Send "deploy"?'
    })
    gate.markReadBackDone()
    gate.onUserUtterance('yes')
    expect(fresh.id).not.toBe(old.id)
    expect(gate.take(old.id)).toBeNull()
    expect(gate.take(fresh.id)?.args).toEqual({ text: 'deploy' })
  })

  it('frozen args cannot be mutated', () => {
    const { gate } = gateAt()
    const a = create(gate)
    expect(() => {
      ;(a.args as Record<string, unknown>).text = 'rm -rf'
    }).toThrow()
  })

  it('a replaced terminal (new incarnation) invalidates the approval', () => {
    const { gate } = gateAt()
    const a = create(gate)
    gate.markReadBackDone()
    gate.onUserUtterance('yes')
    expect(gate.verifyTarget({ ...target, incarnationId: 'i2' })).toBe(false)
    expect(gate.take(a.id)).toBeNull()
    expect(gate.current()?.invalidatedReason).toBe('target_changed')
  })

  it('a missing terminal invalidates the approval', () => {
    const { gate } = gateAt()
    const a = create(gate)
    gate.approveByTap()
    expect(gate.verifyTarget(null)).toBe(false)
    expect(gate.take(a.id)).toBeNull()
  })

  it('an action expires after its TTL', () => {
    const { gate, tick } = gateAt()
    create(gate)
    tick(PENDING_ACTION_TTL_MS + 1)
    expect(gate.approveByTap()).toBe(false)
    expect(gate.current()?.invalidatedReason).toBe('expired')
  })
})
