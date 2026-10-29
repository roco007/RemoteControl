import React, { useEffect, useState } from 'react';
import { Modal, Platform, Pressable, ScrollView, StyleSheet, Switch, Text, TextInput, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { discoveryAvailable, requestLocalNetworkAccess, startDiscovery, stopDiscovery, subscribeDiscovery, type DiscoveredMac } from '../modules/lan-discovery';
import type { ConnectionManager } from '../networking/ConnectionManager';
import { BluetoothConnectionSection } from '../components/BluetoothConnectionSection';
import type { ConnectionSnapshot } from '../networking/types';
import type { Settings } from '../services/settings';
import { credentials } from '../services/credentials';
import { ActionButton, SettingStepper } from '../components/Controls';
import { theme as t } from '../components/theme';
import { PROTOCOL } from '../../shared/protocol';

export function SettingsScreen({ visible, onClose, settings, onSettings, client, connection, onDisconnect }: {
  visible: boolean; onClose: () => void; settings: Settings; onSettings: (s: Settings) => void; client: ConnectionManager; connection: ConnectionSnapshot; onDisconnect: () => void;
}) {
  const [host, setHost] = useState(settings.host);
  const [port, setPort] = useState(String(settings.port));
  const [code, setCode] = useState('');
  const [macs, setMacs] = useState<DiscoveredMac[]>([]);
  const [discoveryError, setDiscoveryError] = useState('');
  const [localError, setLocalError] = useState('');
  const [searching, setSearching] = useState(false);
  useEffect(() => { if (visible) { setHost(settings.host); setPort(String(settings.port)); } }, [visible, settings.host, settings.port]);
  useEffect(() => {
    if (!visible || !discoveryAvailable) return;
    setSearching(true); setDiscoveryError('');
    const unsubscribe = subscribeDiscovery(found => setMacs(found), error => { setDiscoveryError(error); setSearching(false); });
    startDiscovery();
    const timer = setTimeout(() => setSearching(false), 8000);
    return () => { clearTimeout(timer); unsubscribe(); stopDiscovery(); };
  }, [visible]);
  function connect(nextHost = host, nextPort = Number(port)) {
    setLocalError('');
    if (!nextHost.trim() || !Number.isInteger(nextPort) || nextPort < 1 || nextPort > 65535) { setLocalError('Enter a hostname and a port between 1 and 65535.'); return; }
    onSettings({ ...settings, host: nextHost.trim(), port: nextPort, transportMode: settings.transportMode === 'bluetooth' ? 'wifi' : settings.transportMode });
    void requestLocalNetworkAccess().then(granted => {
      if (granted) return client.connect({ host: nextHost.trim(), port: nextPort });
      setLocalError('Allow local network access in your phone settings to connect.');
    }).catch(() => setLocalError('Could not request local network access. Check your phone settings.'));
  }
  const toggle = (key: 'naturalScroll' | 'tapToClick' | 'twoFingerRightClick' | 'haptics', title: string, description: string) => <View style={s.settingRow} key={key}><View style={s.settingText}><Text style={s.settingTitle}>{title}</Text><Text style={s.description}>{description}</Text></View><Switch accessibilityLabel={title} value={settings[key]} onValueChange={value => onSettings({ ...settings, [key]: value })} trackColor={{ false: t.border, true: t.accentDark }} thumbColor={settings[key] ? t.accent : t.muted} /></View>;
  const busy = connection.status === 'connecting' || connection.status === 'reconnecting';
  const ready = connection.status === 'connected';
  return <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
    <SafeAreaView style={s.safe} edges={['top', 'bottom']}><View style={s.sheet}>
      <View style={s.header}><View><Text style={s.eyebrow}>MAKE YOURSELF AT HOME</Text><Text style={s.title}>Connection & settings</Text></View><Pressable accessibilityRole="button" accessibilityLabel="Close settings" onPress={onClose} style={s.close}><Text style={s.closeText}>×</Text></Pressable></View>
      <ScrollView contentContainerStyle={s.content} keyboardShouldPersistTaps="handled" showsVerticalScrollIndicator={false}>
        <View style={[s.connectionStatus, ready && { borderColor: t.accentDark }]}><View style={[s.dot, { backgroundColor: ready ? t.accent : t.warning }]} /><View style={{ flex: 1 }}><Text style={s.statusTitle}>{connection.serverName || 'Your Mac connection'}</Text><Text style={s.description}>{connection.message || (ready ? 'Connected and ready to control' : 'Start the receiver on your Mac, then connect below.')}</Text></View></View>
        <BluetoothConnectionSection visible={visible} client={client} connection={connection} settings={settings} onSettings={onSettings} />
        <View style={s.section}><View style={s.sectionHeader}><Text style={s.sectionTitle}>WI-FI · NEARBY MACS</Text>{discoveryAvailable && <Pressable accessibilityRole="button" onPress={() => { setSearching(true); setDiscoveryError(''); stopDiscovery(); startDiscovery(); setTimeout(() => setSearching(false), 8000); }}><Text style={s.link}>Search again ↻</Text></Pressable>}</View>
          {!discoveryAvailable ? <View style={s.discoveryEmpty}><Text style={s.discoveryIcon}>⌁</Text><Text style={s.emptyTitle}>{Platform.OS === 'web' ? 'Discovery lives on your phone' : 'Discovery needs a development build'}</Text><Text style={s.emptyDescription}>Use the manual connection below in {Platform.OS === 'web' ? 'this browser preview' : 'Expo Go'}. Install a development build for automatic Bonjour discovery.</Text></View> : macs.length ? macs.map(mac => <View key={mac.id} style={s.macRow}><Text style={s.macIcon}>▱</Text><View style={{ flex: 1 }}><Text style={s.settingTitle}>{mac.name}</Text><Text style={s.description}>{mac.host}:{mac.port}</Text></View><ActionButton title="Connect" onPress={() => connect(mac.host, mac.port)} /></View>) : <View style={s.discoveryEmpty}><Text style={s.discoveryIcon}>⌁</Text><Text style={s.emptyTitle}>{searching ? 'Searching for Macs…' : 'No Mac found yet'}</Text><Text style={s.emptyDescription}>{discoveryError || 'Keep both devices on the same Wi-Fi and start Remote Mac Control. Manual connection also works.'}</Text></View>}
        </View>
        <View style={s.section}><Text style={s.sectionTitle}>WI-FI · MANUAL CONNECTION</Text><View style={s.fieldRow}><View style={{ flex: 1, gap: 7 }}><Text style={s.fieldLabel}>IP ADDRESS OR HOSTNAME</Text><TextInput accessibilityLabel="Mac hostname or IP address" placeholder="192.168.0.105" placeholderTextColor={t.dim} value={host} onChangeText={setHost} autoCapitalize="none" autoCorrect={false} style={s.field} returnKeyType="next" /></View><View style={{ width: 82, gap: 7 }}><Text style={s.fieldLabel}>PORT</Text><TextInput accessibilityLabel="Receiver port" placeholder={String(PROTOCOL.defaultPort)} placeholderTextColor={t.dim} keyboardType="number-pad" value={port} onChangeText={setPort} style={s.field} maxLength={5} /></View></View>
          {!!localError && <Text style={s.error}>{localError}</Text>}<ActionButton primary title={busy ? 'Connecting…' : 'Connect to Mac ↗'} disabled={busy || !host.trim()} onPress={() => connect()} />
          <Text style={s.footnote}>Find the address in the receiver window on your Mac.</Text>
          {!!settings.host && <Pressable accessibilityRole="button" onPress={() => { onDisconnect(); setHost(''); setPort(String(PROTOCOL.defaultPort)); onSettings({ ...settings, host: '', port: PROTOCOL.defaultPort, shakeActions: false }); }}><Text style={s.link}>Clear saved address</Text></Pressable>}
        </View>
        {(connection.status === 'authentication_required' || connection.status === 'permission_required' || ready) && <View style={s.pairing}>
          <Text style={s.sectionTitle}>{ready ? 'PAIRED & CONNECTED' : connection.status === 'permission_required' ? 'ACCESSIBILITY REQUIRED' : 'PAIR THIS PHONE'}</Text>
          {connection.status === 'authentication_required' ? <><Text style={s.description}>Enter the six-digit code shown on your Mac. Only pair with a Mac you recognize.</Text><View style={s.fieldRow}><TextInput accessibilityLabel="Six digit pairing code" style={[s.field, s.code]} value={code} onChangeText={v => setCode(v.replace(/\D/g, '').slice(0, 6))} keyboardType="number-pad" maxLength={6} placeholder="000000" placeholderTextColor={t.dim} secureTextEntry={false} /><ActionButton primary title="Pair phone" disabled={code.length !== 6} onPress={() => { client.pair(code); setCode(''); }} /></View></> : connection.status === 'permission_required' ? <Text style={s.description}>On your Mac, open System Settings → Privacy & Security → Accessibility, and enable Remote Mac Control. The receiver checks permission automatically.</Text> : <Text style={s.description}>Your phone can control the Mac. Revoke access at any time in the receiver window.</Text>}
          {ready && <ActionButton primary title="Start controlling ↗" onPress={onClose} />}
        </View>}
        <View style={s.actionRow}><ActionButton title="Reconnect" onPress={() => client.reconnect()} disabled={!settings.host && !settings.bluetooth} style={{ flex: 1 }} /><ActionButton title="Disconnect" onPress={onDisconnect} disabled={connection.status === 'disconnected'} style={{ flex: 1 }} /></View>
        {connection.serverId && <Pressable accessibilityRole="button" onPress={() => { const id = connection.serverId; onDisconnect(); if (id) void credentials.removeToken(id).catch(() => setLocalError('Could not remove this saved pairing.')); }}><Text style={s.forget}>Forget pairing on this phone</Text></Pressable>}
        <View style={s.divider} /><View style={s.section}><Text style={s.sectionTitle}>MOUSE & TRACKPAD</Text><SettingStepper title="Pointer sensitivity" detail="Fine movements to fast sweeps" value={settings.pointerSensitivity} onChange={v => onSettings({ ...settings, pointerSensitivity: v })} /><SettingStepper title="Scroll sensitivity" detail="Horizontal and vertical scrolling" value={settings.scrollSensitivity} onChange={v => onSettings({ ...settings, scrollSensitivity: v })} />{toggle('naturalScroll', 'Natural scrolling', 'Content follows your fingers')}{toggle('tapToClick', 'Tap to click', 'One finger for a left click')}{toggle('twoFingerRightClick', 'Two-finger right click', 'Tap with two fingers for the context menu')}</View>
        <View style={s.section}><Text style={s.sectionTitle}>FEEDBACK</Text>{toggle('haptics', 'Haptic feedback', 'A subtle response to keys and clicks')}</View>
        <View style={s.note}><Text style={s.noteTitle}>A few native details</Text><Text style={s.noteText}>Use the arrow buttons for desktops and macOS overview. Two fingers scroll horizontally or vertically. Pinch with two fingers to zoom. Enable the corresponding navigation shortcuts in macOS.</Text><Text style={s.noteText}>Use trusted Wi-Fi. Local WebSocket traffic in this version is not encrypted. There is no cloud relay.</Text></View>
        <Text style={s.version}>REMOTE MAC / VERSION 1.0.21 / LOCAL BY DESIGN</Text>
      </ScrollView>
    </View></SafeAreaView>
  </Modal>;
}
const s = StyleSheet.create({
  safe: { flex: 1, backgroundColor: t.bg }, sheet: { flex: 1, width: '100%', maxWidth: 640, alignSelf: 'center' }, header: { paddingHorizontal: 22, paddingTop: 22, paddingBottom: 22, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 12 }, eyebrow: { color: t.dim, fontFamily: t.mono, fontSize: 8, letterSpacing: 1.4, marginBottom: 9 }, title: { color: t.text, fontSize: 22, letterSpacing: -0.7, fontWeight: '600' }, close: { width: 38, height: 38, borderRadius: 19, backgroundColor: t.raised, alignItems: 'center', justifyContent: 'center' }, closeText: { color: t.text, fontSize: 25 }, content: { paddingHorizontal: 22, paddingBottom: 30, gap: 25 },
  connectionStatus: { borderWidth: 1, borderColor: t.border, borderRadius: 14, padding: 15, flexDirection: 'row', gap: 11, alignItems: 'center' }, dot: { width: 7, height: 7, borderRadius: 4 }, statusTitle: { color: t.text, fontSize: 13, fontWeight: '600' }, description: { color: t.muted, fontSize: 12, lineHeight: 18, marginTop: 4 }, section: { gap: 12 }, sectionHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center' }, sectionTitle: { color: t.muted, fontSize: 9, letterSpacing: 1.5, fontFamily: t.mono }, link: { color: t.accent, fontSize: 11 },
  discoveryEmpty: { borderWidth: 1, borderColor: t.border, borderStyle: 'dashed', borderRadius: 15, padding: 20, alignItems: 'center', gap: 8 }, discoveryIcon: { color: t.accent, fontSize: 28 }, emptyTitle: { color: t.text, fontSize: 13, textAlign: 'center' }, emptyDescription: { color: t.muted, fontSize: 11, lineHeight: 18, textAlign: 'center', maxWidth: 350 }, macRow: { flexDirection: 'row', alignItems: 'center', gap: 12, backgroundColor: t.surface, padding: 13, borderRadius: 14 }, macIcon: { color: t.accent, fontSize: 30 },
  fieldRow: { flexDirection: 'row', gap: 10 }, fieldLabel: { fontFamily: t.mono, fontSize: 8, color: t.dim, letterSpacing: 0.6 }, field: { height: 47, borderWidth: 1, borderColor: t.border, backgroundColor: t.surface, borderRadius: 12, color: t.text, paddingHorizontal: 13, fontSize: 14 }, footnote: { color: t.dim, fontSize: 10, lineHeight: 16 }, error: { color: t.error, fontSize: 12 }, pairing: { padding: 18, gap: 12, backgroundColor: t.accentDark, borderRadius: 16 }, code: { flex: 1, fontFamily: t.mono, fontSize: 20, letterSpacing: 6 }, actionRow: { flexDirection: 'row', gap: 10 }, forget: { color: t.muted, fontSize: 11, textAlign: 'center' }, divider: { height: 1, backgroundColor: t.border },
  settingRow: { flexDirection: 'row', alignItems: 'center', gap: 12, paddingVertical: 9 }, settingText: { flex: 1 }, settingTitle: { color: t.text, fontSize: 14 }, note: { backgroundColor: t.surface, borderRadius: 15, padding: 17, gap: 10 }, noteTitle: { color: t.text, fontSize: 12 }, noteText: { color: t.muted, fontSize: 11, lineHeight: 18 }, version: { color: t.dim, fontSize: 8, letterSpacing: 1, fontFamily: t.mono, textAlign: 'center' },
});
