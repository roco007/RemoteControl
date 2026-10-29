import type { ClientPayload } from '../../shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { KeyboardController } from './KeyboardController';

afterEach(() => vi.useRealTimers());
describe('remote keyboard lifecycle', () => {
  it('sends actual shortcut key down and up with sticky modifier state', () => {
    const send = vi.fn((_payload: ClientPayload) => true); const keyboard = new KeyboardController(send);
    keyboard.toggleModifier('command'); keyboard.press('c'); keyboard.release('c'); keyboard.toggleModifier('command');
    expect(send.mock.calls.map(c => c[0])).toEqual([
      { type: 'keyboard_down', key: 'command', modifiers: ['command'], repeat: false },
      { type: 'keyboard_down', key: 'c', modifiers: ['command'], repeat: false },
      { type: 'keyboard_up', key: 'c', modifiers: ['command'] },
      { type: 'keyboard_up', key: 'command', modifiers: [] },
    ]);
  });
  it('repeats held normal keys, then stops and releases all on cleanup', () => {
    vi.useFakeTimers(); const send = vi.fn((_payload: ClientPayload) => true); const keyboard = new KeyboardController(send);
    keyboard.press('backspace'); vi.advanceTimersByTime(570);
    expect(send.mock.calls.some(c => (c[0] as { repeat?: boolean }).repeat)).toBe(true);
    keyboard.reset(); const count = send.mock.calls.length; vi.advanceTimersByTime(2000);
    expect(send.mock.calls).toHaveLength(count);
    expect(send).toHaveBeenLastCalledWith({ type: 'release_all' });
  });
  it('ignores duplicate down and only emits key up for held keys', () => {
    const send = vi.fn((_payload: ClientPayload) => true); const keyboard = new KeyboardController(send);
    keyboard.press('a'); keyboard.press('a'); keyboard.release('a'); keyboard.release('a');
    expect(send.mock.calls).toHaveLength(2);
  });
  it('sends Unicode only via text mode and releases sticky modifiers first', () => {
    const send = vi.fn((_payload: ClientPayload) => true); const keyboard = new KeyboardController(send);
    keyboard.toggleModifier('shift'); keyboard.text('Hello 👋 नमस्ते');
    expect(send).toHaveBeenLastCalledWith({ type: 'keyboard_text', text: 'Hello 👋 नमस्ते' });
    expect(keyboard.getModifiers()).toEqual([]);
  });
  it('notifies subscribers when externally reset and when caps or modifiers change', () => {
    const keyboard = new KeyboardController(() => true); const listener = vi.fn();
    const unsubscribe = keyboard.subscribe(listener);
    keyboard.toggleModifier('shift'); keyboard.press('caps_lock'); keyboard.release('caps_lock'); keyboard.reset();
    expect(listener).toHaveBeenCalledTimes(3);
    expect(keyboard.getModifiers()).toEqual([]); expect(keyboard.getCapsLock()).toBe(true);
    unsubscribe(); keyboard.toggleModifier('option'); expect(listener).toHaveBeenCalledTimes(3);
  });
  it('executes exact shortcut modifiers then restores the sticky modifier selection', () => {
    const send = vi.fn((_payload: ClientPayload) => true); const keyboard = new KeyboardController(send);
    keyboard.toggleModifier('shift'); keyboard.toggleModifier('option'); send.mockClear();
    keyboard.shortcut('z', ['command']);
    expect(send.mock.calls.map(c => c[0])).toEqual([
      { type: 'release_all' },
      { type: 'keyboard_down', key: 'command', modifiers: ['command'], repeat: false },
      { type: 'keyboard_down', key: 'z', modifiers: ['command'], repeat: false },
      { type: 'keyboard_up', key: 'z', modifiers: ['command'] },
      { type: 'release_all' },
      { type: 'keyboard_down', key: 'shift', modifiers: ['shift'], repeat: false },
      { type: 'keyboard_down', key: 'option', modifiers: ['shift', 'option'], repeat: false },
    ]);
    expect(keyboard.getModifiers()).toEqual(['shift', 'option']); keyboard.reset();
  });
});

