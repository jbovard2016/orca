// Builders and type guards for the OpenAI Realtime WebSocket protocol, kept
// separate from the controller so the wire shapes are easy to audit. Event
// names follow the openai-node SDK `resources/realtime/realtime.ts` on master.

import { ASSISTANT_TOOLS } from './assistant-tool-schemas'

export const REALTIME_URL = 'wss://api.openai.com/v1/realtime'
export const REALTIME_PCM_RATE = 24000
export const USER_TRANSCRIPTION_MODEL = 'gpt-4o-mini-transcribe'

/** Subprotocols for an ephemeral client secret; verified against the live API on 2026-09-07. */
export function realtimeProtocols(secret: string): string[] {
  return ['realtime', `openai-insecure-api-key.${secret}`]
}

export function realtimeUrl(model: string): string {
  return `${REALTIME_URL}?model=${encodeURIComponent(model)}`
}

export function sessionUpdate(handsFree: boolean): string {
  const pcm = { type: 'audio/pcm', rate: REALTIME_PCM_RATE }
  return JSON.stringify({
    type: 'session.update',
    session: {
      type: 'realtime',
      output_modalities: ['audio'],
      tools: ASSISTANT_TOOLS,
      tool_choice: 'auto',
      audio: {
        input: {
          format: pcm,
          transcription: { model: USER_TRANSCRIPTION_MODEL },
          turn_detection: handsFree
            ? { type: 'server_vad', create_response: true, interrupt_response: true }
            : null
        },
        output: { format: pcm }
      }
    }
  })
}

export function audioAppend(base64: string): string {
  return JSON.stringify({ type: 'input_audio_buffer.append', audio: base64 })
}

export function audioCommit(): string {
  return JSON.stringify({ type: 'input_audio_buffer.commit' })
}

export function responseCreate(): string {
  return JSON.stringify({ type: 'response.create' })
}

export function responseCancel(): string {
  return JSON.stringify({ type: 'response.cancel' })
}

export function functionCallOutput(callId: string, output: unknown): string {
  return JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'function_call_output', call_id: callId, output: JSON.stringify(output) }
  })
}

/** A note the assistant should read and act on, injected as a user message. */
export function userNote(text: string): string {
  return JSON.stringify({
    type: 'conversation.item.create',
    item: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] }
  })
}

export type ServerEvent = { type: string } & Record<string, unknown>

export function parseServerEvent(data: unknown): ServerEvent | null {
  if (typeof data !== 'string') {
    return null
  }
  try {
    const parsed = JSON.parse(data) as unknown
    if (
      parsed &&
      typeof parsed === 'object' &&
      typeof (parsed as { type?: unknown }).type === 'string'
    ) {
      return parsed as ServerEvent
    }
  } catch {
    // ignore malformed frames
  }
  return null
}

export type FunctionCallDone = { call_id: string; name: string; arguments: string }

export function asFunctionCallDone(event: ServerEvent): FunctionCallDone | null {
  if (event.type !== 'response.function_call_arguments.done') {
    return null
  }
  const callId = event.call_id
  const name = event.name
  const args = event.arguments
  if (typeof callId !== 'string' || typeof name !== 'string' || typeof args !== 'string') {
    return null
  }
  return { call_id: callId, name, arguments: args }
}

export function parseFunctionArguments(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown
  } catch {
    return {}
  }
}
