import { describe, expect, it } from 'vitest'
import { Buffer } from 'buffer'
import {
  RealtimeController,
  type AudioLike,
  type SessionState,
  type SocketLike
} from './realtime-controller'
import { fakeClient, terminals, worktrees } from './test-fixtures'

class FakeSocket implements SocketLike {
  sent: string[] = []
  closed = false
  onopen: SocketLike['onopen'] = null
  onmessage: SocketLike['onmessage'] = null
  onerror: SocketLike['onerror'] = null
  onclose: SocketLike['onclose'] = null
  constructor(
    readonly url: string,
    readonly protocols: string[]
  ) {}
  send(data: string): void {
    this.sent.push(data)
  }
  close(): void {
    this.closed = true
    this.onclose?.({ code: 1000, reason: '' })
  }
  open(): void {
    this.onopen?.({})
  }
  emit(event: Record<string, unknown>): void {
    this.onmessage?.({ data: JSON.stringify(event) })
  }
  frames(): Array<Record<string, unknown>> {
    return this.sent.map((s) => JSON.parse(s) as Record<string, unknown>)
  }
  types(): string[] {
    return this.frames().map((f) => String(f.type))
  }
}

function fakeAudio() {
  const log: string[] = []
  const played: Uint8Array[] = []
  const audio: AudioLike = {
    startCapture: async () => {
      log.push('start')
      return true
    },
    stopCapture: () => log.push('stopCapture'),
    play: (b) => {
      played.push(b)
      log.push('play')
    },
    stopPlayback: () => log.push('stopPlayback')
  }
  return { audio, log, played }
}

async function flush(): Promise<void> {
  await new Promise((r) => setTimeout(r, 0))
  await new Promise((r) => setTimeout(r, 0))
}

function setup(opts: { handsFree?: boolean } = {}) {
  const { client } = fakeClient({ worktrees, terminals })
  const { audio, log, played } = fakeAudio()
  let socket: FakeSocket | null = null
  const states: SessionState[] = []
  const transcript: string[] = []
  const controller = new RealtimeController({
    client,
    audio,
    mint: async () => ({ value: 'ek_test', model: 'gpt-realtime-2.1' }),
    createSocket: (url, protocols) => {
      socket = new FakeSocket(url, protocols)
      return socket
    },
    handsFree: opts.handsFree ?? true,
    toBase64: (b) => Buffer.from(b).toString('base64'),
    fromBase64: (s) => new Uint8Array(Buffer.from(s, 'base64')),
    onState: (s) => states.push(s),
    onTranscript: (e) => transcript.push(`${e.role}: ${e.text}`),
    idleTimeoutMs: 60_000
  })
  const ready = async () => {
    await controller.start()
    const s = socket as FakeSocket | null
    if (!s) {
      throw new Error('no socket')
    }
    s.open()
    s.emit({ type: 'session.created' })
    await flush()
    return s
  }
  return {
    controller,
    ready,
    getSocket: () => socket as FakeSocket | null,
    log,
    played,
    states,
    transcript
  }
}