describe('alternate character activations', () => {
  function setup() {
    const sent: ClientPayload[] = [];
    const keyboard = new KeyboardController(payload => { sent.push(payload); return true; });
    return { keyboard, sent };
  }

  it('defers a character until a valid tap and sends the base key once', () => {
    const { keyboard, sent } = setup();
    const press = keyboard.characterPress('1');
    expect(sent).toEqual([]);
    press.tap(); press.tap();
    expect(sent).toEqual([
      { type: 'keyboard_down', key: '1', modifiers: [], repeat: false },
      { type: 'keyboard_up', key: '1', modifiers: [] },
    ]);
  });

  it('sends only the shifted character once when a long press wins', () => {
    vi.useFakeTimers();
    const { keyboard, sent } = setup();
    const press = keyboard.characterPress('1');
    press.alternate(); press.tap(); press.alternate();
    vi.advanceTimersByTime(2000);
    expect(sent).toEqual([
      { type: 'keyboard_down', key: '1', modifiers: ['shift'], repeat: false },
      { type: 'keyboard_up', key: '1', modifiers: [] },
    ]);
  });

  it('preserves sticky modifiers without leaving a temporary shift held', () => {
    const { keyboard, sent } = setup();
    keyboard.toggleModifier('command'); sent.length = 0;
    keyboard.characterPress('a').alternate();
    expect(sent).toEqual([
      { type: 'keyboard_down', key: 'a', modifiers: ['command', 'shift'], repeat: false },
      { type: 'keyboard_up', key: 'a', modifiers: ['command'] },
    ]);
    expect(keyboard.getModifiers()).toEqual(['command']);
    keyboard.toggleModifier('shift'); sent.length = 0;
    keyboard.characterPress('slash').alternate();
    expect(sent).toEqual([
      { type: 'keyboard_down', key: 'slash', modifiers: ['command', 'shift'], repeat: false },
      { type: 'keyboard_up', key: 'slash', modifiers: ['command', 'shift'] },
    ]);
    expect(keyboard.getModifiers()).toEqual(['command', 'shift']);
    keyboard.reset();
  });

  it('selects uppercase letters with Caps Lock while retaining the sticky Shift selection', () => {
    const { keyboard, sent } = setup();
    keyboard.press('caps_lock'); keyboard.release('caps_lock'); keyboard.toggleModifier('shift'); sent.length = 0;
    keyboard.characterPress('q').alternate();
    keyboard.characterPress('1').alternate();
    expect(sent).toEqual([
      { type: 'keyboard_down', key: 'q', modifiers: [], repeat: false },
      { type: 'keyboard_up', key: 'q', modifiers: ['shift'] },
      { type: 'keyboard_down', key: '1', modifiers: ['shift'], repeat: false },
      { type: 'keyboard_up', key: '1', modifiers: ['shift'] },
    ]);
    expect(keyboard.getModifiers()).toEqual(['shift']);
    keyboard.reset();
  });

  it('never types after a canceled or reset press, but permits the next new press', () => {
    const { keyboard, sent } = setup();
    const canceled = keyboard.characterPress('1');
    canceled.cancel(); canceled.tap(); canceled.alternate();
    expect(sent).toEqual([]);
    const stale = keyboard.characterPress('2');
    keyboard.reset(); sent.length = 0;
    stale.tap(); stale.alternate();
    expect(sent).toEqual([]);
    keyboard.characterPress('3').tap();
    expect(sent).toEqual([
      { type: 'keyboard_down', key: '3', modifiers: [], repeat: false },
      { type: 'keyboard_up', key: '3', modifiers: [] },
    ]);
  });

  it('keeps a rejected press consumed and never retries it after reconnect', () => {
    const sent: ClientPayload[] = [];
    let connected = false;
    const keyboard = new KeyboardController(payload => { sent.push(payload); return connected; });
    const press = keyboard.characterPress('1');
    press.alternate(); connected = true; press.tap(); press.alternate();
    expect(sent).toEqual([{ type: 'keyboard_down', key: '1', modifiers: ['shift'], repeat: false }]);
  });
});
