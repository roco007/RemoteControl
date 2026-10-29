import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope, type ClientPayload, type ServerPayload } from '../../shared/protocol';
import { RemoteClient } from './RemoteClient';
import { endpointURL } from './endpoint';
import type { CredentialStore, SocketLike } from './types';

const serverId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const token = 'a'.repeat(64);
class Socket implements SocketLike {
  readyState = 1; bufferedAmount = 0;
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  sent: Array<ClientPayload & { seq: number }> = [];
  send(data: string) { this.sent.push(JSON.parse(data)); }
  close() { this.readyState = 3; }
  async receive(message: ServerPayload) { this.onmessage?.({ data: JSON.stringify(envelope(message, 0)) }); await tick(); }
}
async function tick() { for (let i = 0; i < 6; i++) await Promise.resolve(); }
function setup(savedToken: string | null = null) {
  const store: CredentialStore = {
    getIdentity: vi.fn(async () => ({ deviceId, deviceName: 'Test phone' })),
    getToken: vi.fn(async () => savedToken), setToken: vi.fn(async () => {}), removeToken: vi.fn(async () => {}),
  };
  const sockets: Socket[] = [];
  const client = new RemoteClient({ credentials: store, random: () => 0.5, socketFactory: () => { const s = new Socket(); sockets.push(s); return s; } });
  return { client, store, sockets };
}
async function hello(socket: Socket) { await socket.receive({ type: 'connection', state: 'hello', serverId, name: 'My Mac', permission: true, capabilities: [] }); }
async function ready(socket: Socket, permission = true) { await socket.receive({ type: 'authentication_result', ok: true, serverId, permission, token }); }
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('connection and pairing', () => {
  it('gates fine adjustments on receiver support, authentication and permission', async () => {
    const { client, sockets } = setup(token);
    const adjustment: ClientPayload = { type: 'system_adjust', control: 'volume', steps: -2 };
    expect(client.send(adjustment)).toBe(false);
    await client.connect({ host: 'mac.local', port: 9876 });
    const socket = sockets[0]!; await hello(socket); await ready(socket);
    expect(client.send(adjustment)).toBe(false);
    expect(socket.sent.some(message => message.type === 'system_adjust')).toBe(false);
    await socket.receive({ type: 'connection', state: 'ready', serverId, name: 'My Mac', permission: true, capabilities: ['system_adjust'] });
    expect(client.send(adjustment)).toBe(true);
    expect(socket.sent.at(-1)).toMatchObject(adjustment);
    await socket.receive({ type: 'connection', state: 'permission_required', serverId, name: 'My Mac', permission: false, capabilities: ['system_adjust'] });
    expect(client.send(adjustment)).toBe(false);
    await socket.receive({ type: 'connection', state: 'ready', serverId, name: 'My Mac', permission: true, capabilities: [] });
    expect(client.send(adjustment)).toBe(false);
    client.dispose();
  });
  it('requires tracked dispatch even when receivers advertise system actions', async () => {
    const { client, sockets } = setup(token);
    await client.connect({ host: 'mac.local', port: 9876 });
    const socket = sockets[0]!; await hello(socket); await ready(socket);
    expect(client.send({ type: 'system_action', action: 'kill_app' })).toBe(false);
    expect(socket.sent.some(message => message.type === 'system_action')).toBe(false);
    await socket.receive({ type: 'connection', state: 'ready', serverId, name: 'My Mac', permission: true, capabilities: ['system_actions'] });
    expect(client.send({ type: 'system_action', action: 'screenshot' })).toBe(false);
    await expect(client.performSystemAction('screenshot', 'unsupported')).rejects.toMatchObject({ delivery: 'not_sent' });
    client.disconnect();
    expect(client.send({ type: 'system_action', action: 'lock' })).toBe(false);
    client.dispose();
  });
  it('exposes receiver capabilities and clears them before connecting to another receiver', async () => {
    const { client, sockets } = setup(token);
    await client.connect({ host: 'mac.local', port: 9876 });
    await sockets[0]!.receive({ type: 'connection', state: 'hello', serverId, name: 'My Mac', permission: true, capabilities: ['system_actions'] });
    await ready(sockets[0]!);
    expect(client.getSnapshot().capabilities).toEqual(['system_actions']);
    await client.connect({ host: 'other.local', port: 9876 });
    expect(client.getSnapshot().capabilities).toEqual([]);
    await hello(sockets[1]!); await ready(sockets[1]!);
    expect(client.getSnapshot().capabilities).toEqual([]);
    client.dispose();
  });
  it('requires authentication before input and securely stores a successful token', async () => {
    const { client, sockets, store } = setup(); await client.connect({ host: 'mac.local', port: 9876 }); const socket = sockets[0]!;
    expect(client.send({ type: 'mouse_move', dx: 1, dy: 1 })).toBe(false);
    await hello(socket); expect(client.getSnapshot().status).toBe('authentication_required');
    expect(client.pair('bad')).toBe(false); expect(client.pair('123456')).toBe(true);
    expect(socket.sent[0]).toMatchObject({ type: 'authentication', code: '123456', deviceId });
    await ready(socket);
    expect(store.setToken).toHaveBeenCalledWith(serverId, token);
    expect(client.getSnapshot().status).toBe('connected');
    expect(client.send({ type: 'mouse_move', dx: 1, dy: 2 })).toBe(true);
    client.dispose(); expect(socket.sent.at(-1)?.type).toBe('release_all');
  });
  it('uses a per-server token and drops it when revoked', async () => {
    const { client, sockets, store } = setup(token); await client.connect({ host: 'mac.local', port: 9876 }); const socket = sockets[0]!; await hello(socket);
    expect(store.getToken).toHaveBeenCalledWith(serverId);
    expect(socket.sent[0]).toMatchObject({ type: 'authentication', token });
    await socket.receive({ type: 'authentication_result', ok: false, serverId, permission: true, error: 'Token revoked.' });
    expect(store.removeToken).toHaveBeenCalledWith(serverId);
    expect(client.getSnapshot()).toMatchObject({ status: 'authentication_required', message: 'Token revoked.' });
    client.dispose();
  });
  it('keeps saved-token reconnect out of pairing UI and blocks manual pairing during lookup', async () => {
    const { client, sockets, store } = setup(token);
    let finishLookup!: (value: string | null) => void;
    store.getToken = () => new Promise<string | null>(resolve => { finishLookup = resolve; });
    const statuses: string[] = []; client.subscribe(() => statuses.push(client.getSnapshot().status));
    await client.connect({ host: 'localhost', port: 9876 }); const socket = sockets[0]!; await hello(socket);
    expect(client.getSnapshot().status).toBe('connecting');
    expect(client.pair('123456')).toBe(false); expect(socket.sent).toHaveLength(0);
    finishLookup(token); await tick();
    expect(socket.sent.filter(message => message.type === 'authentication')).toHaveLength(1);
    expect(client.getSnapshot().status).toBe('connecting');
    await ready(socket);
    expect(statuses).not.toContain('authentication_required');
    expect(client.getSnapshot().status).toBe('connected'); client.dispose();
  });
  it('blocks input while permission is missing and recovers on a permission update', async () => {
    const { client, sockets } = setup(token); await client.connect({ host: 'mac.local', port: 9876 }); const socket = sockets[0]!; await hello(socket); await ready(socket, false);
    expect(client.getSnapshot().status).toBe('permission_required');
    expect(client.send({ type: 'keyboard_text', text: 'unsafe' })).toBe(false);
    await socket.receive({ type: 'connection', state: 'ready', serverId, name: 'My Mac', permission: true, capabilities: [] });
    expect(client.getSnapshot().status).toBe('connected'); client.dispose();
  });
  it('keeps permission updates received while the token is being persisted', async () => {
    const { client, sockets, store } = setup(token);
    let finishStorage!: () => void;
    store.setToken = () => new Promise<void>(resolve => { finishStorage = resolve; });
    await client.connect({ host: 'localhost', port: 9876 }); const socket = sockets[0]!; await hello(socket);
    await ready(socket);
    await socket.receive({ type: 'connection', state: 'permission_required', serverId, name: 'My Mac', permission: false, capabilities: [] });
    finishStorage(); await tick();
    expect(client.getSnapshot().status).toBe('permission_required'); client.dispose();
  });
  it('clears revoked credentials and does not automatically reconnect', async () => {
    const { client, sockets, store } = setup(token); await client.connect({ host: 'localhost', port: 9876 });
    const socket = sockets[0]!; await hello(socket); await ready(socket);
    await socket.receive({ type: 'error', code: 'device_revoked', message: 'Pair again.' });
    expect(store.removeToken).toHaveBeenCalledWith(serverId); expect(client.getSnapshot().status).toBe('error');
    await vi.advanceTimersByTimeAsync(60_000); expect(sockets).toHaveLength(1); client.dispose();
  });
  it('does not accept malformed receiver messages', async () => {
    const { client, sockets } = setup(); await client.connect({ host: 'localhost', port: 9876 });
    sockets[0]!.onmessage?.({ data: '{broken' });
    expect(client.getSnapshot().status).toBe('error'); expect(sockets[0]!.readyState).toBe(3); client.dispose();
  });
  it('rejects unsolicited authentication results and times out unanswered pairing', async () => {
    const unsolicited = setup(); await unsolicited.client.connect({ host: 'localhost', port: 9876 });
    await hello(unsolicited.sockets[0]!); await ready(unsolicited.sockets[0]!);
    expect(unsolicited.client.getSnapshot().status).toBe('error');
    unsolicited.client.dispose();
    const pending = setup(); await pending.client.connect({ host: 'localhost', port: 9876 });
    await hello(pending.sockets[0]!); pending.client.pair('123456');
    expect(pending.client.pair('123456')).toBe(false);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(pending.client.getSnapshot()).toMatchObject({ status: 'error', message: 'Pairing timed out. Reconnect and try the current code.' });
    pending.client.dispose();
  });
  it('times out an offline Mac and reconnects with no replayed input', async () => {
    const { client, sockets } = setup(); await client.connect({ host: 'localhost', port: 9876 });
    await vi.advanceTimersByTimeAsync(10_000); expect(client.getSnapshot().status).toBe('reconnecting');
    expect(client.send({ type: 'mouse_click', button: 'left', count: 1 })).toBe(false);
    await vi.advanceTimersByTimeAsync(500); expect(sockets).toHaveLength(2); expect(sockets[1]!.sent).toHaveLength(0); client.dispose();
  });
  it('ignores old sockets and pending credential lookup after disconnect', async () => {
    const { client, sockets } = setup(); await client.connect({ host: 'localhost', port: 9876 }); const oldHandler = sockets[0]!.onmessage;
    client.disconnect();
    oldHandler?.({ data: JSON.stringify(envelope({ type: 'connection', state: 'hello', serverId, name: 'Old Mac', permission: true, capabilities: [] }, 0)) });
    await tick(); expect(client.getSnapshot().status).toBe('disconnected'); expect(sockets[0]!.sent).toHaveLength(0);
  });
  it('releases held input when backgrounded and creates a fresh session on foreground', async () => {
    const { client, sockets } = setup(token); await client.connect({ host: 'localhost', port: 9876 }); const first = sockets[0]!; await hello(first); await ready(first);
    client.setActive(false); expect(first.sent.at(-1)?.type).toBe('release_all'); expect(first.readyState).toBe(3);
    await vi.advanceTimersByTimeAsync(60_000); expect(sockets).toHaveLength(1);
    client.setActive(true); await tick(); expect(sockets).toHaveLength(2); client.dispose();
  });
  it('fails closed on backpressure instead of delaying key releases', async () => {
    const { client, sockets } = setup(token); await client.connect({ host: 'localhost', port: 9876 }); const socket = sockets[0]!; await hello(socket); await ready(socket);
    socket.bufferedAmount = 100_000;
    expect(client.send({ type: 'keyboard_up', key: 'shift', modifiers: [] })).toBe(false);
    expect(socket.readyState).toBe(3); expect(client.getSnapshot().status).toBe('reconnecting'); client.dispose();
  });
  it('uses heartbeat replies to detect latency and timeout dead sessions', async () => {
    const { client, sockets } = setup(token); await client.connect({ host: 'localhost', port: 9876 }); const socket = sockets[0]!; await hello(socket); await ready(socket);
    await vi.advanceTimersByTimeAsync(5_000); const ping = socket.sent.at(-1)!;
    expect(ping.type).toBe('ping');
    await vi.advanceTimersByTimeAsync(20);
    await socket.receive({ type: 'pong', id: (ping as { id: string }).id });
    expect(client.getSnapshot().latencyMs).toBe(20);
    await vi.advanceTimersByTimeAsync(20_000); expect(socket.readyState).toBe(3); client.dispose();
  });
});
describe('endpoint validation', () => {
  it('supports hostname and bracketed IPv6 without allowing URLs or credentials', () => {
    expect(endpointURL({ host: 'My-Mac.local', port: 9876 })).toBe('ws://My-Mac.local:9876');
    expect(endpointURL({ host: '[::1]', port: 9876, secure: true })).toBe('wss://[::1]:9876');
    for (const host of ['http://evil', 'a@b', 'mac/x', 'mac?token=secret', 'mac local']) expect(() => endpointURL({ host, port: 9876 })).toThrow();
    expect(() => endpointURL({ host: 'mac.local', port: -1 })).toThrow();
  });
});
