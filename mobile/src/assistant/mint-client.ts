// Fetches a short-lived OpenAI Realtime client secret from the mint service on
// the tailnet. The permanent key never reaches the phone.

export type MintedSecret = { value: string; expiresAt: number; model: string }

export type MintClientOptions = {
  url: string // e.g. https://cursor.tail8bb3d0.ts.net:8791
  deviceToken: string
  fetchImpl?: typeof fetch
  timeoutMs?: number
}

export class MintError extends Error {
  constructor(
    message: string,
    readonly status: number | null
  ) {
    super(message)
    this.name = 'MintError'
  }
}

export async function mintClientSecret(options: MintClientOptions): Promise<MintedSecret> {
  const fetchImpl = options.fetchImpl ?? fetch
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 15_000)
  try {
    const res = await fetchImpl(`${options.url.replace(/\/+$/, '')}/mint`, {
      method: 'POST',
      headers: { 'X-Orca-Voice-Token': options.deviceToken },
      signal: controller.signal
    })
    if (res.status === 401) {
      throw new MintError('Voice mint rejected the device token', 401)
    }
    if (res.status === 429) {
      throw new MintError('Voice mint rate limit reached; try again later', 429)
    }
    if (!res.ok) {
      throw new MintError(`Voice mint failed (${res.status})`, res.status)
    }
    const body = (await res.json()) as { value?: unknown; expires_at?: unknown; model?: unknown }
    if (typeof body.value !== 'string' || typeof body.expires_at !== 'number') {
      throw new MintError('Voice mint returned an unexpected response', res.status)
    }
    return {
      value: body.value,
      expiresAt: body.expires_at,
      model: typeof body.model === 'string' ? body.model : 'gpt-realtime-2.1'
    }
  } catch (err) {
    if (err instanceof MintError) {
      throw err
    }
    const name = (err as { name?: string })?.name
    throw new MintError(
      name === 'AbortError' ? 'Voice mint timed out' : 'Voice mint unreachable',
      null
    )
  } finally {
    clearTimeout(timer)
  }
}
