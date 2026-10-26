import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const pause = ms => new Promise(r => setTimeout(r, ms));
async function eventually(get, predicate, timeout = 6000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    try { const value = await get(); if (predicate(value)) return value; } catch {}
    await pause(40);
  }
  throw new Error('Timed out waiting for native integration state');
}
class Peer {
  seq = 0;
  messages = [];
  constructor(url, options) {
    this.socket = new WebSocket(url, options);
    this.socket.on('message', raw => this.messages.push(JSON.parse(raw.toString())));
    this.socket.on('error', () => {});
  }
  async next(type, predicate = () => true) {
    return eventually(() => {
      const index = this.messages.findIndex(m => m.type === type && predicate(m));
      return index < 0 ? null : this.messages.splice(index, 1)[0];
    }, Boolean);
  }
  send(payload) { const message = { v: 1, seq: ++this.seq, timestamp: Date.now(), ...payload }; this.socket.send(JSON.stringify(message)); return message.seq; }
  close() { this.socket.close(); }
}

test('native WebSocket transport, authentication, input lifecycle and revocation', { timeout: 40_000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'remote-mac-integration-'));
  const statePath = join(dir, 'state.json');
  const harness = spawn(resolve(root, 'receiver/.build/debug/ReceiverIntegrationHarness'), [statePath], { stdio: ['ignore', 'pipe', 'pipe'] });
  const peers = [];
  let harnessError = '';
  let harnessOutput = '';
  harness.stderr.on('data', chunk => { harnessError += chunk.toString(); });
  harness.stdout.on('data', chunk => { harnessOutput += chunk.toString(); });
  const state = async () => JSON.parse(await readFile(statePath, 'utf8'));
  const identity = { deviceId: 'bcdbe353-08f9-4d6f-85b9-2bf6e5f38945', deviceName: 'Disposable integration client' };
  try {
    const ready = await eventually(state, s => s.port > 0);
    assert.equal((await stat(statePath)).mode & 0o777, 0o600);
    const url = `ws://127.0.0.1:${ready.port}`;
    const open = async options => { const peer = new Peer(url, options); peers.push(peer); await peer.next('connection', m => m.state === 'hello'); return peer; };
    await t.test('rejects unapproved browser and lookalike native origins', async () => {
      for (const origin of ['https://unapproved.invalid', 'remote-mac-control://native.evil', 'null']) {
        const socket = new WebSocket(url, { origin });
        const outcome = await new Promise((resolve, reject) => {
          const timer = setTimeout(() => { socket.terminate(); reject(new Error('Origin check timed out')); }, 4000);
          socket.once('open', () => { clearTimeout(timer); socket.close(); resolve('accepted'); });
          socket.once('error', () => { clearTimeout(timer); resolve('rejected'); });
        });
        assert.equal(outcome, 'rejected', `Unexpectedly accepted Origin: ${origin}`);
      }
    });
    await t.test('rejects malformed and unauthenticated input without posting events', async () => {
      const malformed = await open(); malformed.socket.send('{');
      assert.equal((await malformed.next('error')).code, 'malformed_message');
      const unknown = await open(); unknown.send({ type: 'mouse_move', dx: 2, dy: 3 });
      assert.equal((await unknown.next('error')).code, 'authentication_required');
      assert.deepEqual((await state()).actions, []);
    });
    const phone = await open({ origin: 'remote-mac-control://native' });
    let token;
    await t.test('pairs a native app Origin with the current code and blocks input until permission', async () => {
      phone.send({ type: 'authentication', ...identity, code: ready.code === '000000' ? '111111' : '000000' });
      assert.equal((await phone.next('authentication_result')).ok, false);
      phone.send({ type: 'authentication', ...identity, code: (await state()).code });
      const auth = await phone.next('authentication_result');
      assert.equal(auth.ok, true); assert.match(auth.token, /^[a-f0-9]{64}$/); token = auth.token;
      await phone.next('connection', m => m.state === 'permission_required');
      phone.send({ type: 'mouse_move', dx: 4, dy: 5 });
      await phone.next('connection', m => m.state === 'permission_required');
      assert.deepEqual((await state()).actions, []);
      await eventually(state, s => s.trustedDeviceCount === 1);
    });
    await t.test('enforces one controller and heartbeats', async () => {
      const other = await open(); other.send({ type: 'authentication', ...identity, token });
      await other.next('connection', m => m.state === 'busy');
      phone.send({ type: 'ping', id: 'network-check' });
      assert.equal((await phone.next('pong')).id, 'network-check');
    });
    await t.test('dispatches protocol messages to the recording input sink', async () => {
      harness.kill('SIGUSR1');
      await phone.next('connection', m => m.state === 'ready');
      const events = [
        { type: 'mouse_move', dx: 12, dy: -4 }, { type: 'mouse_down', button: 'left' },
        { type: 'mouse_move', dx: 8, dy: 3 }, { type: 'mouse_up', button: 'left' },
        { type: 'mouse_click', button: 'right', count: 2 }, { type: 'mouse_scroll', dx: -3, dy: 20 },
        { type: 'keyboard_down', key: 'command', modifiers: ['command'], repeat: false },
        { type: 'keyboard_down', key: 'c', modifiers: ['command'], repeat: false },
        { type: 'keyboard_up', key: 'c', modifiers: ['command'] },
        { type: 'keyboard_up', key: 'command', modifiers: [] },
        { type: 'keyboard_text', text: 'Hello 👋 नमस्ते' },
        { type: 'mouse_gesture', gesture: 'zoom', amount: 1 },
        { type: 'mouse_gesture', gesture: 'swipe', direction: 'up', fingers: 3 },
      ];
      events.forEach(message => phone.send(message));
      const result = await eventually(state, s => s.actions.length >= 18);
      assert.ok(result.actions.some(a => a.includes('dragging: Optional("left")')));
      assert.ok(result.actions.some(a => a.includes('Hello 👋 नमस्ते')));
      assert.ok(result.actions.some(a => a.includes('clickCount: 2')));
      assert.ok(result.actions.some(a => a.includes('"control"')));
    });
    await t.test('releases held inputs on disconnect', async () => {
      phone.send({ type: 'mouse_down', button: 'left' });
      phone.send({ type: 'keyboard_down', key: 'shift', modifiers: ['shift'], repeat: false });
      phone.send({ type: 'ping', id: 'flush' }); await phone.next('pong'); phone.close();
      const result = await eventually(state, s => s.deviceName === '' && s.actions.at(-1)?.includes('down: false'));
      assert.ok(result.actions.slice(-2).some(a => a.includes('button("left", down: false')));
      assert.ok(result.actions.slice(-2).some(a => a.includes('key("shift", down: false')));
    });
    const resumed = await open(); resumed.send({ type: 'authentication', ...identity, token });
    assert.equal((await resumed.next('authentication_result')).ok, true);
    await resumed.next('connection', m => m.state === 'ready');
    await t.test('permission loss releases input; revocation rejects saved credentials', async () => {
      resumed.send({ type: 'mouse_down', button: 'right' });
      resumed.send({ type: 'ping', id: 'flush' }); await resumed.next('pong');
      harness.kill('SIGUSR1');
      await resumed.next('connection', m => m.state === 'permission_required');
      await eventually(state, s => s.actions.at(-1)?.includes('button("right", down: false'));
      harness.kill('SIGUSR2');
      assert.equal((await resumed.next('error')).code, 'device_revoked');
      await eventually(state, s => s.trustedDeviceCount === 0);
      const revoked = await open(); revoked.send({ type: 'authentication', ...identity, token });
      assert.equal((await revoked.next('authentication_result')).ok, false); revoked.close();
    });
    await t.test('replayed and oversized frames do not crash the listener', async () => {
      const replay = await open(); replay.send({ type: 'ping', id: 'first', seq: 1 }); await replay.next('pong');
      replay.send({ type: 'ping', id: 'replay', seq: 1 }); assert.equal((await replay.next('error')).code, 'replayed_message');
      const huge = await open(); huge.socket.send('x'.repeat(20000));
      await eventually(() => huge.socket.readyState, s => s === WebSocket.CLOSED);
      const healthy = await open(); healthy.send({ type: 'ping', id: 'still-alive' }); assert.equal((await healthy.next('pong')).id, 'still-alive'); healthy.close();
    });
    await t.test('writes command details and rejection reasons to stdout without credentials or composed text', async () => {
      await eventually(() => harnessOutput, output => output.includes('"id":"still-alive"'));
      const logs = harnessOutput.trim().split('\n').map(line => JSON.parse(line));
      const results = new Set(logs.map(log => log.result));
      for (const result of ['authenticated', 'authentication_failed', 'dispatched', 'pong', 'permission_required', 'authentication_required', 'receiver_busy', 'replayed_message', 'malformed_message']) {
        assert.ok(results.has(result), `Missing command result: ${result}`);
      }
      const shortcut = logs.find(log => log.command?.type === 'keyboard_down' && log.command.key === 'c');
      assert.deepEqual(shortcut.command.modifiers, ['command']);
      assert.equal(shortcut.result, 'dispatched');
      const auth = logs.filter(log => log.command?.type === 'authentication');
      assert.ok(auth.some(log => log.command.code === '<redacted>'));
      assert.ok(auth.some(log => log.command.token === '<redacted>'));
      assert.ok(!harnessOutput.includes(token));
      const composed = logs.find(log => log.command?.type === 'keyboard_text');
      assert.equal(composed.command.text, '<redacted>');
      assert.equal(composed.command.textLength, 'Hello 👋 नमस्ते'.length);
      assert.ok(!harnessOutput.includes('Hello 👋 नमस्ते'));
      assert.equal(logs.find(log => log.result === 'malformed_message').command, undefined);
    });
    assert.equal(harnessError, '');
  } finally {
    peers.forEach(peer => peer.socket.terminate());
    harness.kill('SIGTERM');
    await new Promise(resolve => { harness.once('exit', resolve); setTimeout(resolve, 1500).unref(); });
    if (harness.exitCode === null) harness.kill('SIGKILL');
    await rm(dir, { recursive: true, force: true });
  }
});
