import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope, type ClientMessage, type ServerPayload } from '../../shared/protocol';
import { ConnectionManager } from './ConnectionManager';
import type { Transport, TransportTarget } from './Transport';
import type { CredentialStore } from './types';

const serverId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const endpoint = { host: '192.168.0.105', port: 9876 };
const bluetooth = { id: 'ble-mac', name: 'My Mac', serverId };
class Link implements Transport {
  connected = false; bufferedAmount = 0;
  onMessage?: (raw: unknown) => void;
  onConnectionStateChange?: (state: 'connected' | 'disconnected' | 'error', message?: string) => void;
  sent: ClientMessage[] = [];
  constructor(readonly kind: 'wifi' | 'bluetooth') {}
  connect() { this.connected = true; this.onConnectionStateChange?.('connected'); }
  disconnect() { this.connected = false; }
  send(raw: string) { if (!this.connected) throw Error('closed'); this.sent.push(JSON.parse(raw)); }
  receive(payload: ServerPayload) { this.onMessage?.(JSON.stringify(envelope(payload, 0))); }
  lose() { this.connected = false; this.onConnectionStateChange?.('disconnected'); }
}
async function tick() { for (let n = 0; n < 12; n++) await Promise.resolve(); }
function setup(mode: 'automatic' | 'wifi' | 'bluetooth' = 'automatic') {
  const links: Link[] = [];
  const credentials: CredentialStore = { getIdentity: async () => ({ deviceId, deviceName: 'Phone' }), getToken: async () => 'a'.repeat(64), setToken: async () => {}, removeToken: async () => {} };
  const manager = new ConnectionManager({ credentials, random: () => 0.5, transportFactory: (target: TransportTarget) => { const link = new Link(target.kind); links.push(link); return link; } });
  manager.configure({ mode, endpoint, bluetooth });
  return { manager, links };
}
async function hello(link: Link, id = serverId) { link.receive({ type: 'connection', state: 'hello', serverId: id, name: 'My Mac', permission: true, capabilities: [] }); await tick(); }
async function ready(link: Link) { await hello(link); link.receive({ type: 'authentication_result', ok: true, serverId, permission: true }); await tick(); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('transport selection and failover', () => {
  it('prefers healthy Wi-Fi and sends each physical input once', async () => {
    const { manager, links } = setup(); await manager.connect(); await ready(links[0]!);
    expect(manager.getSnapshot()).toMatchObject({ status: 'connected', transport: 'wifi' });
    manager.send({ type: 'mouse_move', dx: 12, dy: -4 });
    expect(links).toHaveLength(1); expect(links[0]!.sent.filter(m => m.type === 'mouse_move')).toHaveLength(1);
    manager.dispose();
  });
  it('closes lost Wi-Fi before failing over and never replays queued input', async () => {
    const { manager, links } = setup(); await manager.connect(); await ready(links[0]!);
    links[0]!.lose(); expect(manager.send({ type: 'mouse_click', button: 'left', count: 1 })).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect(links[1]!.kind).toBe('bluetooth'); expect(links[0]!.connected).toBe(false);
    await ready(links[1]!); expect(manager.getSnapshot().transport).toBe('bluetooth');
    expect(links[1]!.sent.some(m => m.type === 'mouse_click')).toBe(false); manager.dispose();
  });
  it('falls back when Wi-Fi is unavailable on startup', async () => {
    const { manager, links } = setup(); await manager.connect(); links[0]!.lose();
    await vi.advanceTimersByTimeAsync(500); await ready(links[1]!);
    expect(manager.getSnapshot()).toMatchObject({ status: 'connected', transport: 'bluetooth' }); manager.dispose();
  });
  it('shows disconnection and backs off when neither transport is available', async () => {
    const { manager, links } = setup(); await manager.connect(); links[0]!.lose();
    await vi.advanceTimersByTimeAsync(500); links[1]!.lose();
    expect(manager.getSnapshot().status).toBe('reconnecting');
    expect(manager.send({ type: 'mouse_move', dx: 1, dy: 0 })).toBe(false);
    await vi.advanceTimersByTimeAsync(999); expect(links).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1); expect(links[2]!.kind).toBe('wifi'); manager.dispose();
  });
  it('tries Wi-Fi first when the backup disconnects', async () => {
    const { manager, links } = setup(); await manager.connect(); links[0]!.lose();
    await vi.advanceTimersByTimeAsync(500); await ready(links[1]!); links[1]!.lose();
    await vi.advanceTimersByTimeAsync(500); expect(links[2]!.kind).toBe('wifi'); await ready(links[2]!);
    expect(manager.getSnapshot().transport).toBe('wifi'); manager.dispose();
  });
  it('probes Wi-Fi without authenticating and releases Bluetooth before switching', async () => {
    const { manager, links } = setup(); await manager.connect(); links[0]!.lose();
    await vi.advanceTimersByTimeAsync(500); await ready(links[1]!);
    await vi.advanceTimersByTimeAsync(15_000); const probe = links[2]!;
    expect(probe.kind).toBe('wifi'); expect(probe.sent).toHaveLength(0);
    await hello(probe);
    expect(links[1]!.connected).toBe(false); expect(links[1]!.sent.at(-1)?.type).toBe('release_all');
    expect(probe.sent).toHaveLength(0); expect(probe.connected).toBe(false);
    await tick(); const replacement = links[3]!; expect(replacement.kind).toBe('wifi'); await ready(replacement);
    expect(manager.getSnapshot().transport).toBe('wifi'); manager.dispose();
  });
  it.each(['wifi', 'bluetooth'] as const)('manual %s never tries the other transport', async mode => {
    const { manager, links } = setup(mode); await manager.connect(); links[0]!.lose();
    await vi.advanceTimersByTimeAsync(500); expect(links.map(l => l.kind)).toEqual([mode, mode]); manager.dispose();
  });
  it('stops retries/probes in background and resumes with preferred Wi-Fi', async () => {
    const { manager, links } = setup(); await manager.connect(); await ready(links[0]!);
    manager.setActive(false); await vi.advanceTimersByTimeAsync(60_000); expect(links).toHaveLength(1);
    manager.setActive(true); await tick(); expect(links[1]!.kind).toBe('wifi'); manager.dispose();
  });
  it('never sends a saved token to a different Bluetooth receiver identity', async () => {
    const { manager, links } = setup('bluetooth'); await manager.connect(); await hello(links[0]!, deviceId);
    expect(links[0]!.sent).toHaveLength(0); expect(manager.getSnapshot().status).toBe('error');
    await vi.advanceTimersByTimeAsync(60_000); expect(links).toHaveLength(1); manager.dispose();
  });
  it('disconnect cancels retry and late probe callbacks', async () => {
    const { manager, links } = setup(); await manager.connect(); links[0]!.lose(); manager.disconnect();
    await vi.advanceTimersByTimeAsync(60_000); expect(links).toHaveLength(1); expect(manager.getSnapshot().status).toBe('disconnected'); manager.dispose();
  });
  it('waits for asynchronous Bluetooth shutdown before opening replacement Wi-Fi', async () => {
    const { manager, links } = setup(); await manager.connect(); links[0]!.lose();
    await vi.advanceTimersByTimeAsync(500); await ready(links[1]!);
    let close!: () => void;
    links[1]!.disconnect = () => new Promise<void>(resolve => { close = () => { links[1]!.connected = false; resolve(); }; });
    await vi.advanceTimersByTimeAsync(15_000); await hello(links[2]!);
    expect(links).toHaveLength(3); close(); await tick(); expect(links[3]!.kind).toBe('wifi'); manager.dispose();
  });
  it('keeps retrying the chosen fallback while stale receiver ownership expires', async () => {
    const { manager, links } = setup(); await manager.connect(); await ready(links[0]!); links[0]!.lose();
    await vi.advanceTimersByTimeAsync(500); await hello(links[1]!);
    links[1]!.receive({ type: 'connection', state: 'busy', serverId, name: 'My Mac', permission: true, capabilities: [] });
    await vi.advanceTimersByTimeAsync(1000); expect(links[2]!.kind).toBe('bluetooth'); manager.dispose();
  });
  it('pins automatic Wi-Fi startup to the saved associated Bluetooth Mac', async () => {
    const { manager, links } = setup(); await manager.connect(); await hello(links[0]!, deviceId);
    expect(links[0]!.sent).toHaveLength(0); expect(manager.getSnapshot().status).toBe('error'); manager.dispose();
  });
  it('allows explicit selection of a different Mac without an old pong restoring the pin', async () => {
    const { manager, links } = setup(); await manager.connect(); await ready(links[0]!);
    manager.configure({ mode: 'bluetooth', endpoint, bluetooth: { id: 'other-mac', name: 'Other Mac', serverId: deviceId } });
    links[0]!.receive({ type: 'connection', state: 'ready', serverId, name: 'Old Mac', permission: true, capabilities: [] });
    await manager.connect(); await hello(links[1]!, deviceId);
    expect(links[1]!.sent[0]?.type).toBe('authentication'); manager.dispose();
  });

});
