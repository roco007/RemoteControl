import AsyncStorage from '@react-native-async-storage/async-storage';
import { PROTOCOL } from '../../shared/protocol';
import type { BluetoothPeer, TransportMode } from '../networking/Transport';
import type { ConnectionConfiguration } from '../networking/ConnectionManager';

export interface Settings {
  pointerSensitivity: number;
  scrollSensitivity: number;
  naturalScroll: boolean;
  tapToClick: boolean;
  twoFingerRightClick: boolean;
  haptics: boolean;
  host: string;
  port: number;
  transportMode: TransportMode;
  bluetooth?: BluetoothPeer;
}

export const defaultSettings: Settings = {
  pointerSensitivity: 1.2, scrollSensitivity: 1, naturalScroll: true,
  tapToClick: true, twoFingerRightClick: true, haptics: true,
  host: '', port: PROTOCOL.defaultPort, transportMode: 'automatic',
};
const STORAGE_KEY = 'remote-mac.settings.v1';

export function sanitizeSettings(value: unknown): Settings {
  const result = { ...defaultSettings };
  if (!value || typeof value !== 'object') return result;
  const v = value as Record<string, unknown>;
  for (const key of ['pointerSensitivity', 'scrollSensitivity'] as const) {
    const n = v[key];
    if (typeof n === 'number' && Number.isFinite(n)) result[key] = Math.max(0.25, Math.min(3, n));
  }
  for (const key of ['naturalScroll', 'tapToClick', 'twoFingerRightClick', 'haptics'] as const) {
    if (typeof v[key] === 'boolean') result[key] = v[key];
  }
  if (typeof v.host === 'string' && v.host.length <= 253) result.host = v.host;
  if (typeof v.port === 'number' && Number.isInteger(v.port) && v.port > 0 && v.port < 65536) result.port = v.port;
  if (v.transportMode === 'automatic' || v.transportMode === 'wifi' || v.transportMode === 'bluetooth') result.transportMode = v.transportMode;
  if (v.bluetooth && typeof v.bluetooth === 'object') {
    const peer = v.bluetooth as Record<string, unknown>;
    if (typeof peer.id === 'string' && peer.id.length > 0 && peer.id.length <= 128 && typeof peer.name === 'string' && peer.name.length <= 80) {
      result.bluetooth = { id: peer.id, name: peer.name };
      if (typeof peer.serverId === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(peer.serverId)) result.bluetooth.serverId = peer.serverId;
    }
  }
  return result;
}

export function connectionConfiguration(settings: Settings): ConnectionConfiguration {
  return { mode: settings.transportMode, endpoint: settings.host.trim() ? { host: settings.host.trim(), port: settings.port } : undefined, bluetooth: settings.bluetooth };
}

export async function loadSettings(): Promise<Settings> {
  try { const raw = await AsyncStorage.getItem(STORAGE_KEY); return raw ? sanitizeSettings(JSON.parse(raw)) : { ...defaultSettings }; }
  catch { return { ...defaultSettings }; }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
}
