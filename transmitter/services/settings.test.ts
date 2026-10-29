import { beforeEach, describe, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({ values: new Map<string, string>(), failRead: false }));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: {
    async getItem(key: string) {
      if (storage.failRead) throw new Error('Storage unavailable');
      return storage.values.get(key) ?? null;
    },
    async setItem(key: string, value: string) { storage.values.set(key, value); },
  },
}));

import { loadSettings, sanitizeSettings, saveSettings } from './settings';
import { gestureAction, reorderGesture } from './gestureSettings';

const key = 'remote-mac.settings.v1';

beforeEach(() => { storage.values.clear(); storage.failRead = false; });

describe('saved gesture order settings', () => {
  it('loads previous settings with default card order and their existing action assignments', async () => {
    storage.values.set(key, JSON.stringify({ host: '192.168.0.105', gestureMode: 'directional', gestureMappings: { left: 'lock', right: 'none' } }));
    const settings = await loadSettings();
    expect(settings.gestureOrders).toEqual({ count: ['single', 'double', 'triple'], directional: ['right', 'left', 'left_straight', 'right_straight'] });
    expect(settings.host).toBe('192.168.0.105');
    expect(gestureAction('left', settings.gestureMappings, ['system_actions'])).toBe('lock');
    expect(gestureAction('right', settings.gestureMappings, ['system_actions'])).toBeNull();
  });

  it('sanitizes persisted card orders independently for each mode', async () => {
    storage.values.set(key, JSON.stringify({ gestureOrders: { directional: ['left', 'single', 'left', 'unknown'], count: ['triple', 'right'] } }));
    expect((await loadSettings()).gestureOrders).toEqual({ count: ['triple', 'single', 'double'], directional: ['left', 'right', 'left_straight', 'right_straight'] });
  });

  it('saves and reloads both modes without changing gesture actions', async () => {
    const settings = sanitizeSettings({ gestureMappings: { left: 'lock', right: 'none' } });
    settings.gestureOrders = reorderGesture(reorderGesture(settings.gestureOrders, 'directional', 'left', 0), 'count', 'triple', 1);
    await saveSettings(settings);
    const loaded = await loadSettings();
    expect(loaded.gestureOrders).toEqual({ count: ['single', 'triple', 'double'], directional: ['left', 'right', 'left_straight', 'right_straight'] });
    expect(loaded.gestureMappings).toEqual(settings.gestureMappings);
    loaded.gestureOrders.directional.reverse();
    expect((await loadSettings()).gestureOrders.directional).toEqual(['left', 'right', 'left_straight', 'right_straight']);
  });

  it('round-trips mixed phone and Mac URL steps alongside existing mappings and pairing', async () => {
    const settings = sanitizeSettings({ host: 'my-mac.local', gestureMappings: {
      left: [{ type: 'open_url', target: 'mobile', url: 'https://example.com/phone?a=1#here' },
        { type: 'open_url', target: 'server', url: 'http://my-mac.local:3001/status' },
        { type: 'system', action: 'screenshot' }],
      right: 'none', double: 'lock',
    } });
    await saveSettings(settings);
    const restored = await loadSettings();
    expect(restored.host).toBe('my-mac.local');
    expect(restored.gestureMappings).toEqual(settings.gestureMappings);
    expect(restored.gestureMappings.left).toEqual([
      { type: 'open_url', target: 'mobile', url: 'https://example.com/phone?a=1#here' },
      { type: 'open_url', target: 'server', url: 'http://my-mac.local:3001/status' },
      { type: 'system', action: 'screenshot' },
    ]);
    expect(restored.gestureMappings).toMatchObject({ right: 'none', double: 'lock' });
  });

  it.each(['missing', 'invalid JSON', 'unavailable'] as const)('creates isolated default arrays when storage is %s', async scenario => {
    if (scenario === 'invalid JSON') storage.values.set(key, '{');
    if (scenario === 'unavailable') storage.failRead = true;
    const first = await loadSettings();
    first.gestureOrders.directional.reverse();
    first.gestureOrders.count.reverse();
    const second = await loadSettings();
    expect(second.gestureOrders).toEqual({ count: ['single', 'double', 'triple'], directional: ['right', 'left', 'left_straight', 'right_straight'] });
  });
});

describe('persisted straight gesture migration', () => {
  it('loads and saves legacy names with assigned actions and card order intact', async () => {
    storage.values.set(key, JSON.stringify({ host: 'my-mac.local', shakeActions: false, backgroundGestures: false,
      gestureMappings: { left_right: 'photo_booth', right_left: 'none', triple: 'screenshot' },
      gestureOrders: { directional: ['right_left', 'left', 'left_right', 'right'], count: ['triple', 'double', 'single'] } }));
    const migrated = await loadSettings();
    expect(migrated).toMatchObject({ host: 'my-mac.local', shakeActions: false, backgroundGestures: false,
      gestureMappings: { left_straight: 'photo_booth', right_straight: 'none', triple: 'screenshot' },
      gestureOrders: { directional: ['right_straight', 'left', 'left_straight', 'right'], count: ['triple', 'double', 'single'] } });
    await saveSettings(migrated);
    const persisted = JSON.parse(storage.values.get(key)!);
    expect(persisted.gestureMappings).not.toHaveProperty('left_right');
    expect(persisted.gestureMappings).not.toHaveProperty('right_left');
    expect(persisted.gestureOrders.directional).toEqual(['right_straight', 'left', 'left_straight', 'right']);
    expect(await loadSettings()).toEqual(migrated);
  });
});
