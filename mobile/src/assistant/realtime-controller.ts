// The Assistant session: one Realtime WebSocket, one audio path, one tool
// executor, one confirmation gate. Framework-free so it can be driven by a
// fake socket and fake audio in tests; the React hook only wires devices in.

import { PendingActionGate } from './pending-action'
import { executeApproved, executeTool, type ToolClient } from './assistant-tools'
import { micBytesToRealtimeBytes, realtimeBytesToPlaybackBytes } from './pcm-resample'
import {
  asFunctionCallDone,
  audioAppend,
  audioCommit,
  functionCallOutput,
  parseFunctionArguments,
  parseServerEvent,
  realtimeProtocols,
  realtimeUrl,
  responseCancel,
  responseCreate,
  sessionUpdate,
  userNote
} from './realtime-messages'

export type SessionState =
  | 'idle'
  | 'minting'
  | 'connecting'
  | 'listening'
  | 'responding'
  | 'awaiting_confirmation'
  | 'executing'
  | 'error'
  | 'closed'

export type SocketLike = {
  send: (data: string) => void
  close: () => void
  onopen: ((ev: unknown) => void) | null
  onmessage: ((ev: { data: unknown }) => void) | null
  onerror: ((ev: unknown) => void) | null
  onclose: ((ev: { code?: number; reason?: string }) => void) | null
}

export type AudioLike = {
  /** Start capturing; chunks arrive through the callback given to the controller. */
  startCapture: () => Promise<boolean>
  stopCapture: () => void
  play: (pcm16At16k: Uint8Array) => void
  stopPlayback: () => void
}

export type TranscriptEntry = { role: 'user' | 'assistant' | 'system'; text: string; at: number }

export type ControllerDeps = {
  client: ToolClient
  audio: AudioLike
  mint: () => Promise<{ value: string; model: string }>
  createSocket: (url: string, protocols: string[]) => SocketLike
  handsFree: boolean
  now?: () => number
  toBase64: (bytes: Uint8Array) => string
  fromBase64: (base64: string) => Uint8Array
  onState?: (state: SessionState, detail?: string) => void
  onTranscript?: (entry: TranscriptEntry) => void
  idleTimeoutMs?: number
}

export const DEFAULT_IDLE_TIMEOUT_MS = 3 * 60_000

export class RealtimeController {
  readonly gate = new PendingActionGate()
  state: SessionState = 'idle'
  private socket: SocketLike | null = null
  private responseInFlight = false
  private readBackPending = false
  private awaitingActionId: string | null = null
  private assistantTranscript = ''
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUs = false

  constructor(private readonly deps: ControllerDeps) {}

  private setState(state: SessionState, detail?: string): void {
    this.state = state
    this.deps.onState?.(state, detail)
  }

  private note(role: TranscriptEntry['role'], text: string): void {
    this.deps.onTranscript?.({ role, text, at: (this.deps.now ?? Date.now)() })
  }

  private send(frame: string): void {
    this.socket?.send(frame)
  }

