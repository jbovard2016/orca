// Assistant mode settings. The mint URL and hands-free flag are plain
// preferences; the mint device token is a secret and lives in the keychain
// like the pairing device tokens do.

import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import {
  deletePairingKeychainItem,
  readPairingKeychainItem,
  writePairingKeychainItem
} from '../transport/pairing-keychain'

const MINT_URL_KEY = 'orca:assistantMintUrl'
const HANDS_FREE_KEY = 'orca:assistantHandsFree'
const MINT_TOKEN_KEY = 'orca:assistantMintToken'

export type AssistantSettings = {
  mintUrl: string
  handsFree: boolean
}

export async function loadAssistantSettings(): Promise<AssistantSettings> {
  try {
    const [url, handsFree] = await Promise.all([
      AsyncStorage.getItem(MINT_URL_KEY),
      AsyncStorage.getItem(HANDS_FREE_KEY)
    ])
    return { mintUrl: url ?? '', handsFree: handsFree === null ? true : handsFree === 'true' }
  } catch {
    return { mintUrl: '', handsFree: true }
  }
}

export async function saveAssistantMintUrl(url: string): Promise<void> {
  await AsyncStorage.setItem(MINT_URL_KEY, url.trim())
}

export async function saveAssistantHandsFree(enabled: boolean): Promise<void> {
  await AsyncStorage.setItem(HANDS_FREE_KEY, String(enabled))
}

export async function readAssistantMintToken(): Promise<string | null> {
  if (Platform.OS === 'web') {
    return AsyncStorage.getItem(MINT_TOKEN_KEY)
  }
  return readPairingKeychainItem(MINT_TOKEN_KEY)
}

export async function writeAssistantMintToken(token: string): Promise<void> {
  const value = token.trim()
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(MINT_TOKEN_KEY, value)
    return
  }
  await writePairingKeychainItem(MINT_TOKEN_KEY, value)
}

export async function deleteAssistantMintToken(): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(MINT_TOKEN_KEY)
    return
  }
  await deletePairingKeychainItem(MINT_TOKEN_KEY)
}
