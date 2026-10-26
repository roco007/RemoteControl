import { describe, expect, it } from 'vitest';
import fixtures from './fixtures.json';
import { envelope, isMessage, parseMessage, PROTOCOL } from './protocol';

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
  it('wraps a payload without losing physical key state', () => {
    expect(envelope({ type: 'keyboard_down', key: 'c', modifiers: ['command'], repeat: false }, 12, 55)).toEqual({
      v: 1, seq: 12, timestamp: 55, type: 'keyboard_down', key: 'c', modifiers: ['command'], repeat: false,
    });
  });
});