describe('RealtimeController', () => {
  it('mints, connects with the ephemeral subprotocol, configures the session, then listens', async () => {
    const t = setup()
    const s = await t.ready()
    expect(s.url).toContain('model=gpt-realtime-2.1')
    expect(s.protocols).toEqual(['realtime', 'openai-insecure-api-key.ek_test'])
    const update = s.frames()[0] as { type: string; session: Record<string, unknown> }
    expect(update.type).toBe('session.update')
    expect((update.session.tools as unknown[]).length).toBe(5)
    expect(t.states).toEqual(['minting', 'connecting', 'listening'])
    expect(t.log).toContain('start')
  })

  it('reports a mint failure without opening a socket', async () => {
    const t = setup()
    const controller = new RealtimeController({
      client: fakeClient({ worktrees, terminals }).client,
      audio: fakeAudio().audio,
      mint: async () => {
        throw new Error('Voice mint rejected the device token')
      },
      createSocket: () => {
        throw new Error('should not connect')
      },
      handsFree: true,
      toBase64: () => '',
      fromBase64: () => new Uint8Array(),
      onState: (s) => t.states.push(s)
    })
    await controller.start()
    expect(controller.state).toBe('error')
  })

  it('forwards mic chunks as 24 kHz base64 appends', async () => {
    const t = setup()
    const s = await t.ready()
    const chunk = new Uint8Array(320) // 10 ms at 16 kHz
    t.controller.onMicChunk(chunk)
    const append = s.frames().find((f) => f.type === 'input_audio_buffer.append') as {
      audio: string
    }
    expect(append).toBeTruthy()
    expect(Buffer.from(append.audio, 'base64').length).toBe(480) // 10 ms at 24 kHz
  })

  it('plays output audio deltas resampled to 16 kHz', async () => {
    const t = setup()
    const s = await t.ready()
    s.emit({ type: 'response.created' })
    const delta = Buffer.from(new Uint8Array(480)).toString('base64')
    s.emit({ type: 'response.output_audio.delta', delta })
    expect(t.played.length).toBe(1)
    expect(t.played[0].length).toBe(320)
  })

  it('on barge-in it stops playback and cancels the in-flight response', async () => {
    const t = setup()
    const s = await t.ready()
    s.emit({ type: 'response.created' })
    s.emit({ type: 'input_audio_buffer.speech_started' })
    expect(t.log).toContain('stopPlayback')
    expect(s.types()).toContain('response.cancel')
  })

  it('runs a read-only tool call and returns its output, then asks for a response', async () => {
    const t = setup()
    const s = await t.ready()
    s.emit({
      type: 'response.function_call_arguments.done',
      call_id: 'c1',
      name: 'list_agents',
      arguments: '{}'
    })
    await flush()
    const out = s.frames().find((f) => f.type === 'conversation.item.create') as {
      item: { type: string; call_id: string; output: string }
    }
    expect(out.item.type).toBe('function_call_output')
    expect(out.item.call_id).toBe('c1')
    expect((JSON.parse(out.item.output) as { count: number }).count).toBe(2)
    expect(s.types().at(-1)).toBe('response.create')
  })

  it('full confirmation loop: stage, read back, user says yes, execute, receipt injected', async () => {
    const t = setup()
    const s = await t.ready()
    s.emit({
      type: 'response.function_call_arguments.done',
      call_id: 'c2',
      name: 'send_agent',
      arguments: JSON.stringify({ target: 'sinns', text: 'continue' })
    })
    await flush()
    expect(t.controller.state).toBe('awaiting_confirmation')
    // A premature "yes" before the read-back finished must not execute.
    s.emit({ type: 'conversation.item.input_audio_transcription.completed', transcript: 'yes' })
    await flush()
    expect(s.types()).not.toContain('conversation.item.create.user')
    expect(t.transcript.some((l) => l.startsWith('system: Orca receipt'))).toBe(false)
    // Assistant finishes reading back.
    s.emit({
      type: 'response.output_audio_transcript.done',
      transcript: 'Send "continue" to codex in codex-sinns?'
    })
    s.emit({ type: 'response.done' })
    expect(t.controller.state).toBe('awaiting_confirmation')
    // Now the user's own transcript approves.
    s.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'yes go ahead'
    })
    await flush()
    const receipt = t.transcript.find((l) => l.startsWith('system: Orca receipt'))
    expect(receipt).toContain('"status":"sent"')
    const note = s.frames().findLast((f) => f.type === 'conversation.item.create') as {
      item: { type: string; role: string }
    }
    expect(note.item.type).toBe('message')
    expect(note.item.role).toBe('user')
    expect(t.controller.state).toBe('listening')
  })

  it('a spoken no declines and nothing is sent', async () => {
    const t = setup()
    const s = await t.ready()
    s.emit({
      type: 'response.function_call_arguments.done',
      call_id: 'c3',
      name: 'send_agent',
      arguments: JSON.stringify({ target: 'sinns', text: 'continue' })
    })
    await flush()
    s.emit({ type: 'response.output_audio_transcript.done', transcript: 'Send "continue"?' })
    s.emit({
      type: 'conversation.item.input_audio_transcription.completed',
      transcript: 'no, cancel'
    })
    await flush()
    expect(t.transcript.some((l) => l.startsWith('system: Orca receipt'))).toBe(false)
    expect(t.controller.gate.current()?.invalidatedReason).toBe('user_declined')
  })

  it('tap approval executes without a transcript', async () => {
    const t = setup()
    const s = await t.ready()
    s.emit({
      type: 'response.function_call_arguments.done',
      call_id: 'c4',
      name: 'activate_agent',
      arguments: JSON.stringify({ target: 'sinns' })
    })
    await flush()
    await t.controller.approveByTap()
    expect(t.transcript.find((l) => l.startsWith('system: Orca receipt'))).toContain(
      '"status":"activated"'
    )
  })

  it('push-to-talk commits the buffer on release; hands-free ignores it', async () => {
    const ptt = setup({ handsFree: false })
    const s1 = await ptt.ready()
    const update = s1.frames()[0] as { session: { audio: { input: { turn_detection: unknown } } } }
    expect(update.session.audio.input.turn_detection).toBeNull()
    ptt.controller.endUtterance()
    expect(s1.types().slice(-2)).toEqual(['input_audio_buffer.commit', 'response.create'])

    const hf = setup({ handsFree: true })
    const s2 = await hf.ready()
    hf.controller.endUtterance()
    expect(s2.types()).not.toContain('input_audio_buffer.commit')
  })

  it('stop closes the socket, stops audio, and clears the gate', async () => {
    const t = setup()
    const s = await t.ready()
    t.controller.stop()
    expect(s.closed).toBe(true)
    expect(t.log).toContain('stopCapture')
    expect(t.controller.state).toBe('closed')
    expect(t.controller.gate.current()).toBeNull()
  })
})
