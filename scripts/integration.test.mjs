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
    await t.test('rejects all shake actions before authentication', async () => {
      for (const action of ['screenshot', 'kill_app', 'lock', 'photo_booth']) {
        const unknown = await open();
        unknown.send({ type: 'system_action', action });
        assert.equal((await unknown.next('error')).code, 'authentication_required');
        await eventually(() => unknown.socket.readyState, value => value === WebSocket.CLOSED);
      }
      assert.deepEqual((await state()).actions, []);
    });
    await t.test('rejects sound and light adjustments before authentication', async () => {
      for (const control of ['volume', 'brightness']) {
        const unknown = await open();
        unknown.send({ type: 'system_adjust', control, steps: 1 });
        assert.equal((await unknown.next('error')).code, 'authentication_required');
        await eventually(() => unknown.socket.readyState, value => value === WebSocket.CLOSED);
      }
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
      for (const action of ['screenshot', 'kill_app', 'lock', 'photo_booth']) {
        phone.send({ type: 'system_action', action });
        await phone.next('connection', m => m.state === 'permission_required');
      }
      for (const control of ['volume', 'brightness']) {
        phone.send({ type: 'system_adjust', control, steps: 1 });
        await phone.next('connection', m => m.state === 'permission_required');
      }
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
      const connection = await phone.next('connection', m => m.state === 'ready');
      assert.ok(connection.capabilities.includes('system_actions'));
      assert.ok(connection.capabilities.includes('photo_booth'));
      assert.ok(connection.capabilities.includes('system_adjust'));
      assert.ok(connection.capabilities.includes('action_completion'));
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
    await t.test('dispatches all shake actions after releasing held input in order', async () => {
      const previousCount = (await state()).actions.length;
      const actions = [['screenshot', 'screenshot'], ['kill_app', 'killApp'], ['lock', 'lock'], ['photo_booth', 'photoBooth']];
      for (const [action] of actions) {
        phone.send({ type: 'mouse_down', button: 'left' });
        phone.send({ type: 'keyboard_down', key: 'shift', modifiers: ['shift'], repeat: false });
        phone.send({ type: 'system_action', action, id: `completion-${action}` });
        const completion = await phone.next('system_action_result', message => message.id === `completion-${action}`);
        assert.equal(completion.action, action);
        assert.equal(completion.ok, true);
        assert.equal(completion.state, undefined);
      }
      phone.send({ type: 'ping', id: 'shake-actions-flushed' });
      await phone.next('pong', message => message.id === 'shake-actions-flushed');
      const result = await eventually(state, s => s.actions.length === previousCount + actions.length * 5);
      const recorded = result.actions.slice(previousCount);
      actions.forEach(([, nativeAction], index) => {
        const group = recorded.slice(index * 5, index * 5 + 5);
        assert.deepEqual(group.slice(0, 4), [
          'button("left", down: true, clickCount: 1)',
          'key("shift", down: true, modifiers: ["shift"], repeating: false)',
          'button("left", down: false, clickCount: 1)',
          'key("shift", down: false, modifiers: [], repeating: false)',
        ]);
        assert.match(group[4], new RegExp(`^system\\((?:.*\\.)?${nativeAction}\\)$`));
      });
    });
    await t.test('dispatches partial sound and light turns with signed steps', async () => {
      const previousCount = (await state()).actions.length;
      const adjustments = [['volume', 2], ['volume', -1], ['brightness', -3], ['brightness', 1]];
      phone.send({ type: 'keyboard_down', key: 'command', modifiers: ['command'], repeat: false });
      for (const [control, steps] of adjustments) phone.send({ type: 'system_adjust', control, steps });
      phone.send({ type: 'ping', id: 'adjustments-flushed' });
      await phone.next('pong', message => message.id === 'adjustments-flushed');
      const result = await eventually(state, s => s.actions.length === previousCount + 6);
      const recorded = result.actions.slice(previousCount);
      assert.deepEqual(recorded.slice(0, 2), [
        'key("command", down: true, modifiers: ["command"], repeating: false)',
        'key("command", down: false, modifiers: [], repeating: false)',
      ]);
      adjustments.forEach(([control, steps], index) => {
        assert.match(recorded[index + 2], new RegExp(`^systemAdjust\\((?:.*\\.)?${control}, steps: ${steps}\\)$`));
      });
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
    await t.test('recovers completed action status after reconnect without executing it again', async () => {
      const count = (await state()).actions.length;
      resumed.send({ type: 'system_action_status', id: 'completion-lock', action: 'lock' });
      const known = await resumed.next('system_action_result', message => message.id === 'completion-lock');
      assert.equal(known.ok, true); assert.equal(known.state, undefined);
      resumed.send({ type: 'system_action_status', id: 'not-recorded', action: 'lock' });
      const unknown = await resumed.next('system_action_result', message => message.id === 'not-recorded');
      assert.equal(unknown.ok, false); assert.equal(unknown.state, 'unknown');
      assert.equal((await state()).actions.length, count);
    });
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
      const systemActions = logs.filter(log => log.command?.type === 'system_action');
      for (const action of ['screenshot', 'kill_app', 'lock', 'photo_booth']) {
        assert.deepEqual(systemActions.filter(log => log.command.action === action).map(log => log.result),
          ['authentication_required', 'permission_required', 'dispatched']);
      }
      const auth = logs.filter(log => log.command?.type === 'authentication');
      const adjustments = logs.filter(log => log.command?.type === 'system_adjust');
      for (const control of ['volume', 'brightness']) {
        assert.deepEqual(adjustments.filter(log => log.command.control === control).map(log => log.result),
          ['authentication_required', 'permission_required', 'dispatched', 'dispatched']);
      }
      assert.deepEqual(adjustments.filter(log => log.result === 'dispatched').map(log => log.command.steps), [2, -1, -3, 1]);
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
