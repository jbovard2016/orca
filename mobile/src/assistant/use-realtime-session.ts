// React binding for the Assistant session: wires the phone's audio module,
// keep-awake, settings, the mint client and the paired RpcClient into the
// framework-free RealtimeController.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Buffer } from 'buffer'
import {
  addExpoTwoWayAudioEventListener,
  initialize,
  playPCMData,
  requestMicrophonePermissionsAsync,
  stopPlayback,
  tearDown,
  toggleRecording
} from '@orca/expo-two-way-audio'
import type { RpcClient } from '../transport/rpc-client'
import { createMobileDictationKeepAwakeOwner } from '../hooks/mobile-dictation-keep-awake'
import { useMobileDictationForegroundKeepAwake } from '../hooks/mobile-dictation-foreground-keep-awake'
import { loadAssistantSettings, readAssistantMintToken } from './assistant-settings'
import { mintClientSecret } from './mint-client'
import {
  RealtimeController,
  type AudioLike,
  type SessionState,
  type SocketLike,
  type TranscriptEntry
} from './realtime-controller'

export type UseRealtimeSessionOptions = {
  client: RpcClient | null
  handsFree: boolean
}

export type UseRealtimeSessionResult = {
  state: SessionState
  detail: string | null
  transcript: TranscriptEntry[]
  start: () => Promise<void>
  stop: () => void
  approveByTap: () => Promise<void>
  sendText: (text: string) => void
  /** Push-to-talk: call on press-out. Hands-free mode ignores it. */
  endUtterance: () => void
  awaitingConfirmation: boolean
}

const TRANSCRIPT_LIMIT = 200

export function useRealtimeSession(options: UseRealtimeSessionOptions): UseRealtimeSessionResult {
  const { client, handsFree } = options
  const [state, setState] = useState<SessionState>('idle')
  const [detail, setDetail] = useState<string | null>(null)
  const [transcript, setTranscript] = useState<TranscriptEntry[]>([])
  const controllerRef = useRef<RealtimeController | null>(null)
  const sessionIdRef = useRef<string | null>(null)
  const keepAwakeOwner = useMemo(() => createMobileDictationKeepAwakeOwner(), [])
  useMobileDictationForegroundKeepAwake(keepAwakeOwner, sessionIdRef)

  useEffect(() => {
    const sub = addExpoTwoWayAudioEventListener('onMicrophoneData', (event) => {
      const raw = event.data
      controllerRef.current?.onMicChunk(raw instanceof Uint8Array ? raw : new Uint8Array(raw))
    })
    return () => {
      sub.remove()
      controllerRef.current?.stop()
      controllerRef.current = null
      tearDown()
    }
  }, [])

  const audio = useMemo<AudioLike>(
    () => ({
      startCapture: async () => {
        const permission = await requestMicrophonePermissionsAsync()
        if (!permission.granted) {
          return false
        }
        await initialize()
        return toggleRecording(true)
      },
      stopCapture: () => {
        toggleRecording(false)
      },
      play: (bytes) => {
        playPCMData(bytes)
      },
      stopPlayback: () => {
        stopPlayback()
      }
    }),
    []
  )

  const start = useCallback(async () => {
    if (!client) {
      setState('error')
      setDetail('Connect to a desktop first')
      return
    }
    const [settings, token] = await Promise.all([loadAssistantSettings(), readAssistantMintToken()])
    if (!settings.mintUrl || !token) {
      setState('error')
      setDetail('Set the mint URL and device token in Assistant settings')
      return
    }
    controllerRef.current?.stop()
    const id = `assistant-${Date.now().toString(36)}`
    sessionIdRef.current = id
    await keepAwakeOwner.acquire(id).catch(() => {})
    const controller = new RealtimeController({
      client,
      audio,
      handsFree,
      mint: async () => {
        const minted = await mintClientSecret({ url: settings.mintUrl, deviceToken: token })
        return { value: minted.value, model: minted.model }
      },
      // Why: RN's WebSocket handler types differ from the DOM's; the runtime shape matches SocketLike.
      createSocket: (url, protocols) => new WebSocket(url, protocols) as unknown as SocketLike,
      toBase64: (bytes) => Buffer.from(bytes).toString('base64'),
      fromBase64: (base64) => new Uint8Array(Buffer.from(base64, 'base64')),
      onState: (next, why) => {
        setState(next)
        setDetail(why ?? null)
        if (next === 'closed' || next === 'error') {
          const current = sessionIdRef.current
          sessionIdRef.current = null
          if (current) {
            void keepAwakeOwner.release(current)
          }
        }
      },
      onTranscript: (entry) => {
        setTranscript((prev) => [...prev.slice(-(TRANSCRIPT_LIMIT - 1)), entry])
      }
    })
    controllerRef.current = controller
    setTranscript([])
    await controller.start()
  }, [audio, client, handsFree, keepAwakeOwner])

  const stop = useCallback(() => {
    controllerRef.current?.stop()
  }, [])

  const approveByTap = useCallback(async () => {
    await controllerRef.current?.approveByTap()
  }, [])

  const sendText = useCallback((text: string) => {
    controllerRef.current?.sendText(text)
  }, [])

  const endUtterance = useCallback(() => {
    controllerRef.current?.endUtterance()
  }, [])

  return {
    state,
    detail,
    transcript,
    start,
    stop,
    approveByTap,
    sendText,
    endUtterance,
    awaitingConfirmation: state === 'awaiting_confirmation'
  }
}
