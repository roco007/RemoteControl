import AsyncStorage from '@react-native-async-storage/async-storage';
import { PROTOCOL } from '../../shared/protocol';

export interface Settings {
  pointerSensitivity: number;
  scrollSensitivity: number;
  naturalScroll: boolean;
  tapToClick: boolean;
  twoFingerRightClick: boolean;
  haptics: boolean;
  host: string;
  port: number;
}

export const defaultSettings: Settings = {
  pointerSensitivity: 1.2, scrollSensitivity: 1, naturalScroll: true,
  tapToClick: true, twoFingerRightClick: true, haptics: true,
  host: '', port: PROTOCOL.defaultPort,
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
  return result;
}

export async function loadSettings(): Promise<Settings> {
  try { const raw = await AsyncStorage.getItem(STORAGE_KEY); return raw ? sanitizeSettings(JSON.parse(raw)) : { ...defaultSettings }; }
  catch { return { ...defaultSettings }; }
}

export async function saveSettings(settings: Settings): Promise<void> {
  await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeSettings(settings)));
}
