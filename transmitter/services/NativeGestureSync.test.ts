import { describe, expect, it } from 'vitest';
import type { GestureConfiguration, GestureStatus } from '../modules/gesture-service';
import { NativeGestureSync } from './NativeGestureSync';

function status(enabled: boolean | null, revision: number, background = false): GestureStatus {
  return { controlEnabled: enabled, controlRevision: revision, controlBackground: background,
    enabled: enabled === true, listening: false, background, appActive: false,
    connection: 'disconnected', count: 0, lastCount: 0, lastGesture: '', lastAction: '', message: '', stoppedByUser: enabled === false };
}
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function setup(initial: GestureStatus) {
  let native = initial;
  const configs: GestureConfiguration[] = [];
  const rendered: { enabled: boolean | null; background: boolean }[] = [];
  let settings = { enabled: true, background: false };
  const bridge = {
    getStatus: async () => native,
    setEnabled: async (enabled: boolean) => { native = status(enabled, native.controlRevision + 1, native.controlBackground); return native; },
    setBackgroundEnabled: async (background: boolean) => { native = status(native.controlEnabled, native.controlRevision + 1, background); return native; },
    configure: async (json: string) => {
      const config = JSON.parse(json) as GestureConfiguration;
      configs.push(config);
      if (config.controlRevision !== native.controlRevision) return native;
      if (native.controlEnabled === null) native = status(config.enabled, native.controlRevision + 1, config.controlBackground ?? config.background);
      return native;
    },
  };
  const sync = new NativeGestureSync(bridge, { onStatus: () => {}, onControl: next => { rendered.push(next); settings = { enabled: next.enabled ?? settings.enabled, background: next.background }; }, onReady: () => {} });
  const config = (): GestureConfiguration => ({ ...settings, controlBackground: settings.background, controlRevision: -1,
    mode: 'count', mappings: { single: 'screenshot', double: 'lock', triple: 'none', right: 'none', left: 'none', left_straight: 'none', right_straight: 'none' },
    foregroundReady: false, host: 'mac.local', port: 9876, serverId: 'mac', token: 'token', deviceId: 'phone', deviceName: 'Phone' });
  return { sync, bridge, configs, rendered, config, widget: (enabled: boolean, background = true) => { native = status(enabled, native.controlRevision + 1, background); return native; } };
}