  private touchIdle(): void {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer)
    }
    this.idleTimer = setTimeout(
      () => this.stop('idle timeout'),
      this.deps.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS
    )
  }

  async start(): Promise<void> {
    if (this.state !== 'idle' && this.state !== 'closed' && this.state !== 'error') {
      return
    }
    this.closedByUs = false
    this.setState('minting')
    let secret: { value: string; model: string }
    try {
      secret = await this.deps.mint()
    } catch (err) {
      this.setState('error', err instanceof Error ? err.message : 'mint failed')
      return
    }
    this.setState('connecting')
    const socket = this.deps.createSocket(
      realtimeUrl(secret.model),
      realtimeProtocols(secret.value)
    )
    this.socket = socket
    socket.onopen = () => {
      this.send(sessionUpdate(this.deps.handsFree))
    }
    socket.onmessage = (ev) => {
      const event = parseServerEvent(ev.data)
      if (event) {
        void this.handleEvent(event)
      }
    }
    socket.onerror = () => {
      if (this.state !== 'closed') {
        this.setState('error', 'socket error')
      }
    }
    socket.onclose = (ev) => {
      this.deps.audio.stopCapture()
      this.deps.audio.stopPlayback()
      if (this.idleTimer) {
        clearTimeout(this.idleTimer)
      }
      if (this.state !== 'error') {
        this.setState(
          'closed',
          this.closedByUs ? undefined : `closed ${ev.code ?? ''} ${ev.reason ?? ''}`.trim()
        )
      }
      this.socket = null
    }
  }

  stop(reason?: string): void {
    this.closedByUs = true
    this.gate.clear()
    this.deps.audio.stopCapture()
    this.deps.audio.stopPlayback()
    if (reason) {
      this.note('system', reason)
    }
    this.socket?.close()
  }

  /** Microphone bytes from the audio module: PCM16 mono 16 kHz. */
  onMicChunk(bytes: Uint8Array): void {
    if (
      !this.socket ||
      (this.state !== 'listening' &&
        this.state !== 'responding' &&
        this.state !== 'awaiting_confirmation')
    ) {
      return
    }
    this.send(audioAppend(this.deps.toBase64(micBytesToRealtimeBytes(bytes))))
  }

  /** Push-to-talk release: commit the buffer and ask for a response. */
  endUtterance(): void {
    if (this.deps.handsFree || !this.socket) {
      return
    }
    this.send(audioCommit())
    this.send(responseCreate())
  }

  /** Tap-to-confirm from the screen. */
  async approveByTap(): Promise<void> {
    if (this.gate.approveByTap()) {
      await this.runApproved()
    }
  }

  private async handleEvent(event: Record<string, unknown> & { type: string }): Promise<void> {
    switch (event.type) {
      case 'session.created':
      case 'session.updated': {
        if (this.state === 'connecting') {
          const ok = await this.deps.audio.startCapture()
          if (!ok) {
            this.setState('error', 'microphone unavailable')
            this.socket?.close()
            return
          }
          this.setState('listening')
          this.touchIdle()
        }
        return
      }
      case 'input_audio_buffer.speech_started': {
        this.touchIdle()
        this.deps.audio.stopPlayback()
        if (this.responseInFlight) {
          this.send(responseCancel())
        }
        return
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const transcript = typeof event.transcript === 'string' ? event.transcript.trim() : ''
        if (transcript) {
          this.note('user', transcript)
          if (this.gate.onUserUtterance(transcript) === 'approved') {
            await this.runApproved()
          }
        }
        return
      }
      case 'response.created': {
        this.responseInFlight = true
        this.assistantTranscript = ''
        if (this.state === 'listening') {
          this.setState('responding')
        }
        return
      }
      case 'response.output_audio.delta': {
        if (typeof event.delta === 'string') {
          this.deps.audio.play(realtimeBytesToPlaybackBytes(this.deps.fromBase64(event.delta)))
        }
        return
      }
      case 'response.output_audio_transcript.delta': {
        if (typeof event.delta === 'string') {
          this.assistantTranscript += event.delta
        }
        return
      }
      case 'response.output_audio_transcript.done': {
        const text =
          typeof event.transcript === 'string' ? event.transcript : this.assistantTranscript
        if (text.trim()) {
          this.note('assistant', text.trim())
        }
        if (this.readBackPending) {
          this.readBackPending = false
          this.gate.markReadBackDone()
        }
        return
      }
      case 'response.done': {
        this.responseInFlight = false
        if (this.state === 'responding') {
          this.setState(this.awaitingActionId ? 'awaiting_confirmation' : 'listening')
        }
        this.touchIdle()
        return
      }
      case 'response.function_call_arguments.done': {
        const call = asFunctionCallDone(event)
        if (call) {
          await this.handleToolCall(call.call_id, call.name, parseFunctionArguments(call.arguments))
        }
        return
      }
      case 'error': {
        const message =
          (event.error as { message?: string } | undefined)?.message ?? 'realtime error'
        this.note('system', message)
        return
      }
      default:
        return
    }
  }

  private async handleToolCall(callId: string, name: string, args: unknown): Promise<void> {
    const result = await executeTool({ client: this.deps.client, gate: this.gate }, name, args)
    if (result.status === 'needs_confirmation' && typeof result.actionId === 'string') {
      this.awaitingActionId = result.actionId
      this.readBackPending = true
      this.setState('awaiting_confirmation')
    }
    this.send(functionCallOutput(callId, result))
    this.send(responseCreate())
  }

  private async runApproved(): Promise<void> {
    const actionId = this.awaitingActionId ?? this.gate.current()?.id ?? null
    if (!actionId) {
      return
    }
    this.setState('executing')
    const receipt = await executeApproved({ client: this.deps.client, gate: this.gate }, actionId)
    this.awaitingActionId = null
    this.note('system', `Orca receipt: ${JSON.stringify(receipt)}`)
    this.send(
      userNote(
        `[Orca receipt] ${JSON.stringify(receipt)}. Tell the user the outcome in one sentence.`
      )
    )
    this.send(responseCreate())
    this.setState('listening')
  }
}
