import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({ native: null as null | {
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  requestLocalNetworkAccess: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
} }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => mock.native }));

beforeEach(() => { vi.resetModules(); mock.native = null; });

describe('discovery facade', () => {
  it('reports the genuine Expo Go limitation and leaves manual connections available', async () => {
    const discovery = await import('./index');
    const error = vi.fn();
    const unsubscribe = discovery.subscribeDiscovery(vi.fn(), error);
    expect(discovery.discoveryAvailable).toBe(false);
    discovery.startDiscovery();
    expect(error).toHaveBeenCalledWith(discovery.discoveryUnavailableReason);
    expect(await discovery.requestLocalNetworkAccess()).toBe(true);
    unsubscribe();
  });

  it('passes the central service type to native discovery', async () => {
    mock.native = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
      requestLocalNetworkAccess: vi.fn().mockResolvedValue(true), addListener: vi.fn(() => ({ remove() {} })) };
    const discovery = await import('./index');
    discovery.startDiscovery();
    await Promise.resolve();
    expect(mock.native.start).toHaveBeenCalledWith('_remotemac._tcp');
  });

  it('does not start a scan after stopping while a permission prompt is pending', async () => {
    let grant!: (value: boolean) => void;
    mock.native = { start: vi.fn().mockResolvedValue(undefined), stop: vi.fn().mockResolvedValue(undefined),
      requestLocalNetworkAccess: vi.fn(() => new Promise<boolean>(resolve => { grant = resolve; })), addListener: vi.fn(() => ({ remove() {} })) };
    const discovery = await import('./index');
    discovery.startDiscovery();
    discovery.stopDiscovery();
    grant(true);
    await Promise.resolve();
    expect(mock.native.start).not.toHaveBeenCalled();
    expect(mock.native.stop).toHaveBeenCalledOnce();
  });

  it('reports denied permission instead of silently searching forever', async () => {
    mock.native = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined),
      requestLocalNetworkAccess: vi.fn().mockResolvedValue(false), addListener: vi.fn(() => ({ remove() {} })) };
    const discovery = await import('./index');
    const error = vi.fn();
    discovery.subscribeDiscovery(vi.fn(), error);
    discovery.startDiscovery();
    await Promise.resolve();
    expect(mock.native.start).not.toHaveBeenCalled();
    expect(error.mock.calls[0]?.[0]).toContain('permission was denied');
  });

  it('removes both native listeners when the screen closes', async () => {
    const remove = vi.fn();
    mock.native = { start: vi.fn(), stop: vi.fn().mockResolvedValue(undefined),
      requestLocalNetworkAccess: vi.fn().mockResolvedValue(true), addListener: vi.fn(() => ({ remove })) };
    const discovery = await import('./index');
    discovery.subscribeDiscovery(vi.fn(), vi.fn())();
    expect(remove).toHaveBeenCalledTimes(2);
  });
});
