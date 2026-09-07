// Assistant mode settings. The mint URL and hands-free flag are plain
// preferences; the mint device token is a secret and lives in SecureStore.

import { Platform } from 'react-native'
import AsyncStorage from '@react-native-async-storage/async-storage'
import * as SecureStore from 'expo-secure-store'

// Why: the pairing keychain helper adds generation rotation for pairing tokens;
// this token needs none of that, and a plain SecureStore item keeps the failure
// surface small and the error message readable.
const SECURE_OPTIONS: SecureStore.SecureStoreOptions = {
  keychainAccessible: SecureStore.WHEN_UNLOCKED_THIS_DEVICE_ONLY
}

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
  return SecureStore.getItemAsync(MINT_TOKEN_KEY, SECURE_OPTIONS)
}

export async function writeAssistantMintToken(token: string): Promise<void> {
  const value = token.trim()
  if (Platform.OS === 'web') {
    await AsyncStorage.setItem(MINT_TOKEN_KEY, value)
    return
  }
  await SecureStore.setItemAsync(MINT_TOKEN_KEY, value, SECURE_OPTIONS)
}

export async function deleteAssistantMintToken(): Promise<void> {
  if (Platform.OS === 'web') {
    await AsyncStorage.removeItem(MINT_TOKEN_KEY)
    return
  }
  await SecureStore.deleteItemAsync(MINT_TOKEN_KEY, SECURE_OPTIONS)
}
