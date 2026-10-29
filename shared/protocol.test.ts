import { describe, expect, it } from 'vitest';
import fixtures from './fixtures.json';
import { envelope, isMessage, isClientMessage, parseMessage, PROTOCOL } from './protocol';

describe('wire protocol shared conformance fixtures', () => {
  it.each(fixtures.valid.map((message, index) => ({ message, index })))('accepts valid fixture $index ($message.type)', ({ message }) => {
    expect(isMessage(message)).toBe(true);
    expect(parseMessage(JSON.stringify(message))).toEqual(message);
  });
  it.each(fixtures.invalid.map((message, index) => ({ message, index })))('rejects invalid fixture $index', ({ message }) => {
    expect(isMessage(message)).toBe(false);
    expect(parseMessage(JSON.stringify(message))).toBeNull();
  });
  it.each(fixtures.malformed)('rejects malformed JSON %j', raw => expect(parseMessage(raw)).toBeNull());
  it('rejects non-finite deltas and overlong frames', () => {
    expect(isMessage(envelope({ type: 'mouse_move', dx: Infinity, dy: 0 }, 1))).toBe(false);
    expect(parseMessage(' '.repeat(PROTOCOL.maxMessageBytes + 1))).toBeNull();
  });
  it.each(['__proto__', 'constructor', 'toString'])('rejects inherited object names: %s', type => {
    expect(isMessage({ v: 1, type, seq: 1, timestamp: 1 })).toBe(false);
  });
  it.each(PROTOCOL.systemActions)('treats system action %s as client input', action => {
    const parameters = action === 'open_app' ? { action, appId: '/Applications/Test.app' } : action === 'run_command' ? { action, command: 'true' } : action === 'open_url' ? { action, url: 'https://example.com' } : { action };
    expect(isClientMessage(envelope({ type: 'system_action', ...parameters, id: 'operation' }, 1))).toBe(true);
  });
  it.each(['volume', 'brightness'] as const)('accepts fine %s changes as client input', control => {
    for (const steps of [-16, -1, 1, 16]) {
      const message = parseMessage(JSON.stringify({ v: 1, type: 'system_adjust', seq: 1, timestamp: 1, control, steps }));
      expect(message).not.toBeNull();
      expect(message && isClientMessage(message)).toBe(true);
    }
  });
  it.each([0, -17, 17, 0.25, -0.25, true, '1', null, Infinity, NaN])('rejects invalid system adjustment steps %s', steps => {
    expect(isMessage({ v: 1, type: 'system_adjust', seq: 1, timestamp: 1, control: 'volume', steps })).toBe(false);
  });
  it('accepts Photo Booth as an explicit system action and rejects arbitrary app names', () => {
    expect(parseMessage(JSON.stringify({ v: 1, type: 'system_action', seq: 1, timestamp: 1, action: 'photo_booth' }))).not.toBeNull();
    expect(parseMessage(JSON.stringify({ v: 1, type: 'system_action', seq: 1, timestamp: 1, action: 'open_any_app' }))).toBeNull();
  });
  it('wraps a payload without losing physical key state', () => {
    expect(envelope({ type: 'keyboard_down', key: 'c', modifiers: ['command'], repeat: false }, 12, 55)).toEqual({
      v: 1, seq: 12, timestamp: 55, type: 'keyboard_down', key: 'c', modifiers: ['command'], repeat: false,
    });
  });
  it('correlates system action completion without treating a result as client input', () => {
    const request = { v: 1, type: 'system_action', seq: 7, timestamp: 1, action: 'lock', id: 'gesture-operation-7' };
    const result = { v: 1, type: 'system_action_result', seq: 7, timestamp: 2, action: 'lock', id: 'gesture-operation-7', ok: true };
    expect(parseMessage(JSON.stringify(request))).toEqual(request);
    const parsed = parseMessage(JSON.stringify(result));
    expect(parsed).toEqual(result);
    expect(parsed && isClientMessage(parsed)).toBe(false);
  });
  it.each(['', 'x'.repeat(65), null, 123])('rejects invalid action correlation ID %j', id => {
    expect(isMessage({ v: 1, type: 'system_action', seq: 1, timestamp: 1, action: 'lock', id })).toBe(false);
    expect(isMessage({ v: 1, type: 'system_action_result', seq: 1, timestamp: 1, action: 'lock', id, ok: true })).toBe(false);
  });
});
