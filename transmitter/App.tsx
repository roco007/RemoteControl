import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AppState, Keyboard, KeyboardAvoidingView, Linking, Platform, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';
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
import { ShakeActionPanel } from './components/ShakeActionPanel';
import { useShakeActions } from './services/useShakeActions';
import { gestureSteps, gesturesForMode, type GestureKey } from './services/gestureSettings';
import { GestureSettings } from './components/GestureSettings';
import { useNativeGestures } from './services/useNativeGestures';
import { backgroundGesturesEligible } from './services/gestureAvailability';
import { gestureBridge, type GestureEvent } from './modules/gesture-service';
import { GestureActionController, gestureTransportActive, canRunFallbackGesture } from './services/GestureActionController';
import { SoundLightPanel } from './components/SoundLightPanel';
import { GestureCalibration } from './components/GestureCalibration';
import { useGestureCalibration } from './services/useGestureCalibration';

const labels: Record<ConnectionSnapshot['status'], string> = {
  connected: 'Connected', connecting: 'Connecting…', disconnected: 'Not connected', reconnecting: 'Reconnecting…', authentication_required: 'Pairing required', permission_required: 'Permission required', error: 'Connection lost',
};
function AwakeWhileConnected() { useKeepAwake(); return null; }
const modeTabs = [
  { id: 'mouse', label: 'Mouse', icon: '↖' },
  { id: 'keyboard', label: 'Keyboard', icon: '⌨' },
  { id: 'gestures', label: 'Gestures', icon: '↔' },
  { id: 'sound-light', label: 'Sound & Light', icon: '☼' },
] as const;
type ControllerMode = typeof modeTabs[number]['id'];

