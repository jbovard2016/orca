// PCM16 mono resampling between the audio module's fixed 16 kHz and the
// Realtime API's fixed 24 kHz. Linear interpolation is enough for speech.
// Why not change the native SAMPLE_RATE: dictation and the desktop speech path
// both expect 16 kHz; changing it would break them for every user of the fork.

export const MIC_SAMPLE_RATE = 16000
export const REALTIME_SAMPLE_RATE = 24000

export function pcm16BytesToInt16(bytes: Uint8Array): Int16Array {
  const even = bytes.byteLength - (bytes.byteLength % 2)
  const out = new Int16Array(even / 2)
  const view = new DataView(bytes.buffer, bytes.byteOffset, even)
  for (let i = 0; i < out.length; i += 1) {
    out[i] = view.getInt16(i * 2, true)
  }
  return out
}

export function int16ToPcm16Bytes(samples: Int16Array): Uint8Array {
  const out = new Uint8Array(samples.length * 2)
  const view = new DataView(out.buffer)
  for (let i = 0; i < samples.length; i += 1) {
    view.setInt16(i * 2, samples[i], true)
  }
  return out
}

export function resampleInt16(input: Int16Array, fromRate: number, toRate: number): Int16Array {
  if (fromRate === toRate || input.length === 0) {
    return input
  }
  const ratio = fromRate / toRate
  const outLength = Math.max(1, Math.round(input.length / ratio))
  const out = new Int16Array(outLength)
  const last = input.length - 1
  for (let i = 0; i < outLength; i += 1) {
    const pos = i * ratio
    const idx = Math.min(last, Math.floor(pos))
    const next = Math.min(last, idx + 1)
    const frac = pos - idx
    out[i] = Math.round(input[idx] + (input[next] - input[idx]) * frac)
  }
  return out
}

/** Microphone bytes (16 kHz) → bytes the Realtime API accepts (24 kHz). */
export function micBytesToRealtimeBytes(bytes: Uint8Array): Uint8Array {
  return int16ToPcm16Bytes(
    resampleInt16(pcm16BytesToInt16(bytes), MIC_SAMPLE_RATE, REALTIME_SAMPLE_RATE)
  )
}

/** Realtime output bytes (24 kHz) → bytes the audio module plays (16 kHz). */
export function realtimeBytesToPlaybackBytes(bytes: Uint8Array): Uint8Array {
  return int16ToPcm16Bytes(
    resampleInt16(pcm16BytesToInt16(bytes), REALTIME_SAMPLE_RATE, MIC_SAMPLE_RATE)
  )
}
