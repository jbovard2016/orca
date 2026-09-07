import { useCallback, useEffect, useMemo, useState } from 'react'
import { Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useRouter } from 'expo-router'
import { ChevronLeft } from 'lucide-react-native'
import { colors, radii, spacing, typography } from '../src/theme/mobile-theme'
import { loadHosts } from '../src/transport/host-store'
import type { HostProfile } from '../src/transport/types'
import { useFocusedSettingsHostClients } from '../src/transport/settings-host-client-connections'
import type { RpcClient } from '../src/transport/rpc-client'
import {
  loadAssistantSettings,
  readAssistantMintToken,
  saveAssistantHandsFree,
  saveAssistantMintUrl,
  writeAssistantMintToken
} from '../src/assistant/assistant-settings'
import { useRealtimeSession } from '../src/assistant/use-realtime-session'
import type { SessionState } from '../src/assistant/realtime-controller'

const STATE_LABEL: Record<SessionState, string> = {
  idle: 'Off',
  minting: 'Getting a session key…',
  connecting: 'Connecting…',
  listening: 'Listening',
  responding: 'Speaking',
  awaiting_confirmation: 'Waiting for your yes',
  executing: 'Doing it…',
  error: 'Error',
  closed: 'Ended'
}

export default function AssistantScreen(): React.JSX.Element {
  const router = useRouter()
  const insets = useSafeAreaInsets()

  const [hosts, setHosts] = useState<HostProfile[]>([])
  useEffect(() => {
    void loadHosts().then(setHosts)
  }, [])
  const hostIds = useMemo(() => hosts.map((h) => h.id), [hosts])
  const { clients: hostClients } = useFocusedSettingsHostClients(hostIds)
  const client: RpcClient | null = useMemo(
    () => hostClients.find((entry) => entry.state === 'connected')?.client ?? null,
    [hostClients]
  )

  const [handsFree, setHandsFree] = useState(true)
  const [mintUrl, setMintUrl] = useState('')
  const [tokenDraft, setTokenDraft] = useState('')
  const [hasToken, setHasToken] = useState(false)
  const [showSettings, setShowSettings] = useState(false)
  const [saveError, setSaveError] = useState<string | null>(null)
  useEffect(() => {
    void loadAssistantSettings().then((s) => {
      setHandsFree(s.handsFree)
      setMintUrl(s.mintUrl)
      setShowSettings(!s.mintUrl)
    })
    void readAssistantMintToken().then((t) => setHasToken(Boolean(t)))
  }, [])

  const session = useRealtimeSession({ client, handsFree })
  const active = session.state !== 'idle' && session.state !== 'closed' && session.state !== 'error'

  const saveSettings = useCallback(async () => {
    setSaveError(null)
    try {
      await saveAssistantMintUrl(mintUrl)
      await saveAssistantHandsFree(handsFree)
      if (tokenDraft.trim()) {
        await writeAssistantMintToken(tokenDraft)
        setTokenDraft('')
        setHasToken(true)
      }
      setShowSettings(false)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      // eslint-disable-next-line no-console
      console.warn('[assistant] save failed', message)
      setSaveError(message)
    }
  }, [handsFree, mintUrl, tokenDraft])

  return (
    <View style={[styles.container, { paddingTop: insets.top + spacing.sm }]}>
      <View style={styles.topRow}>
        <Pressable style={styles.backButton} onPress={() => router.back()}>
          <ChevronLeft size={22} color={colors.textSecondary} />
        </Pressable>
        <Text style={styles.heading}>Assistant</Text>
        <Pressable style={styles.settingsLink} onPress={() => setShowSettings((v) => !v)}>
          <Text style={styles.settingsLinkText}>{showSettings ? 'Done' : 'Settings'}</Text>
        </Pressable>
      </View>

      {showSettings ? (
        <View style={styles.section}>
          <Text style={styles.rowLabel}>Mint URL</Text>
          <TextInput
            style={styles.input}
            value={mintUrl}
            onChangeText={setMintUrl}
            autoCapitalize="none"
            autoCorrect={false}
            keyboardType="url"
            placeholder="https://host.tailnet.ts.net:8791"
            placeholderTextColor={colors.textMuted}
          />
          <Text style={styles.rowLabel}>Device token {hasToken ? '(saved)' : ''}</Text>
          <TextInput
            style={styles.input}
            value={tokenDraft}
            onChangeText={setTokenDraft}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            placeholder={
              hasToken ? 'Leave blank to keep the saved token' : 'Paste the mint device token'
            }
            placeholderTextColor={colors.textMuted}
          />
          <View style={styles.row}>
            <Text style={styles.rowLabel}>Hands-free (server voice detection)</Text>
            <Switch
              value={handsFree}
              onValueChange={setHandsFree}
              trackColor={{ false: colors.bgRaised, true: colors.textSecondary }}
              thumbColor={colors.textPrimary}
            />
          </View>
          <Pressable style={styles.primaryButton} onPress={() => void saveSettings()}>
            <Text style={styles.primaryButtonText}>Save</Text>
          </Pressable>
          {saveError ? <Text style={styles.errorText}>{saveError}</Text> : null}
        </View>
      ) : null}

      <View style={styles.statusRow}>
        <View style={[styles.dot, active ? styles.dotActive : null]} />
        <Text style={styles.statusText}>
          {STATE_LABEL[session.state]}
          {session.detail ? ` — ${session.detail}` : ''}
        </Text>
      </View>
      {!client ? <Text style={styles.hint}>Connect to a desktop to use the assistant.</Text> : null}

      <ScrollView style={styles.transcript} contentContainerStyle={styles.transcriptContent}>
        {session.transcript.map((entry, i) => (
          <Text
            key={`${entry.at}-${i}`}
            style={[
              styles.line,
              entry.role === 'user' ? styles.lineUser : null,
              entry.role === 'system' ? styles.lineSystem : null
            ]}
          >
            {entry.role === 'user' ? 'You: ' : entry.role === 'assistant' ? 'Orca: ' : ''}
            {entry.text}
          </Text>
        ))}
      </ScrollView>

      {session.awaitingConfirmation ? (
        <Pressable style={styles.confirmButton} onPress={() => void session.approveByTap()}>
          <Text style={styles.primaryButtonText}>Confirm</Text>
        </Pressable>
      ) : null}

      {!active ? (
        <Pressable
          style={[styles.talkButton, !client ? styles.disabled : null]}
          disabled={!client}
          onPress={() => void session.start()}
        >
          <Text style={styles.talkButtonText}>Start</Text>
        </Pressable>
      ) : handsFree ? (
        <Pressable style={[styles.talkButton, styles.talkButtonStop]} onPress={session.stop}>
          <Text style={styles.talkButtonText}>Stop</Text>
        </Pressable>
      ) : (
        <View style={styles.pttRow}>
          <Pressable style={styles.talkButton} onPressOut={session.endUtterance}>
            <Text style={styles.talkButtonText}>Hold to talk</Text>
          </Pressable>
          <Pressable style={styles.secondaryButton} onPress={session.stop}>
            <Text style={styles.secondaryButtonText}>End</Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: colors.bgBase, paddingHorizontal: spacing.lg },
  topRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: spacing.sm,
    marginBottom: spacing.md
  },
  backButton: {
    width: 36,
    height: 36,
    borderRadius: 18,
    alignItems: 'center',
    justifyContent: 'center',
    marginRight: spacing.sm
  },
  heading: { fontSize: 20, fontWeight: '700', color: colors.textPrimary, flex: 1 },
  settingsLink: { paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  settingsLinkText: { color: colors.accentBlue, fontSize: typography.bodySize, fontWeight: '600' },
  section: {
    backgroundColor: colors.bgPanel,
    borderRadius: radii.card,
    padding: spacing.md,
    gap: spacing.sm,
    marginBottom: spacing.md
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: spacing.sm
  },
  rowLabel: {
    fontSize: typography.bodySize,
    fontWeight: '500',
    color: colors.textPrimary,
    flexShrink: 1
  },
  input: {
    backgroundColor: colors.bgBase,
    color: colors.textPrimary,
    borderRadius: radii.button,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    fontSize: typography.bodySize
  },
  primaryButton: {
    backgroundColor: colors.accentBlue,
    borderRadius: radii.button,
    paddingVertical: spacing.sm + 2,
    alignItems: 'center'
  },
  primaryButtonText: { color: colors.onAccent, fontWeight: '700', fontSize: typography.bodySize },
  statusRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.sm,
    marginBottom: spacing.sm
  },
  dot: { width: 10, height: 10, borderRadius: 5, backgroundColor: colors.textMuted },
  dotActive: { backgroundColor: colors.statusGreen },
  statusText: { color: colors.textSecondary, fontSize: typography.bodySize, flexShrink: 1 },
  hint: { color: colors.textMuted, fontSize: typography.metaSize, marginBottom: spacing.sm },
  transcript: { flex: 1, backgroundColor: colors.bgPanel, borderRadius: radii.card },
  transcriptContent: { padding: spacing.md, gap: spacing.xs },
  line: { color: colors.textPrimary, fontSize: typography.bodySize },
  lineUser: { color: colors.textSecondary },
  lineSystem: { color: colors.textMuted, fontSize: typography.metaSize },
  confirmButton: {
    backgroundColor: colors.statusGreen,
    borderRadius: radii.button,
    paddingVertical: spacing.md,
    alignItems: 'center',
    marginTop: spacing.md
  },
  talkButton: {
    backgroundColor: colors.accentBlue,
    borderRadius: radii.card,
    paddingVertical: spacing.lg,
    alignItems: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.lg,
    flex: 1
  },
  talkButtonStop: { backgroundColor: colors.statusRed },
  talkButtonText: { color: colors.onAccent, fontWeight: '700', fontSize: 18 },
  pttRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'stretch' },
  secondaryButton: {
    backgroundColor: colors.bgRaised,
    borderRadius: radii.card,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: spacing.md,
    marginBottom: spacing.lg
  },
  secondaryButtonText: {
    color: colors.textPrimary,
    fontWeight: '600',
    fontSize: typography.bodySize
  },
  disabled: { opacity: 0.5 },
  errorText: { color: colors.statusRed, fontSize: typography.metaSize }
})
