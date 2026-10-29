import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { envelope, type ClientPayload, type ServerPayload } from '../../shared/protocol';
import { RemoteClient } from './RemoteClient';
import type { CredentialStore, SocketLike } from './types';

const serverId = 'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa';
const deviceId = 'bbbbbbbb-bbbb-4bbb-bbbb-bbbbbbbbbbbb';
const token = 'a'.repeat(64);
async function tick() { for (let i = 0; i < 8; i++) await Promise.resolve(); }
class Socket implements SocketLike {
  readyState = 1; bufferedAmount = 0;
  onopen: (() => void) | null = null; onmessage: ((event: { data: unknown }) => void) | null = null;
  onclose: (() => void) | null = null; onerror: (() => void) | null = null;
  sent: ClientPayload[] = [];
  send(raw: string) { this.sent.push(JSON.parse(raw)); }
  close() { this.readyState = 3; }
  async receive(payload: ServerPayload, seq?: number) {
    const request = payload.type === 'system_action_result' ? [...this.sent].reverse().find(message => (message.type === 'system_action' || message.type === 'system_action_status') && message.id === payload.id && message.action === payload.action) : undefined;
    this.onmessage?.({ data: JSON.stringify(envelope(payload, seq ?? (request as (ClientPayload & { seq: number }) | undefined)?.seq ?? 1)) }); await tick();
  }
}
async function authenticate(socket: Socket, id = serverId, capabilities = ['system_actions', 'action_completion', 'photo_booth']) {
  await socket.receive({ type: 'connection', state: 'hello', serverId: id, name: 'Mac', permission: true, capabilities });
  await socket.receive({ type: 'authentication_result', ok: true, serverId: id, permission: true });
}
async function connected(capabilities?: string[]) {
  const sockets: Socket[] = [];
  const credentials: CredentialStore = { getIdentity: async () => ({ deviceId, deviceName: 'Phone' }), getToken: async () => token, setToken: async () => {}, removeToken: async () => {} };
  const client = new RemoteClient({ credentials, random: () => 0.5, socketFactory: () => { const socket = new Socket(); sockets.push(socket); return socket; } });
  await client.connect({ host: 'mac.local', port: 9876 });
  const socket = sockets[0]!; await authenticate(socket, serverId, capabilities);
  return { client, socket, sockets };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe('completion-tracked system actions', () => {
  it('requires completion capability and refuses untracked action sends', async () => {
    const { client, socket } = await connected(['system_actions']);
    await expect(client.performSystemAction('screenshot', 'missing-completion')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(client.send({ type: 'system_action', action: 'screenshot' })).toBe(false);
    expect(socket.sent.some(message => message.type === 'system_action')).toBe(false); client.dispose();
  });
  it('gates synchronously, ignores mismatched results, and leaves ordinary input available', async () => {
    const { client, socket } = await connected();
    const result = client.performSystemAction('lock', 'operation-a');
    const observed = result.catch(error => error);
    expect(client.getSnapshot().systemAction).toMatchObject({ id: 'operation-a', action: 'lock', state: 'running' });
    await expect(client.performSystemAction('screenshot', 'operation-b')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(socket.sent.filter(message => message.type === 'system_action')).toHaveLength(1);
    expect(client.send({ type: 'mouse_move', dx: 1, dy: 2 })).toBe(true);
    await socket.receive({ type: 'system_action_result', id: 'another-operation', action: 'lock', ok: true });
    await socket.receive({ type: 'system_action_result', id: 'operation-a', action: 'screenshot', ok: true });
    expect(client.getSnapshot().systemAction?.id).toBe('operation-a');
    await socket.receive({ type: 'system_action_result', id: 'operation-a', action: 'lock', ok: true });
    expect(await observed).toMatchObject({ id: 'operation-a', action: 'lock', ok: true });
    expect(client.getSnapshot().systemAction).toBeUndefined();
    await expect(client.performSystemAction('lock', 'operation-a')).rejects.toMatchObject({ delivery: 'not_sent' }); client.dispose();
  });
  it('releases on definitive failure but keeps running and unknown results paused', async () => {
    const { client, socket } = await connected();
    const result = client.performSystemAction('photo_booth', 'operation-a').catch(error => error);
    await socket.receive({ type: 'system_action_result', id: 'operation-a', action: 'photo_booth', ok: false, state: 'running' });
    expect(client.getSnapshot().systemAction?.state).toBe('running');
    await socket.receive({ type: 'system_action_result', id: 'operation-a', action: 'photo_booth', ok: false, state: 'unknown' });
    expect(client.getSnapshot().systemAction?.state).toBe('unknown');
    await socket.receive({ type: 'system_action_result', id: 'operation-a', action: 'photo_booth', ok: false, message: 'Photo Booth could not open.' });
    expect(await result).toMatchObject({ ok: false, message: 'Photo Booth could not open.' });
    expect(client.getSnapshot().systemAction).toBeUndefined(); client.dispose();
  });
  it('queries the same operation after reconnect without replaying it or accepting old-session replies', async () => {
    const { client, socket, sockets } = await connected();
    for (let index = 0; index < 20; index++) client.send({ type: 'mouse_move', dx: 1, dy: 1 });
    const result = client.performSystemAction('kill_app', 'operation-a').catch(error => error);
    const oldHandler = socket.onmessage; socket.onclose?.();
    expect(client.getSnapshot().systemAction?.state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(500);
    const next = sockets[1]!; await authenticate(next);
    expect(next.sent.some(message => message.type === 'system_action')).toBe(false);
    expect(next.sent).toContainEqual(expect.objectContaining({ type: 'system_action_status', id: 'operation-a', action: 'kill_app' }));
    oldHandler?.({ data: JSON.stringify(envelope({ type: 'system_action_result', id: 'operation-a', action: 'kill_app', ok: true }, 10)) });
    await tick(); expect(client.getSnapshot().systemAction).toBeDefined();
    await next.receive({ type: 'system_action_result', id: 'operation-a', action: 'kill_app', ok: true });
    expect(await result).toMatchObject({ ok: true }); client.dispose();
  });
  it('keeps unanswered actions paused and accepts a late exact completion', async () => {
    const { client, socket } = await connected();
    const result = client.performSystemAction('lock', 'operation-a').catch(error => error);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(socket.readyState).toBe(1);
    expect(client.getSnapshot().systemAction?.state).toBe('unknown');
    await expect(client.performSystemAction('lock', 'operation-b')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(socket.sent.filter(message => message.type === 'system_action')).toHaveLength(1);
    await socket.receive({ type: 'system_action_result', id: 'operation-a', action: 'lock', ok: true });
    expect(await result).toMatchObject({ ok: true }); client.dispose();
  });
  it('adopts native operations read-only and resumes only an exact unknown operation', async () => {
    const { client, socket } = await connected();
    const result = client.trackSystemAction('lock', 'native-operation', serverId, deviceId).catch(error => error);
    expect(socket.sent.some(message => message.type === 'system_action')).toBe(false);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'system_action_status', id: 'native-operation', action: 'lock' });
    await socket.receive({ type: 'system_action_result', id: 'native-operation', action: 'lock', ok: false, state: 'running' });
    expect(client.resumeSystemActions('native-operation')).toBe(false);
    await socket.receive({ type: 'system_action_result', id: 'native-operation', action: 'lock', ok: false, state: 'unknown' });
    expect(client.resumeSystemActions('wrong-id')).toBe(false);
    expect(client.resumeSystemActions('native-operation')).toBe(true);
    expect(await result).toMatchObject({ delivery: 'unknown' });
    await socket.receive({ type: 'system_action_result', id: 'native-operation', action: 'lock', ok: true });
    expect(client.getSnapshot().systemAction).toBeUndefined(); client.dispose();
  });
  it('does not reconcile against a different receiver', async () => {
    const { client, sockets } = await connected();
    const result = client.performSystemAction('lock', 'operation-a').catch(error => error);
    await client.connect({ host: 'other.local', port: 9876 }); await authenticate(sockets[1]!, deviceId);
    expect(sockets[1]!.sent.some(message => message.type === 'system_action_status' || message.type === 'system_action')).toBe(false);
    expect(client.getSnapshot().systemAction?.state).toBe('unknown');
    client.resumeSystemActions('operation-a'); await result; client.dispose();
  });
  it('can promote a recovery query overtaken by its original native event exactly once', async () => {
    const { client, socket } = await connected();
    const tracked = client.trackSystemAction('lock', 'native-operation', serverId, deviceId);
    await socket.receive({ type: 'system_action_result', id: 'native-operation', action: 'lock', ok: false, state: 'unknown' });
    const sent = client.performSystemAction('lock', 'native-operation');
    await expect(client.performSystemAction('lock', 'native-operation')).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(socket.sent.filter(message => message.type === 'system_action')).toHaveLength(1);
    await socket.receive({ type: 'system_action_result', id: 'native-operation', action: 'lock', ok: true });
    expect(await tracked).toEqual(await sent); client.dispose();
  });
  it('ignores a pre-dispatch query reply after a recovered token is promoted', async () => {
    const { client, socket } = await connected();
    const result = client.trackSystemAction('lock', 'promoted').catch(error => error);
    const querySeq = (socket.sent.at(-1) as ClientPayload & { seq: number }).seq;
    const dispatched = client.performSystemAction('lock', 'promoted').catch(error => error);
    await socket.receive({ type: 'system_action_result', id: 'promoted', action: 'lock', ok: false, state: 'unknown' }, querySeq);
    expect(client.getSnapshot().systemAction?.state).toBe('running');
    expect(client.resumeSystemActions('promoted')).toBe(false);
    await socket.receive({ type: 'system_action_result', id: 'promoted', action: 'lock', ok: true });
    expect(await result).toEqual(await dispatched); client.dispose();
  });
  it('retains uncertain delivery after a send exception and queries without re-executing', async () => {
    const { client, socket, sockets } = await connected();
    const send = socket.send.bind(socket);
    socket.send = raw => { send(raw); if (JSON.parse(raw).type === 'system_action') throw Error('Write failed after handoff'); };
    const result = client.performSystemAction('lock', 'uncertain-write').catch(error => error);
    expect(client.getSnapshot().systemAction?.state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(500); await authenticate(sockets[1]!);
    expect(sockets[1]!.sent.some(message => message.type === 'system_action')).toBe(false);
    await sockets[1]!.receive({ type: 'system_action_result', id: 'uncertain-write', action: 'lock', ok: true });
    expect(await result).toMatchObject({ ok: true }); client.dispose();
  });
  it('queries completion with Accessibility revoked while normal input remains blocked', async () => {
    const { client, socket } = await connected();
    const result = client.performSystemAction('lock', 'permission-change').catch(error => error);
    await socket.receive({ type: 'connection', state: 'permission_required', serverId, name: 'Mac', permission: false, capabilities: ['system_actions', 'action_completion'] });
    expect(client.send({ type: 'mouse_move', dx: 1, dy: 2 })).toBe(false);
    expect(socket.sent.at(-1)).toMatchObject({ type: 'system_action_status', id: 'permission-change' });
    await socket.receive({ type: 'system_action_result', id: 'permission-change', action: 'lock', ok: false, message: 'Permission required' });
    expect(await result).toMatchObject({ ok: false }); client.dispose();
  });
  it('clears only the exact native-reset token and ignores its old result', async () => {
    const { client, socket } = await connected();
    const old = client.performSystemAction('lock', 'old').catch(error => error);
    expect(client.resumeSystemActions('old')).toBe(false);
    expect(client.resumeSystemActions('other', true)).toBe(false);
    expect(client.resumeSystemActions('old', true)).toBe(true); await old;
    const next = client.performSystemAction('screenshot', 'new').catch(error => error);
    await socket.receive({ type: 'system_action_result', id: 'old', action: 'lock', ok: true });
    expect(client.getSnapshot().systemAction?.id).toBe('new');
    await socket.receive({ type: 'system_action_result', id: 'new', action: 'screenshot', ok: true });
    expect(await next).toMatchObject({ id: 'new' }); client.dispose();
  });
});


describe('installed apps and parameterized actions', () => {
  it('loads correlated catalog pages and keeps Mac identifiers distinct', async () => {
    const { client, socket } = await connected(['system_actions', 'action_completion', 'app_catalog']);
    const apps = client.listInstalledApps();
    const first = socket.sent.at(-1) as { type: string; id: string; cursor?: number };
    expect(first).toMatchObject({ type: 'apps_list' });
    await socket.receive({ type: 'apps_list_result', id: 'unrelated', apps: [{ id: 'wrong', name: 'Wrong' }] });
    await socket.receive({ type: 'apps_list_result', id: first.id, apps: [{ id: '/Applications/Notes.app', name: 'Notes' }], nextCursor: 1 });
    const second = socket.sent.at(-1) as { id: string; cursor?: number };
    expect(second.cursor).toBe(1);
    await socket.receive({ type: 'apps_list_result', id: second.id, apps: [{ id: '/Applications/Mail.app', name: 'Mail' }] });
    expect(await apps).toEqual([{ id: '/Applications/Notes.app', name: 'Notes' }, { id: '/Applications/Mail.app', name: 'Mail' }]);
    client.dispose();
  });
  it('rejects catalog requests on disconnect and capability mismatch', async () => {
    const unsupported = await connected();
    await expect(unsupported.client.listInstalledApps()).rejects.toThrow(/update/i);
    unsupported.client.dispose();
    const { client } = await connected(['app_catalog']);
    const apps = client.listInstalledApps();
    const failure = expect(apps).rejects.toThrow(/connection/i);
    client.disconnect(); await failure; client.dispose();
  });
  it('sends command parameters once and queries completion after reconnect', async () => {
    const { client, socket, sockets } = await connected(['system_actions', 'action_completion', 'run_command']);
    const done = client.performSystemAction('run_command', 'command-1', { command: 'printf "hello\\n"' });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'system_action', action: 'run_command', id: 'command-1', command: 'printf "hello\\n"' });
    socket.onclose?.();
    await vi.advanceTimersByTimeAsync(500);
    await authenticate(sockets[1]!, serverId, ['system_actions', 'action_completion', 'run_command']);
    expect(sockets[1]!.sent.some(message => message.type === 'system_action')).toBe(false);
    await sockets[1]!.receive({ type: 'system_action_result', action: 'run_command', id: 'command-1', ok: true });
    expect(await done).toMatchObject({ ok: true }); client.dispose();
  });
  it('does not send parameterized actions to an older receiver', async () => {
    const { client, socket } = await connected();
    await expect(client.performSystemAction('open_app', 'open-1', { appId: '/Applications/Notes.app' })).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(socket.sent.some(message => message.type === 'system_action')).toBe(false); client.dispose();
  });
});

describe('completion-tracked URL actions', () => {
  it('requires the URL capability without sending the link to older receivers', async () => {
    const { client, socket } = await connected();
    await expect(client.performSystemAction('open_url', 'url-old', { url: 'https://example.com/' })).rejects.toMatchObject({ delivery: 'not_sent' });
    expect(socket.sent.some(message => message.type === 'system_action')).toBe(false);
    client.dispose();
  });
  it('sends an exact correlated URL and reconciles a lost reply without opening it twice', async () => {
    const capabilities = ['system_actions', 'action_completion', 'open_url'];
    const { client, socket, sockets } = await connected(capabilities);
    const url = 'https://example.com/path?a=one%20two&b=3#section';
    const result = client.performSystemAction('open_url', 'url-one', { url });
    expect(socket.sent.at(-1)).toMatchObject({ type: 'system_action', action: 'open_url', id: 'url-one', url });
    socket.onclose?.();
    expect(client.getSnapshot().systemAction?.state).toBe('unknown');
    await vi.advanceTimersByTimeAsync(500);
    await authenticate(sockets[1]!, serverId, capabilities);
    expect(sockets[1]!.sent.some(message => message.type === 'system_action')).toBe(false);
    expect(sockets[1]!.sent).toContainEqual(expect.objectContaining({ type: 'system_action_status', action: 'open_url', id: 'url-one' }));
    await sockets[1]!.receive({ type: 'system_action_result', action: 'open_url', id: 'url-one', ok: true });
    expect(await result).toMatchObject({ ok: true });
    client.dispose();
  });
});
