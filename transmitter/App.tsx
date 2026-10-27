import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Platform, Pressable, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider, SafeAreaView } from 'react-native-safe-area-context';
import { StatusBar } from 'expo-status-bar';
import * as Haptics from 'expo-haptics';
import { useKeepAwake } from 'expo-keep-awake';
import { Trackpad } from './components/Trackpad';
import { RemoteKeyboard } from './components/RemoteKeyboard';
import { SettingsScreen } from './screens/SettingsScreen';
import { theme as t } from './components/theme';
import { ConnectionManager } from './networking/ConnectionManager';
import { bleBridge } from './modules/bluetooth-transport';
import type { ConnectionSnapshot } from './networking/types';
import { credentials } from './services/credentials';
import { connectionConfiguration, defaultSettings, loadSettings, saveSettings, type Settings } from './services/settings';
import { InputEngine } from './services/InputEngine';
import { KeyboardController } from './services/KeyboardController';
import { GestureInterpreter } from './gestures/GestureInterpreter';

const labels: Record<ConnectionSnapshot['status'], string> = {
  connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected', reconnecting: 'Reconnecting…', authentication_required: 'Pairing required', permission_required: 'Permission required', error: 'Connection lost',
};
function AwakeWhileConnected() { useKeepAwake(); return null; }