function Controller() {
  const [settings, setSettings] = useState<Settings>(defaultSettings);
  const settingsRef = useRef(settings); settingsRef.current = settings;
  const [mode, setMode] = useState<ControllerMode>('mouse');
  const [showSettings, setShowSettings] = useState(false);
  const [showGestures, setShowGestures] = useState(false);
  const [initialGesture, setInitialGesture] = useState<GestureKey | null>(null);
  const [cardNotice, setCardNotice] = useState('');
  const [triggeringCard, setTriggeringCard] = useState(false);
  const cardRequestPending = useRef(false);
  const [calibrationPaused, setCalibrationPaused] = useState(false);
  const calibrationPausedRef = useRef(false);
  const [softwareKeyboardVisible, setSoftwareKeyboardVisible] = useState(() => Keyboard.isVisible());
  const [loaded, setLoaded] = useState(false);
  const [storageError, setStorageError] = useState('');
  const { width, height } = useWindowDimensions();
  const compact = height < 540 && width > height;
  const dense = height < 740;
  const composing = mode === 'keyboard' && softwareKeyboardVisible && !showSettings && !showGestures && !calibrationPaused;
  useEffect(() => {
    const shown = Keyboard.addListener('keyboardDidShow', () => setSoftwareKeyboardVisible(true));
    const hidden = Keyboard.addListener('keyboardDidHide', () => setSoftwareKeyboardVisible(false));
    return () => { shown.remove(); hidden.remove(); };
  }, []);
  const haptic = useCallback(() => {
    if (settingsRef.current.haptics && Platform.OS !== 'web') void Haptics.selectionAsync().catch(() => {});
  }, []);
  const client = useMemo(() => {
    const manager = new ConnectionManager({ credentials, bluetooth: bleBridge, onBluetoothPaired: peer => {
    const next = { ...settingsRef.current, bluetooth: peer };
    settingsRef.current = next; setSettings(next);
    void saveSettings(next).catch(() => setStorageError('Bluetooth selection could not be saved.'));
    } });
    // Manual Connect is also held until native ownership is known on cold start.
    if (gestureBridge) manager.setActive(false);
    return manager;
  }, []);
  const input = useMemo(() => new InputEngine(payload => client.send(payload)), [client]);
  const keyboard = useMemo(() => new KeyboardController(payload => input.send(payload)), [input]);
  const interpreter = useMemo(() => new GestureInterpreter(input, () => settingsRef.current, haptic), [input, haptic]);
  const [, setActionVersion] = useState(0);
  const actionAlive = useRef(true);
  const gestureActions = useMemo(() => new GestureActionController(client, gestureBridge, () => { if (actionAlive.current) setActionVersion(value => value + 1); }, () => { input.clear(); keyboard.reset(); interpreter.reset(); }, Platform.OS === 'web' ? undefined : url => Linking.openURL(url)), [client, input, keyboard, interpreter]);
  const appActive = useRef(AppState.currentState === 'active');
  const controlsPaused = useRef(false); controlsPaused.current = showSettings || showGestures;
  const nextAction = useRef(0);
  const actionState = gestureActions.getSnapshot();
  const calibration = useGestureCalibration(blocked => {
    calibrationPausedRef.current = blocked;
    setCalibrationPaused(blocked);
    if (blocked) { input.clear(); keyboard.reset(); interpreter.reset(); }
  });
  const [connection, setConnection] = useState<ConnectionSnapshot>(client.getSnapshot());
  const connected = connection.status === 'connected';
  const supportsShake = connection.capabilities?.includes('system_actions') === true && connection.capabilities.includes('action_completion');
  const fallbackReady = gesturesForMode(settings.gestureMode, settings.gestureOrders).some(gesture => canRunFallbackGesture(gestureSteps(gesture, settings.gestureMappings), connection, Platform.OS !== 'web'));
  const performGesture = (gesture: GestureKey, event?: GestureEvent) => {
      const current = client.getSnapshot();
      const steps = gestureSteps(gesture, settingsRef.current.gestureMappings);
      const continuing = !!event && (event.batchIndex ?? 0) > 0;
      const allowed = (continuing || (appActive.current && !calibrationPausedRef.current && !controlsPaused.current && settingsRef.current.shakeActions)) && (event ? current.status === 'connected' && current.capabilities?.includes('action_completion') === true : canRunFallbackGesture(steps, current, Platform.OS !== 'web')) && (continuing || steps.length > 0);
      if (!event && !allowed) return false;
      const sent = event ? gestureActions.dispatchNative(event, allowed) : gestureActions.dispatchFallbackSequence(steps, `js-${Date.now()}-${++nextAction.current}`, gesture);
      if (!sent) return false;
      haptic(); return true;
  };
  const shake = useShakeActions({
    enabled: !actionState.pending && !calibrationPaused && !gestureBridge && settings.shakeActions && settings.gestureMode === 'count' && fallbackReady && !showSettings && !showGestures,
    // Restart even if a very fast completion batches pending=true/false into a
    // single render, leaving the enabled prop unchanged after the imperative stop.
    session: `${connection.serverId ?? ''}/${connection.transport ?? ''}/${actionState.completedOperations}`,
    isBlocked: () => gestureActions.getSnapshot().pending || calibrationPausedRef.current || controlsPaused.current || !appActive.current,
    onShake: count => performGesture(count === 1 ? 'single' : count === 2 ? 'double' : 'triple'),
  });
  const nativeGestures = useNativeGestures({ settings, getSettings: () => settingsRef.current, loaded, connection, paused: showSettings || showGestures || calibrationPaused,
    onGesture: event => performGesture(event.gesture, event),
    onNativeStatus: (status, recovery) => {
      if (!gestureActions.receiveNative(status, recovery)) return;
      if (status.actionPending || status.batchPending) setCardNotice('');
      appActive.current = status.appActive;
      client.setActive(gestureTransportActive(status.appActive, status));
    },
    onNativeLifecycle: event => {
      if (!gestureActions.acceptRevision(event)) return;
      appActive.current = event.active;
      if (!event.active) { input.clear(); keyboard.reset(); interpreter.reset(); }
      client.setActive(gestureTransportActive(event.active, event));
    },
    onNativeControl: control => {
    const previous = settingsRef.current;
    const enabled = control.enabled ?? previous.shakeActions;
    if (previous.shakeActions === enabled && previous.backgroundGestures === control.background) return;
    setCardNotice('');
    const next = { ...previous, shakeActions: enabled, backgroundGestures: control.background };
    settingsRef.current = next; setSettings(next);
    void saveSettings(next).catch(() => setStorageError('Gesture setting could not be saved.'));
  } });
  const backgroundReady = settings.backgroundGestures && backgroundGesturesEligible(settings);
  const shakeStatus = triggeringCard ? 'Starting action list…' : actionState.pending ? actionState.message || 'Action in progress…' : calibrationPaused ? 'Gesture actions paused for calibration' : !settings.shakeActions ? 'Gesture actions are off' : cardNotice || nativeGestures.error || nativeGestures.status?.batchSummary || actionState.message || (Platform.OS === 'web' ? 'Available in the phone app' : nativeGestures.status?.listening && !connected ? 'Listening · phone actions available offline' : !connected && (nativeGestures.available || !fallbackReady) ? 'Connect to your Mac to use gestures' : !supportsShake && (nativeGestures.available || !fallbackReady) ? 'Update the Mac receiver to support action completion' : nativeGestures.available ? nativeGestures.status?.listening ? backgroundReady ? nativeGestures.notificationDenied ? 'Listening · allow notifications' : 'Listening · background enabled' : settings.backgroundGestures ? 'Listening · background needs Wi-Fi' : 'Listening while this app is open' : nativeGestures.status?.message || 'Starting motion sensor…' : settings.gestureMode === 'directional' ? 'Directional mode needs the Android app' : shake.motionStatus === 'permission_required' ? 'Allow Motion access in phone settings' : shake.motionStatus === 'unavailable' ? 'Motion sensor unavailable on this device' : shake.motionStatus === 'checking' ? 'Checking motion sensor…' : 'Listening while this app is open');
  useEffect(() => client.subscribe(() => { const next = client.getSnapshot(); gestureActions.connectionChanged(next); setConnection(next); }), [client, gestureActions]);
  useEffect(() => setCardNotice(''), [connection.status]);
  useEffect(() => { if (!gestureBridge) client.setActive(appActive.current || actionState.pending); }, [client, actionState.pending]);
  useEffect(() => {
    let alive = true;
    void loadSettings().then(async saved => {
      if (!alive) return;
      if (Platform.OS === 'ios') saved.gestureMode = 'count';
      settingsRef.current = saved; setSettings(saved); setLoaded(true); client.configure(connectionConfiguration(saved));
      // Read native ownership before opening a foreground socket after a remount.
      await nativeGestures.refreshStatus();
      if (alive && (saved.host || saved.bluetooth)) void client.connect();
    }).catch(() => { if (alive) setStorageError('Could not restore the connection safely. Reopen the app to try again.'); });
    return () => { alive = false; };
  }, [client]);
  useEffect(() => {
    if (!connected) { input.clear(); keyboard.reset(); interpreter.reset(); }
    if (connection.status === 'authentication_required' || connection.status === 'permission_required') setShowSettings(true);
  }, [connected, connection.status, input, keyboard, interpreter]);
  useEffect(() => {
    const setActive = (active: boolean) => {
      appActive.current = active;
      if (!active) { input.clear(); keyboard.reset(); interpreter.reset(); }
      client.setActive(active || gestureActions.getSnapshot().pending);
    };
    // Native lifecycle distinguishes real backgrounding from system pairing dialogs.
    // RN Android's background event also fires on Activity.onPause during a dialog.
    const lifecycleBridge = gestureBridge ?? bleBridge;
    const nativeLifecycle = !gestureBridge ? bleBridge?.addListener('onAppState', event => setActive(event.active)) : undefined;
    const subscription = AppState.addEventListener('change', state => {
      if (state !== 'active') { input.clear(); keyboard.reset(); interpreter.reset(); }
      if (!lifecycleBridge && state !== 'inactive') setActive(state === 'active');
    });
    const onBlur = () => { keyboard.reset(); interpreter.reset(); };
    if (Platform.OS === 'web') globalThis.addEventListener?.('blur', onBlur);
    actionAlive.current = true;
    return () => { actionAlive.current = false; subscription.remove(); nativeLifecycle?.remove(); if (Platform.OS === 'web') globalThis.removeEventListener?.('blur', onBlur); keyboard.reset(); input.dispose(); client.disconnect(); };
  }, [client, input, keyboard, interpreter, gestureActions]);
  const changeSettings = (next: Settings) => {
    setCardNotice('');
    const masterChanged = next.shakeActions !== settingsRef.current.shakeActions;
    const backgroundChanged = next.backgroundGestures !== settingsRef.current.backgroundGestures;
    nativeGestures.settingsChanged();
    settingsRef.current = next; setSettings(next); client.configure(connectionConfiguration(next));
    if (masterChanged) nativeGestures.setEnabled(next.shakeActions);
    if (backgroundChanged) nativeGestures.setBackgroundEnabled(next.backgroundGestures);
    void saveSettings(next).catch(() => setStorageError('Settings could not be saved on this device.'));
  };
  const openCalibration = () => { calibration.open(); Keyboard.dismiss(); setShowSettings(false); setShowGestures(false); setInitialGesture(null); };
  const openGestureSettings = (gesture?: GestureKey) => {
    controlsPaused.current = true;
    setInitialGesture(gesture ?? null);
    setShowGestures(true);
  };
  const runGestureCard = async (gesture: GestureKey) => {
    // Re-read the master switch so a queued press cannot execute after OFF.
    if (!settingsRef.current.shakeActions) { openGestureSettings(gesture); return; }
    if (cardRequestPending.current || gestureActions.getSnapshot().pending || controlsPaused.current || calibrationPausedRef.current || !appActive.current) return;
    if (!gestureSteps(gesture, settingsRef.current.gestureMappings).length) {
      setCardNotice('No actions saved for this gesture. Use Configure to add actions.');
      return;
    }
    setCardNotice('');
    if (!gestureBridge) {
      if (!performGesture(gesture)) setCardNotice('Connect to your Mac to run these actions.');
      return;
    }
    cardRequestPending.current = true;
    setTriggeringCard(true);
    try {
      const result = await nativeGestures.triggerGesture(gesture);
      if (result.accepted) haptic();
      else if (actionAlive.current) setCardNotice(result.message);
    } catch {
      // Read status after an uncertain bridge reply; never retry the action.
      await nativeGestures.refreshStatus().catch(() => {});
      if (actionAlive.current) setCardNotice('Could not confirm the action request. Check gesture status before trying again.');
    } finally {
      cardRequestPending.current = false;
      if (actionAlive.current) setTriggeringCard(false);
    }
  };
  const openSettings = () => { controlsPaused.current = true; keyboard.reset(); interpreter.reset(); setShowSettings(true); };
  const changeMode = (next: ControllerMode) => { Keyboard.dismiss(); keyboard.reset(); interpreter.reset(); setMode(next); haptic(); };

  return <KeyboardAvoidingView style={s.safe} behavior={Platform.OS === 'web' ? undefined : 'padding'}>
    <SafeAreaView style={s.safe} edges={['top', 'bottom', 'left', 'right']}>
    <StatusBar style="light" />{connected && <AwakeWhileConnected />}
    <View style={[s.app, compact && s.compactApp, width > 760 && { maxWidth: 880 }]}>
      {!composing && <View style={[s.header, dense && { paddingTop: 8, paddingBottom: 8 }]}>
        <View style={s.brand}><View style={s.logo}><Text style={s.logoGlyph}>↖</Text></View><View><Text style={s.brandName}>remote<Text style={s.brandLight}> mac</Text></Text>{!dense && <Text style={s.brandTag}>A LITTLE CLOSER.</Text>}</View></View>
        <Pressable accessibilityRole="button" accessibilityLabel="Open connection and settings" onPress={openSettings} style={s.settingsButton}><Text style={s.settingsGlyph}>☷</Text></Pressable>
      </View>}
      {!composing && <View style={[s.statusRow, dense && { marginBottom: 10 }]}>
        <Pressable accessibilityRole="button" accessibilityLabel={`Connection: ${labels[connection.status]}`} onPress={openSettings} style={s.statusChip}><View style={[s.statusDot, { backgroundColor: connected ? t.accent : connection.status === 'disconnected' ? t.dim : t.warning }]} /><Text style={[s.statusLabel, connected && { color: t.accent }]}>{connected ? connection.serverName || 'Connected' : labels[connection.status]}</Text><Text style={s.chevron}>⌄</Text></Pressable>
        <Text style={s.latency}>{connected && connection.latencyMs !== undefined ? `${connection.latencyMs} ms / ${connection.transport === 'bluetooth' ? 'BLUETOOTH' : 'WI-FI'}` : connected ? `Connected via ${connection.transport === 'bluetooth' ? 'Bluetooth' : 'Wi-Fi'}` : 'LOCAL CONTROL'}</Text>
      </View>}
      {storageError !== '' && <Pressable onPress={() => setStorageError('')}><Text style={s.error}>{storageError}</Text></Pressable>}
      {(connection.status === 'error' || connection.status === 'reconnecting') && <Pressable accessibilityRole="button" onPress={openSettings} style={s.errorBanner}><Text style={s.error}>{connection.message || 'Connection lost. Tap to reconnect.'}</Text></Pressable>}
      <View style={s.workArea}>
        {mode === 'mouse' && <Trackpad interpreter={interpreter} input={input} keyboard={keyboard} connected={connected} onConnect={openSettings} compact={dense} />}
        {mode === 'keyboard' && <RemoteKeyboard keyboard={keyboard} connected={connected} haptic={haptic} compact={dense} composing={composing} />}
        {mode === 'sound-light' && <SoundLightPanel connected={connected} supported={connection.capabilities?.includes('system_adjust') === true} session={`${connection.serverId ?? ''}/${connection.transport ?? ''}`} paused={showSettings || showGestures || calibrationPaused} send={input.send} onConnect={openSettings} haptic={haptic} />}
        {mode === 'gestures' && <ScrollView contentContainerStyle={s.gestureContent} showsVerticalScrollIndicator={false}>
          <Text style={s.gestureEyebrow}>03 / GESTURES</Text>
          {!compact && <View style={s.gestureHero}><Text style={s.gestureTitle}>A Flick. A Shortcut.</Text><Text style={s.gestureDescription}>Your motion shortcuts stay ready across every tab.</Text></View>}
          <ShakeActionPanel activeGesture={actionState.pending && actionState.state === 'running' ? actionState.activeGesture : null} enabled={settings.shakeActions} onToggle={enabled => changeSettings({ ...settingsRef.current, shakeActions: enabled })} onConfigure={openGestureSettings} onRun={gesture => { void runGestureCard(gesture); }} busy={triggeringCard || actionState.pending} onCalibrate={openCalibration} calibrated={calibration.calibratedAt !== null} calibrationSummary={calibration.summary} status={shakeStatus} onResume={actionState.pending && actionState.state === 'unknown' ? () => { void gestureActions.resume(); } : undefined} resuming={actionState.resuming} listening={!actionState.pending && !calibrationPaused && settings.shakeActions && (nativeGestures.available ? nativeGestures.status?.listening === true : fallbackReady && shake.motionStatus === 'ready')} count={nativeGestures.status?.count ?? shake.count} lastCount={nativeGestures.status?.lastCount ?? shake.lastCount} lastGesture={nativeGestures.status?.lastGesture ?? (shake.lastCount === 1 ? 'single' : shake.lastCount === 2 ? 'double' : shake.lastCount === 3 ? 'triple' : '')} mode={settings.gestureMode} mappings={settings.gestureMappings} orders={settings.gestureOrders} compact={false} dense={dense} />
        </ScrollView>}
      </View>
      {!composing && <View style={[s.footer, dense && { paddingTop: 10, paddingBottom: 4 }]}><View style={s.tabs}>{modeTabs.map(tab => <Pressable key={tab.id} accessibilityRole="tab" accessibilityLabel={`${tab.label} mode`} accessibilityState={{ selected: mode === tab.id }} onPress={() => changeMode(tab.id)} style={[s.tab, mode === tab.id && s.tabSelected]}><Text style={[s.tabIcon, mode === tab.id && s.tabTextSelected]}>{tab.icon}</Text><Text style={[s.tabText, mode === tab.id && s.tabTextSelected]}>{tab.label}</Text></Pressable>)}</View>{!dense && <Text style={s.footerText}>LESS REACHING. MORE DOING.</Text>}</View>}
    </View>
    <SettingsScreen visible={showSettings && !calibration.visible} onClose={() => setShowSettings(false)} settings={settings} onSettings={changeSettings} client={client} connection={connection} onDisconnect={() => { nativeGestures.stop(); changeSettings({ ...settingsRef.current, shakeActions: false }); client.disconnect(); }} />
    <GestureSettings initialGesture={initialGesture} serverCatalogKey={connection.serverId ?? settings.host} loadServerApps={client.listInstalledApps} visible={showGestures && !calibration.visible} onClose={() => { setShowGestures(false); setInitialGesture(null); }} settings={settings} onSettings={changeSettings} onCalibrate={openCalibration} calibrated={calibration.calibratedAt !== null} calibrationSummary={calibration.summary} />
    <GestureCalibration visible={calibration.visible} available={calibration.available} status={calibration.status} busy={calibration.busy} error={calibration.error} onStart={calibration.start} onResume={calibration.resume} onCapture={calibration.capture} onSave={calibration.save} onCancel={calibration.cancel} onRefresh={calibration.refresh} />
    </SafeAreaView>
  </KeyboardAvoidingView>;
}

