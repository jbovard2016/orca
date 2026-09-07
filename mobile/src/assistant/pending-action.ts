// Executor-owned confirmation gate for mutating voice tools.
//
// The model never approves anything. A mutating tool call only *creates* a
// pending action here, with immutable arguments and the resolved target frozen
// in. The gate is opened by the user's own transcribed words arriving after the
// assistant finished reading the action back, or by a tap on screen. Approval
// is consumed once. Any change in the target's identity invalidates the action.
// (Codex adversarial review 2026-09-07, findings 1 and 2.)

export type FrozenTarget = {
  worktreeId: string
  worktreeName: string
  terminalHandle?: string
  terminalTitle?: string
  incarnationId?: string
  agentIdentity?: string
}

export type PendingActionKind = 'send_agent' | 'activate_agent' | 'create_agent'

export type PendingAction<TArgs = Record<string, unknown>> = {
  id: string
  kind: PendingActionKind
  args: Readonly<TArgs>
  target: Readonly<FrozenTarget>
  readBack: string
  createdAt: number
  readBackDoneAt: number | null
  approvedAt: number | null
  consumedAt: number | null
  invalidatedReason: string | null
}

export const APPROVAL_WINDOW_MS = 20_000
export const PENDING_ACTION_TTL_MS = 120_000

const AFFIRMATIVE =
  /\b(yes|yeah|yep|yup|confirm|confirmed|go ahead|do it|send it|proceed|okay do it|ok do it|approve|approved)\b/i
const NEGATIVE = /\b(no|nope|cancel|stop|don't|do not|never mind|nevermind|wait)\b/i

export type ApprovalVerdict = 'approved' | 'rejected' | 'unclear'

export function classifyApprovalUtterance(text: string): ApprovalVerdict {
  const t = text.trim()
  if (!t) {
    return 'unclear'
  }
  if (NEGATIVE.test(t)) {
    return 'rejected'
  }
  if (AFFIRMATIVE.test(t)) {
    return 'approved'
  }
  return 'unclear'
}

function sameTarget(a: FrozenTarget, b: FrozenTarget): boolean {
  return (
    a.worktreeId === b.worktreeId &&
    a.terminalHandle === b.terminalHandle &&
    a.incarnationId === b.incarnationId &&
    a.agentIdentity === b.agentIdentity
  )
}

export type PendingActionGateOptions = {
  now?: () => number
  makeId?: () => string
}

export class PendingActionGate {
  private pending: PendingAction | null = null
  private readonly now: () => number
  private readonly makeId: () => string

  constructor(options: PendingActionGateOptions = {}) {
    this.now = options.now ?? (() => Date.now())
    this.makeId =
      options.makeId ??
      (() => `act-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`)
  }

  /**
   * Replaces any earlier pending action: one thing awaits approval at a time.
   * Exception: if the same kind, target and args are already approved but not
   * yet executed (the model re-called the tool after hearing "yes"), return the
   * approved action instead of starting a new read-back loop.
   */
  create<TArgs>(input: {
    kind: PendingActionKind
    args: TArgs
    target: FrozenTarget
    readBack: string
  }): PendingAction<TArgs> {
    const existing = this.current()
    if (
      existing &&
      existing.approvedAt &&
      !existing.consumedAt &&
      !existing.invalidatedReason &&
      existing.kind === input.kind &&
      sameTarget(existing.target, input.target) &&
      JSON.stringify(existing.args) === JSON.stringify(input.args)
    ) {
      return existing as PendingAction<TArgs>
    }
    const action: PendingAction<TArgs> = {
      id: this.makeId(),
      kind: input.kind,
      args: Object.freeze({ ...input.args }),
      target: Object.freeze({ ...input.target }),
      readBack: input.readBack,
      createdAt: this.now(),
      readBackDoneAt: null,
      approvedAt: null,
      consumedAt: null,
      invalidatedReason: null
    }
    this.pending = action as PendingAction
    return action
  }

  current(): PendingAction | null {
    const p = this.pending
    if (!p) {
      return null
    }
    if (p.invalidatedReason || p.consumedAt) {
      return p
    }
    if (this.now() - p.createdAt > PENDING_ACTION_TTL_MS) {
      p.invalidatedReason = 'expired'
    }
    return p
  }

  /** Called when the assistant's spoken read-back finished (output transcript done). */
  markReadBackDone(): void {
    const p = this.current()
    if (p && !p.invalidatedReason && !p.consumedAt && p.readBackDoneAt === null) {
      p.readBackDoneAt = this.now()
    }
  }

  /**
   * Feed the user's transcribed utterance. Only an affirmative that arrives after
   * the read-back finished and inside the approval window opens the gate.
   */
  onUserUtterance(text: string): ApprovalVerdict | 'ignored' {
    const p = this.current()
    if (!p || p.invalidatedReason || p.consumedAt || p.approvedAt) {
      return 'ignored'
    }
    const verdict = classifyApprovalUtterance(text)
    if (verdict === 'rejected') {
      p.invalidatedReason = 'user_declined'
      return 'rejected'
    }
    if (verdict !== 'approved') {
      return 'unclear'
    }
    if (p.readBackDoneAt === null) {
      // A "yes" before the read-back finished cannot be approval of this action.
      return 'ignored'
    }
    if (this.now() - p.readBackDoneAt > APPROVAL_WINDOW_MS) {
      p.invalidatedReason = 'approval_window_elapsed'
      return 'ignored'
    }
    p.approvedAt = this.now()
    return 'approved'
  }

  /** Tap-to-confirm: the screen button. Same gate, no transcript needed. */
  approveByTap(): boolean {
    const p = this.current()
    if (!p || p.invalidatedReason || p.consumedAt || p.approvedAt) {
      return false
    }
    p.approvedAt = this.now()
    return true
  }

  /**
   * Re-check the live target against the frozen one. Any difference invalidates.
   * `live` is what terminal.list / worktree.ps report right now.
   */
  verifyTarget(
    live: {
      worktreeId?: string
      terminalHandle?: string
      incarnationId?: string
      agentIdentity?: string
    } | null
  ): boolean {
    const p = this.current()
    if (!p || p.invalidatedReason) {
      return false
    }
    if (!live) {
      p.invalidatedReason = 'target_missing'
      return false
    }
    const t = p.target
    const same =
      live.worktreeId === t.worktreeId &&
      (t.terminalHandle === undefined || live.terminalHandle === t.terminalHandle) &&
      (t.incarnationId === undefined || live.incarnationId === t.incarnationId) &&
      (t.agentIdentity === undefined || live.agentIdentity === t.agentIdentity)
    if (!same) {
      p.invalidatedReason = 'target_changed'
      return false
    }
    return true
  }

  /** Consume the approval exactly once. Returns the action to execute, or null. */
  take(id: string): PendingAction | null {
    const p = this.current()
    if (!p || p.id !== id || p.invalidatedReason || p.consumedAt || !p.approvedAt) {
      return null
    }
    p.consumedAt = this.now()
    return p
  }

  clear(): void {
    this.pending = null
  }
}