function Controller() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const [mode, setMode] = useState<'mouse' | 'keyboard'>('mouse');
  const [showSettings, setShowSettings] = useState(false);
  const [storageError, setStorageError] = useState('');
  const { width, height } = useWindowDimensions();
  const compact = height < 540;
  const haptic = useCallback(() => {
    if (settingsRef.current.haptics && Platform.OS !== 'web') void Haptics.selectionAsync().catch(() => {});
  }, []);
  const client = useMemo(() => new ConnectionManager({ credentials, bluetooth: bleBridge, onBluetoothPaired: peer => {
    const next = { ...settingsRef.current, bluetooth: peer };
    settingsRef.current = next; setSettings(next);
    void saveSettings(next).catch(() => setStorageError('Bluetooth selection could not be saved.'));
  } }), []);
  const input = useMemo(() => new InputEngine(payload => client.send(payload)), [client]);
  const keyboard = useMemo(() => new KeyboardController(payload => input.send(payload)), [input]);
  const interpreter = useMemo(() => new GestureInterpreter(input, () => settingsRef.current, haptic), [input, haptic]);
  const [connection, setConnection] = useState<ConnectionSnapshot>(client.getSnapshot());
  const connected = connection.status === 'connected';
  useEffect(() => client.subscribe(() => setConnection(client.getSnapshot())), [client]);
  useEffect(() => {
    let alive = true;
    void loadSettings().then(saved => { if (alive) { settingsRef.current = saved; setSettings(saved); client.configure(connectionConfiguration(saved)); if (saved.host || saved.bluetooth) void client.connect(); } });
    return () => { alive = false; };
  }, [client]);
  useEffect(() => {
    if (!connected) { input.clear(); keyboard.reset(); interpreter.reset(); }
    if (connection.status === 'authentication_required' || connection.status === 'permission_required') setShowSettings(true);
  }, [connected, connection.status, input, keyboard, interpreter]);
  useEffect(() => {
    const setActive = (active: boolean) => {
      if (!active) { input.clear(); keyboard.reset(); interpreter.reset(); }
      client.setActive(active);
    };
    // Native lifecycle distinguishes real backgrounding from system pairing dialogs.
    // RN Android's background event also fires on Activity.onPause during a dialog.
    const nativeLifecycle = bleBridge?.addListener('onAppState', event => setActive(event.active));
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') { input.clear(); keyboard.reset(); interpreter.reset(); }
      if (!bleBridge && state !== 'inactive') setActive(state === 'active');
    });
    const onBlur = () => { keyboard.reset(); interpreter.reset(); };
    if (Platform.OS === 'web') globalThis.addEventListener?.('blur', onBlur);
    return () => { subscription.remove(); nativeLifecycle?.remove(); if (Platform.OS === 'web') globalThis.removeEventListener?.('blur', onBlur); keyboard.reset(); input.dispose(); client.disconnect(); };
  }, [client, input, keyboard, interpreter]);
  const changeSettings = (next: Settings) => { settingsRef.current = next; setSettings(next); client.configure(connectionConfiguration(next)); void saveSettings(next).catch(() => setStorageError('Settings could not be saved on this device.')); };
  const openSettings = () => { keyboard.reset(); interpreter.reset(); setShowSettings(true); };
  const changeMode = (next: 'mouse' | 'keyboard') => { keyboard.reset(); interpreter.reset(); setMode(next); haptic(); };

  return <SafeAreaView style={s.safe} edges={['top', 'bottom', 'left', 'right']}>
    <StatusBar style="light" />{connected && <AwakeWhileConnected />}
    <View style={[s.app, compact && s.compactApp, width > 760 && { maxWidth: 880 }]}>
      <View style={[s.header, compact && { paddingVertical: 8 }]}>
        <View style={s.brand}><View style={s.logo}><Text style={s.logoGlyph}>↖</Text></View><View><Text style={s.brandName}>remote<Text style={s.brandLight}> mac</Text></Text>{!compact && <Text style={s.brandTag}>A LITTLE CLOSER.</Text>}</View></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open connection and settings" onPress={openSettings} style={s.settingsButton}><Text style={s.settingsGlyph}>☷</Text></Pressable>
      </View>
      <View style={[s.statusRow, compact && { marginBottom: 10 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Connection: ${labels[connection.status]}`} onPress={openSettings} style={s.statusChip}><View style={[s.statusDot, { backgroundColor: connected ? t.accent : connection.status === 'disconnected' ? t.dim : t.warning }]} /><Text style={[s.statusLabel, connected && { color: t.accent }]}>{connected ? connection.serverName || 'Connected' : labels[connection.status]}</Text><Text style={s.chevron}>⌄</Text></Pressable>
        <Text style={s.latency}>{connected && connection.latencyMs !== undefined ? `${connection.latencyMs} ms / ${connection.transport === 'bluetooth' ? 'BLUETOOTH' : 'WI-FI'}` : connected ? `Connected via ${connection.transport === 'bluetooth' ? 'Bluetooth' : 'Wi-Fi'}` : 'LOCAL CONTROL'}</Text>
      </View>
      {storageError !== '' && <Pressable onPress={() => setStorageError('')}><Text style={s.error}>{storageError}</Text></Pressable>}
      {(connection.status === 'error' || connection.status === 'reconnecting') && <Pressable accessibilityRole="button" onPress={openSettings} style={s.errorBanner}><Text style={s.error}>{connection.message || 'Connection lost. Tap to reconnect.'}</Text></Pressable>}
      <View style={s.workArea}>{mode === 'mouse' ? <Trackpad interpreter={interpreter} input={input} keyboard={keyboard} connected={connected} onConnect={openSettings} compact={compact} /> : <RemoteKeyboard keyboard={keyboard} connected={connected} haptic={haptic} compact={compact} />}</View>
      <View style={[s.footer, compact && { paddingTop: 10, paddingBottom: 4 }]}><View style={s.tabs}>{(['mouse', 'keyboard'] as const).map(tab => <Pressable key={tab} accessibilityRole="tab" accessibilityLabel={tab === 'mouse' ? 'Mouse mode' : 'Keyboard mode'} accessibilityState={{ selected: mode === tab }} onPress={() => changeMode(tab)} style={[s.tab, mode === tab && s.tabSelected]}><Text style={[s.tabIcon, mode === tab && s.tabTextSelected]}>{tab === 'mouse' ? '↖' : '⌨'}</Text><Text style={[s.tabText, mode === tab && s.tabTextSelected]}>{tab === 'mouse' ? 'Mouse' : 'Keyboard'}</Text></Pressable>)}</View>{!compact && <Text style={s.footerText}>LESS REACHING. MORE DOING.</Text>}</View>
    </View>
    <SettingsScreen visible={showSettings} onClose={() => setShowSettings(false)} settings={settings} onSettings={changeSettings} client={client} connection={connection} />
  </SafeAreaView>;
}

export default function App() { return <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.bg }}><SafeAreaProvider><Controller /></SafeAreaProvider></GestureHandlerRootView>; }
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: t.bg }, app: { flex: 1, paddingHorizontal: 22, width: '100%', maxWidth: 580, alignSelf: 'center' }, compactApp: { paddingHorizontal: 25 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 25, paddingBottom: 28 }, brand: { flexDirection: 'row', alignItems: 'center', gap: 11 }, logo: { width: 35, height: 39, borderRadius: 12, backgroundColor: t.accent, justifyContent: 'center', alignItems: 'center', transform: [{ rotate: '-6deg' }] }, logoGlyph: { color: t.bg, fontSize: 28 }, brandName: { color: t.text, fontSize: 22, letterSpacing: -0.7, fontWeight: '700' }, brandLight: { fontWeight: '300' }, brandTag: { color: t.dim, fontFamily: t.mono, fontSize: 7, letterSpacing: 1.8, marginTop: 3 }, settingsButton: { width: 39, height: 39, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 13 }, settingsGlyph: { color: t.muted, fontSize: 23, transform: [{ rotate: '90deg' }] },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 20 }, statusChip: { flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '65%' }, statusDot: { width: 6, height: 6, borderRadius: 3 }, statusLabel: { color: t.muted, fontSize: 11, flexShrink: 1 }, chevron: { color: t.dim, fontSize: 13 }, latency: { color: t.dim, fontFamily: t.mono, fontSize: 7, letterSpacing: 0.6 }, workArea: { flex: 1, minHeight: 0 },
  footer: { alignItems: 'center', paddingTop: 24, paddingBottom: 15, gap: 17 }, tabs: { flexDirection: 'row', backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 18, padding: 5, width: 278 }, tab: { flex: 1, height: 44, flexDirection: 'row', justifyContent: 'center', alignItems: 'center', gap: 9, borderRadius: 13 }, tabSelected: { backgroundColor: t.accent }, tabIcon: { color: t.muted, fontSize: 22 }, tabText: { color: t.muted, fontSize: 12, fontWeight: '600' }, tabTextSelected: { color: t.bg }, footerText: { color: t.dim, fontSize: 7, fontFamily: t.mono, letterSpacing: 1.7 }, error: { color: t.error, fontSize: 11, lineHeight: 17 }, errorBanner: { borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 10, marginBottom: 10 },
});
