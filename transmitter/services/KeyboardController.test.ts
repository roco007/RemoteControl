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
