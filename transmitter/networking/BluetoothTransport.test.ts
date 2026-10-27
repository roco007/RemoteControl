import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope } from '../../shared/protocol';
import type { BleBridge } from '../modules/bluetooth-transport';
import { BluetoothTransport } from './BluetoothTransport';
async function tick() { for (let i = 0; i < 12; i++) await Promise.resolve(); }
function setup() {
  const events = new Map<string, Set<(event: any) => void>>();
  let connected!: () => void;
  const sent: string[] = []; const drains: (() => void)[] = [];
  const bridge = {
    startScan: async () => {}, stopScan: async () => {},
    connect: vi.fn(() => new Promise<void>(resolve => { connected = resolve; })),
    disconnect: vi.fn(async () => {}),
    send: (data: string) => { sent.push(data); return new Promise<void>(resolve => drains.push(resolve)); },
    addListener: (name: string, callback: (event: any) => void) => { const set = events.get(name) ?? new Set(); set.add(callback); events.set(name, set); return { remove: () => set.delete(callback) }; },
  } as BleBridge;
  const transport = new BluetoothTransport(bridge, 'mac');
  const emit = (name: string, event: any) => events.get(name)?.forEach(callback => callback(event));
  return { transport, bridge, emit, sent, drains, ready: async () => { connected(); await tick(); } };
}
const movement = (seq: number, dx: number, dy = 0) => JSON.stringify(envelope({ type: 'mouse_move', dx, dy }, seq));
beforeEach(() => vi.useFakeTimers()); afterEach(() => vi.useRealTimers());
describe('native Bluetooth transport adapter', () => {
  it('buffers early hello until native encrypted subscription is ready', async () => {
    const { transport, emit, ready } = setup(); const messages: unknown[] = []; transport.onMessage = m => messages.push(m);
    transport.connect(); await tick(); emit('onData', { data: 'hello' });
    expect(messages).toEqual([]); expect(transport.connected).toBe(false);
    await ready(); expect(transport.connected).toBe(true); expect(messages).toEqual(['hello']); transport.disconnect();
  });
  it('coalesces pending movement without crossing a button boundary', async () => {
    const { transport, sent, drains, ready } = setup(); transport.connect(); await tick(); await ready();
    transport.send(movement(1, 1)); transport.send(movement(2, 2)); transport.send(movement(3, 3));
    transport.send(JSON.stringify(envelope({ type: 'mouse_down', button: 'left' }, 4))); transport.send(movement(5, 4));
    expect(sent).toHaveLength(1); drains.shift()!(); await tick();
    expect(JSON.parse(sent[1]!)).toMatchObject({ type: 'mouse_move', seq: 3, dx: 5 });
    drains.shift()!(); await tick(); expect(JSON.parse(sent[2]!).type).toBe('mouse_down');
    drains.shift()!(); await tick(); expect(JSON.parse(sent[3]!)).toMatchObject({ seq: 5, dx: 4 }); transport.disconnect();
  });
  it('does not lose deltas when combining would exceed protocol limits', async () => {
    const { transport, sent, drains, ready } = setup(); transport.connect(); await tick(); await ready();
    transport.send(movement(1, 1)); transport.send(movement(2, 800)); transport.send(movement(3, 800));
    drains.shift()!(); await tick(); drains.shift()!(); await tick();
    expect(sent.map(data => JSON.parse(data).dx)).toEqual([1, 800, 800]); transport.disconnect();
  });
  it('expires delayed input instead of replaying a long queue', async () => {
    const { transport, ready } = setup(); const failure = vi.fn(); transport.onConnectionStateChange = failure;
    transport.connect(); await tick(); await ready(); transport.send(movement(1, 1)); transport.send(movement(2, 2));
    await vi.advanceTimersByTimeAsync(2001); expect(failure).toHaveBeenCalledWith('error', expect.stringMatching(/stale|slow|expired/i)); transport.disconnect();
  });
  it('ignores data and write completion after disconnect', async () => {
    const { transport, ready, emit, drains, sent } = setup(); const listener = vi.fn(); transport.onMessage = listener;
    transport.connect(); await tick(); await ready(); transport.send(movement(1, 1)); transport.send(movement(2, 2));
    transport.disconnect(); drains.shift()!(); emit('onData', { data: 'stale' }); await tick();
    expect(listener).not.toHaveBeenCalled(); expect(sent).toHaveLength(1); expect(transport.bufferedAmount).toBe(0);
  });
  it('cleans up native connection before opening a replacement', async () => {
    const { transport, ready, bridge } = setup(); transport.connect(); await tick(); await ready();
    let closed!: () => void; bridge.disconnect = vi.fn(() => new Promise<void>(resolve => { closed = resolve; }));
    transport.disconnect(); const next = new BluetoothTransport(bridge, 'mac'); next.connect(); await tick();
    expect(bridge.connect).toHaveBeenCalledTimes(1); closed(); await tick(); expect(bridge.connect).toHaveBeenCalledTimes(2); next.disconnect();
  });
  it('keeps a healthy input connection when a separate discovery scan fails', async () => {
    const { transport, ready, emit } = setup(); transport.connect(); await tick(); await ready();
    const change = vi.fn(); transport.onConnectionStateChange = change;
    emit('onError', { message: 'Unable to scan for Macs.' });
    expect(transport.connected).toBe(true); expect(change).not.toHaveBeenCalled(); transport.disconnect();
  });

});
