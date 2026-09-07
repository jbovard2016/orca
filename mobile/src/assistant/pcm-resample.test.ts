import { describe, expect, it } from 'vitest'
import {
  int16ToPcm16Bytes,
  micBytesToRealtimeBytes,
  pcm16BytesToInt16,
  realtimeBytesToPlaybackBytes,
  resampleInt16
} from './pcm-resample'

describe('pcm-resample', () => {
  it('round-trips int16 through little-endian bytes', () => {
    const samples = new Int16Array([0, 1, -1, 32767, -32768, 1234])
    expect(Array.from(pcm16BytesToInt16(int16ToPcm16Bytes(samples)))).toEqual(Array.from(samples))
  })

  it('drops a trailing odd byte instead of reading past the buffer', () => {
    const bytes = new Uint8Array([0x34, 0x12, 0xff])
    expect(Array.from(pcm16BytesToInt16(bytes))).toEqual([0x1234])
  })

  it('upsamples 16 kHz to 24 kHz at a 3:2 length ratio', () => {
    const input = new Int16Array(1600) // 100 ms
    const out = resampleInt16(input, 16000, 24000)
    expect(out.length).toBe(2400)
  })

  it('downsamples 24 kHz to 16 kHz at a 2:3 length ratio', () => {
    const input = new Int16Array(2400)
    expect(resampleInt16(input, 24000, 16000).length).toBe(1600)
  })

  it('preserves a constant signal exactly', () => {
    const input = new Int16Array(160).fill(1000)
    const out = resampleInt16(input, 16000, 24000)
    expect(out.every((v) => v === 1000)).toBe(true)
  })

  it('interpolates between neighbours', () => {
    const out = resampleInt16(new Int16Array([0, 300]), 16000, 24000)
    expect(Array.from(out)).toEqual([0, 200, 300])
  })

  it('returns the input untouched when rates match or input is empty', () => {
    const input = new Int16Array([1, 2, 3])
    expect(resampleInt16(input, 16000, 16000)).toBe(input)
    expect(resampleInt16(new Int16Array(0), 16000, 24000).length).toBe(0)
  })

  it('mic → realtime → playback round trip keeps a sine close to the original', () => {
    const n = 1600
    const src = new Int16Array(n)
    for (let i = 0; i < n; i += 1) {
      src[i] = Math.round(8000 * Math.sin((2 * Math.PI * 440 * i) / 16000))
    }
    const back = pcm16BytesToInt16(
      realtimeBytesToPlaybackBytes(micBytesToRealtimeBytes(int16ToPcm16Bytes(src)))
    )
    expect(back.length).toBe(n)
    let maxErr = 0
    for (let i = 0; i < n - 2; i += 1) {
      maxErr = Math.max(maxErr, Math.abs(back[i] - src[i]))
    }
    expect(maxErr).toBeLessThan(600) // < 7.5% of amplitude for a 440 Hz tone
  })
})
