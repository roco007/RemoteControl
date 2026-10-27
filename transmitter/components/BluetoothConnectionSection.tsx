import React, { useEffect, useRef, useState } from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import { bleBridge, type BluetoothDevice } from '../modules/bluetooth-transport';
import { BLE, bluetoothUnavailableReason } from '../networking/BluetoothTransport';
import type { ConnectionManager } from '../networking/ConnectionManager';
import type { ConnectionSnapshot } from '../networking/types';
import type { TransportMode } from '../networking/Transport';
import type { Settings } from '../services/settings';
import { ActionButton } from './Controls';
import { theme as t } from './theme';

const choices: Array<[TransportMode, string]> = [['automatic', 'Automatic'], ['wifi', 'Wi-Fi'], ['bluetooth', 'Bluetooth']];
export function BluetoothConnectionSection({ visible, client, connection, settings, onSettings }: {
  visible: boolean; client: ConnectionManager; connection: ConnectionSnapshot; settings: Settings; onSettings: (settings: Settings) => void;
}) {
  const [devices, setDevices] = useState<BluetoothDevice[]>([]);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState('');
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const scanGeneration = useRef(0);
  const stop = () => {
    ++scanGeneration.current; clearTimeout(timer.current); timer.current = undefined;
    setSearching(false); void bleBridge?.stopScan().catch(() => {});
  };
  useEffect(() => {
    if (!visible || !bleBridge) return;
    const found = bleBridge.addListener('onDevices', event => setDevices(event.devices));
    const failed = bleBridge.addListener('onError', event => { setError(event.message); setSearching(false); });
    const state = bleBridge.addListener('onState', event => {
      if (event.state === 'poweredOff') { setError('Turn on Bluetooth in your phone settings.'); setSearching(false); }
      if (event.state === 'unauthorized') { setError('Bluetooth permission was denied. Allow Remote Mac in your phone settings.'); setSearching(false); }
    });
    const app = bleBridge.addListener('onAppState', event => { if (!event.active) stop(); });
    return () => { stop(); found.remove(); failed.remove(); state.remove(); app.remove(); };
  }, [visible]);
  const search = async () => {
    if (!bleBridge) return;
    stop(); const gen = scanGeneration.current;
    setError(''); setDevices([]); setSearching(true);
    try {
      await bleBridge.startScan(BLE.service);
      if (gen !== scanGeneration.current) return;
      timer.current = setTimeout(stop, 10_000);
    } catch (reason) {
      if (gen !== scanGeneration.current) return;
      setSearching(false); setError(reason instanceof Error ? reason.message : 'Unable to search Bluetooth. Check system permissions.');
    }
  };
  const selectMode = (transportMode: TransportMode) => {
    if (transportMode === 'bluetooth' && !bleBridge) return;
    stop(); onSettings({ ...settings, transportMode });
    if ((transportMode === 'bluetooth' && settings.bluetooth) || (transportMode === 'wifi' && settings.host) || (transportMode === 'automatic' && (settings.host || settings.bluetooth))) client.reconnect();
    else client.disconnect();
  };
  const ready = connection.status === 'connected';
  return <View style={s.section}>
    <Text style={s.label}>CONNECTION</Text>
    {connection.transport && <View style={s.summary}>
      <Text style={s.title}>{ready ? '● Connected' : '○ Disconnected'} · {connection.serverName || settings.bluetooth?.name || 'Mac'}</Text>
      <Text style={s.detail}>Transport: {connection.transport === 'bluetooth' ? 'Bluetooth' : 'Wi-Fi'}{!ready ? ' (connecting or last used)' : ''}</Text>
      {connection.transport === 'wifi' && connection.endpoint && <Text style={s.detail}>IP: {connection.endpoint.host}:{connection.endpoint.port}</Text>}
    </View>}
    <Text style={s.label}>SWITCH TRANSPORT</Text>
    <View accessibilityRole="radiogroup" style={s.choices}>{choices.map(([value, label]) => <Pressable key={value} accessibilityRole="radio" disabled={value === 'bluetooth' && !bleBridge} accessibilityState={{ checked: settings.transportMode === value, disabled: value === 'bluetooth' && !bleBridge }} onPress={() => selectMode(value)} style={[s.choice, settings.transportMode === value && s.selected, value === 'bluetooth' && !bleBridge && s.disabled]}><Text style={[s.choiceText, settings.transportMode === value && { color: t.accent }]}>{settings.transportMode === value ? '●' : '○'} {label}</Text></Pressable>)}</View>
    <Text style={s.detail}>{!bleBridge && settings.transportMode !== 'wifi' ? settings.transportMode === 'bluetooth' ? 'Bluetooth is unavailable here. Choose Wi-Fi to connect from this app.' : 'Automatic uses Wi-Fi here. Bluetooth backup requires the native phone app.' : settings.transportMode === 'automatic' ? 'Wi-Fi is preferred. Your selected Bluetooth Mac is the backup. Wi-Fi recovery is checked while Bluetooth is connected.' : settings.transportMode === 'wifi' ? 'Use only the Wi-Fi address below.' : 'Use only the selected Bluetooth Mac.'}</Text>
    <View style={s.heading}><Text style={s.label}>BLUETOOTH · NEARBY MACS</Text><ActionButton title={searching ? 'Stop search' : 'Bluetooth Search'} disabled={!bleBridge} onPress={() => searching ? stop() : void search()} /></View>
    {!bleBridge ? <View style={s.summary}>
      <Text style={s.title}>{Platform.OS === 'web' ? 'Bluetooth search is unavailable in this browser preview' : 'Install the updated native phone app to search'}</Text>
      <Text style={s.detail}>{bluetoothUnavailableReason}</Text>
      <Text style={s.detail}>Install and open Remote Mac on your phone, then go to Connection & settings → Bluetooth Search. Open the installed app itself, not this page in a browser or Expo Go.</Text>
      {settings.transportMode === 'bluetooth' && <ActionButton title="Use Wi-Fi here" onPress={() => selectMode('wifi')} />}
    </View> : <>
      <Text style={s.detail}>{searching ? 'Searching for Mac…' : 'Start Bluetooth on the receiver, then search. Connect once to approve system pairing; choose Automatic afterwards for backup use.'}</Text>
      {devices.map(device => <View key={device.id} style={s.device}><View style={{ flex: 1 }}><Text style={s.title}>{device.name || 'Remote Mac'}</Text><Text style={s.detail}>Available · Bluetooth</Text></View><ActionButton title="Connect" onPress={() => {
        stop();
        onSettings({ ...settings, transportMode: 'bluetooth', bluetooth: settings.bluetooth?.id === device.id ? settings.bluetooth : { id: device.id, name: device.name || 'Remote Mac' } });
        client.reconnect();
      }} /></View>)}
      {!searching && !devices.length && <Text style={s.detail}>No Bluetooth results yet.</Text>}
      {!!error && <Text style={s.error}>{error}</Text>}
    </>}
    {settings.bluetooth && <View style={s.summary}><Text style={s.title}>Selected: {settings.bluetooth.name}</Text><Text style={s.detail}>{settings.bluetooth.serverId ? 'Authorized receiver remembered' : 'Connect and authorize this Mac before relying on failover'}</Text><View style={s.heading}><ActionButton title="Connect Bluetooth" disabled={!bleBridge} onPress={() => selectMode('bluetooth')} /><ActionButton title="Forget device" onPress={() => { stop(); client.disconnect(); onSettings({ ...settings, bluetooth: undefined, transportMode: 'automatic' }); }} /></View></View>}
  </View>;
}
const s = StyleSheet.create({
  section: { gap: 12 }, label: { color: t.muted, fontSize: 9, letterSpacing: 1.2, fontFamily: t.mono },
  summary: { gap: 5, padding: 13, backgroundColor: t.surface, borderRadius: 12 }, title: { color: t.text, fontSize: 13 },
  detail: { color: t.muted, fontSize: 11, lineHeight: 17 }, choices: { flexDirection: 'row', gap: 7, flexWrap: 'wrap' },
  choice: { borderWidth: 1, borderColor: t.border, borderRadius: 10, paddingHorizontal: 12, paddingVertical: 13 }, selected: { borderColor: t.accentDark, backgroundColor: t.accentDark }, choiceText: { color: t.muted, fontSize: 12 },
  disabled: { opacity: 0.45 },
  heading: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' }, device: { flexDirection: 'row', alignItems: 'center', gap: 9, padding: 13, backgroundColor: t.surface, borderRadius: 12 }, error: { color: t.error, fontSize: 12, lineHeight: 18 },
});