export default function App() { return <GestureHandlerRootView style={{ flex: 1, backgroundColor: t.bg }}><SafeAreaProvider><Controller /></SafeAreaProvider></GestureHandlerRootView>; }
const s = StyleSheet.create({
  gestureContent: { flexGrow: 1, paddingVertical: 5, gap: 15 }, gestureEyebrow: { color: t.dim, fontFamily: t.mono, fontSize: 10, letterSpacing: 1.1 }, gestureHero: { paddingVertical: 15, gap: 8 }, gestureTitle: { color: t.text, fontSize: 21, letterSpacing: -0.5 }, gestureDescription: { color: t.muted, fontSize: 12 },
  safe: { flex: 1, backgroundColor: t.bg }, app: { flex: 1, paddingHorizontal: 22, width: '100%', maxWidth: 580, alignSelf: 'center' }, compactApp: { paddingHorizontal: 25 }, header: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', paddingTop: 25, paddingBottom: 28 }, brand: { flexDirection: 'row', alignItems: 'center', gap: 11 }, logo: { width: 35, height: 39, borderRadius: 12, backgroundColor: t.accent, justifyContent: 'center', alignItems: 'center', transform: [{ rotate: '-6deg' }] }, logoGlyph: { color: t.bg, fontSize: 28 }, brandName: { color: t.text, fontSize: 22, letterSpacing: -0.7, fontWeight: '700' }, brandLight: { fontWeight: '300' }, brandTag: { color: t.dim, fontFamily: t.mono, fontSize: 7, letterSpacing: 1.8, marginTop: 3 }, settingsButton: { width: 39, height: 39, justifyContent: 'center', alignItems: 'center', borderWidth: 1, borderColor: t.border, borderRadius: 13 }, settingsGlyph: { color: t.muted, fontSize: 23, transform: [{ rotate: '90deg' }] },
  statusRow: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', gap: 10, marginBottom: 20 }, statusChip: { flexDirection: 'row', alignItems: 'center', gap: 7, maxWidth: '65%' }, statusDot: { width: 6, height: 6, borderRadius: 3 }, statusLabel: { color: t.muted, fontSize: 11, flexShrink: 1 }, chevron: { color: t.dim, fontSize: 13 }, latency: { color: t.dim, fontFamily: t.mono, fontSize: 7, letterSpacing: 0.6 }, workArea: { flex: 1, minHeight: 0 },
  footer: { alignItems: 'center', paddingTop: 24, paddingBottom: 15, gap: 17 }, tabs: { flexDirection: 'row', backgroundColor: t.surface, borderWidth: 1, borderColor: t.border, borderRadius: 18, padding: 5, width: '100%', maxWidth: 440 }, tab: { flex: 1, minWidth: 0, height: 53, justifyContent: 'center', alignItems: 'center', gap: 2, borderRadius: 13 }, tabSelected: { backgroundColor: t.accent }, tabIcon: { color: t.muted, fontSize: 20 }, tabText: { color: t.muted, fontSize: 10, fontWeight: '600', textAlign: 'center' }, tabTextSelected: { color: t.bg }, footerText: { color: t.dim, fontSize: 7, fontFamily: t.mono, letterSpacing: 1.7 }, error: { color: t.error, fontSize: 11, lineHeight: 17 }, errorBanner: { borderWidth: 1, borderColor: t.border, borderRadius: 10, padding: 10, marginBottom: 10 },
});