describe('native gesture control synchronization', () => {
  it.each([true, false])('rehydrates widget %s before configuring stale app settings', async enabled => {
    const { sync, rendered, config, configs } = setup(status(enabled, 7, true));
    await sync.refresh();
    expect(rendered).toEqual([]);
    sync.setLoaded(true);
    await sync.configure(async () => ({ ...config(), enabled: !enabled }));
    expect(rendered[0]).toEqual({ enabled, background: true });
    expect(configs[0]?.enabled).toBe(enabled);
    expect(configs[0]?.controlRevision).toBe(7);
    expect(configs[0]?.background).toBe(true);
  });
  it('restores an explicit background choice before a master switch has been initialized', async () => {
    const { sync, rendered } = setup(status(null, 1, false));
    sync.setLoaded(true); await sync.refresh();
    expect(rendered.at(-1)).toEqual({ enabled: null, background: false });
  });
  it('waits for native status before sending configuration', async () => {
    const { sync, configs, config } = setup(status(false, 4));
    sync.setLoaded(true);
    await sync.configure(async () => config());
    expect(configs).toEqual([]);
  });
  it('saves a disabled profile on upgrade before the widget has ever been used', async () => {
    const { sync, configs, config } = setup(status(null, 0));
    sync.setLoaded(true); await sync.refresh();
    await sync.configure(async () => ({ ...config(), enabled: false }));
    expect(configs[0]).toMatchObject({ enabled: false, serverId: 'mac', token: 'token' });
  });
  it('discards a token lookup when a widget toggle arrives during the lookup', async () => {
    const { sync, configs, config, widget, rendered } = setup(status(true, 4));
    sync.setLoaded(true); await sync.refresh();
    const lookup = deferred<GestureConfiguration>();
    const pending = sync.configure(() => lookup.promise);
    sync.receive(widget(false));
    lookup.resolve(config()); await pending;
    expect(configs).toEqual([]);
    expect(rendered.at(-1)).toEqual({ enabled: false, background: true });
  });
  it('ignores an old foreground status response after a newer widget event', async () => {
    const { sync, bridge, widget, rendered } = setup(status(true, 2));
    sync.setLoaded(true); await sync.refresh();
    const read = deferred<GestureStatus>(); bridge.getStatus = () => read.promise;
    const refresh = sync.refresh();
    sync.receive(widget(false));
    read.resolve(status(true, 2)); await refresh;
    expect(rendered.at(-1)).toEqual({ enabled: false, background: true });
    expect(sync.revision).toBe(3);
  });
  it('lets an explicit app toggle win over older native events and configure snapshots', async () => {
    const { sync, bridge, rendered, config, configs } = setup(status(false, 2));
    sync.setLoaded(true); await sync.refresh();
    const change = deferred<GestureStatus>(); bridge.setEnabled = () => change.promise;
    const pending = sync.setEnabled(true);
    sync.receive(status(false, 2));
    await sync.configure(async () => config());
    expect(configs).toEqual([]);
    change.resolve(status(true, 3)); await pending;
    expect(rendered.at(-1)).toEqual({ enabled: true, background: false });
  });
  it('keeps a later widget action when an app toggle reply arrives out of order', async () => {
    const { sync, bridge, rendered } = setup(status(false, 2));
    sync.setLoaded(true); await sync.refresh();
    const change = deferred<GestureStatus>(); bridge.setEnabled = () => change.promise;
    const pending = sync.setEnabled(true);
    sync.receive(status(false, 4, true));
    change.resolve(status(true, 3)); await pending;
    expect(rendered.at(-1)).toEqual({ enabled: false, background: true });
  });
  it('reverts the app switch to native OFF when enabling cannot start safely', async () => {
    const { sync, bridge, rendered } = setup(status(false, 2));
    sync.setLoaded(true); await sync.refresh();
    bridge.setEnabled = async () => ({ ...status(false, 3), message: 'Connect to your Mac to set up gestures.' });
    await sync.setEnabled(true);
    expect(rendered.at(-1)?.enabled).toBe(false);
  });
  it('rereads native state after a rejected toggle and preserves the failure', async () => {
    const { sync, bridge, rendered } = setup(status(false, 2));
    sync.setLoaded(true); await sync.refresh();
    bridge.setEnabled = async () => { throw new Error('Unavailable'); };
    await expect(sync.setEnabled(true)).rejects.toThrow('Unavailable');
    expect(sync.ready).toBe(true);
    expect(rendered.at(-1)?.enabled).toBe(false);
  });
  it('preserves a later app background choice when an older initial configure completes', async () => {
    const { sync, bridge, config, rendered } = setup(status(null, 0));
    sync.setLoaded(true); await sync.refresh();
    const configured = deferred<GestureStatus>(); bridge.configure = () => configured.promise;
    const pendingConfig = sync.configure(async () => ({ ...config(), background: true, controlBackground: true }));
    await Promise.resolve();
    const change = deferred<GestureStatus>(); bridge.setBackgroundEnabled = () => change.promise;
    const pendingChange = sync.setBackgroundEnabled(false);
    sync.receive(status(true, 1, true));
    configured.resolve(status(true, 1, true)); await pendingConfig;
    expect(rendered).toEqual([]);
    change.resolve(status(true, 2, false)); await pendingChange;
    expect(rendered.at(-1)).toEqual({ enabled: true, background: false });
  });
  it('lets a later widget ON override an earlier app background change', async () => {
    const { sync, bridge, rendered } = setup(status(false, 2, true));
    sync.setLoaded(true); await sync.refresh();
    const change = deferred<GestureStatus>(); bridge.setBackgroundEnabled = () => change.promise;
    const pending = sync.setBackgroundEnabled(false);
    sync.receive(status(true, 4, true));
    change.resolve(status(false, 3, false)); await pending;
    expect(rendered.at(-1)).toEqual({ enabled: true, background: true });
  });
  it('retains the background preference while transport eligibility disables background runtime', async () => {
    const { sync, config, configs, rendered } = setup(status(true, 2, true));
    sync.setLoaded(true); await sync.refresh();
    await sync.configure(async () => ({ ...config(), background: false, controlBackground: true }));
    expect(configs[0]?.background).toBe(false);
    expect(rendered.at(-1)).toEqual({ enabled: true, background: true });
    expect(sync.revision).toBe(2);
  });
  it('cancels pending configuration on a local settings change or unmount', async () => {
    const { sync, configs, config } = setup(status(true, 2));
    sync.setLoaded(true); await sync.refresh();
    const lookup = deferred<GestureConfiguration>();
    const pending = sync.configure(() => lookup.promise);
    sync.invalidate(); lookup.resolve(config()); await pending;
    expect(configs).toEqual([]);
  });
  it('lets native reject a config if a widget changed after the final JS check', async () => {
    const { sync, config, widget, rendered } = setup(status(true, 2));
    sync.setLoaded(true); await sync.refresh();
    await sync.configure(async () => { widget(false); return config(); });
    expect(rendered.at(-1)).toEqual({ enabled: false, background: true });
  });
});
