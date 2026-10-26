import { afterEach, describe, expect, it, vi } from 'vitest';
import { PressLifecycle } from './PressLifecycle';
import { KeyboardController } from './KeyboardController';
import type { ClientPayload } from '../../shared/protocol';

afterEach(() => vi.useRealTimers());
function setup() {
  const down = vi.fn(); const up = vi.fn(); let enabled = true;
  const press = new PressLifecycle({ onDown: down, onUp: up, enabled: () => enabled });
  return { press, down, up, disable: () => { enabled = false; press.cancel(); } };
}

describe('physical and accessible input presses', () => {
  it('delivers one physical down/up pair without duplicating its activation', () => {
    const { press, down, up } = setup();
    press.begin(); press.end(); press.activate();
    expect(down).toHaveBeenCalledTimes(1); expect(up).toHaveBeenCalledTimes(1);
  });
  it('synthesizes complete down/up pairs for semantic-only activations', () => {
    const { press, down, up } = setup();
    press.activate({ semantic: true }); press.activate({ semantic: true });
    expect(down).toHaveBeenCalledTimes(2); expect(up).toHaveBeenCalledTimes(2);
  });
  it('deduplicates a physical web click after the release microtask checkpoint', async () => {
    const { press, down, up } = setup();
    press.begin(); press.end({ expectClick: true, timestamp: 100 });
    await Promise.resolve(); press.activate({ timestamp: 101 });
    expect(down).toHaveBeenCalledTimes(1); expect(up).toHaveBeenCalledTimes(1);
    press.activate({ semantic: true, timestamp: 102 });
    expect(down).toHaveBeenCalledTimes(2); expect(up).toHaveBeenCalledTimes(2);
  });
  it('does not consume the next semantic activation after cancellation', () => {
    const { press, down, up } = setup();
    press.begin(); press.cancel(); press.activate({ semantic: true });
    expect(down).toHaveBeenCalledTimes(2); expect(up).toHaveBeenCalledTimes(2);
  });
  it('expires an ended but unactivated native cycle before the next activation', async () => {
    const { press, down, up } = setup();
    press.begin(); press.end(); await Promise.resolve(); press.activate();
    expect(down).toHaveBeenCalledTimes(2); expect(up).toHaveBeenCalledTimes(2);
  });
  it('supports activation before pressOut without premature or duplicate release', () => {
    const { press, down, up } = setup();
    press.begin(); press.activate(); expect(up).not.toHaveBeenCalled(); press.end();
    expect(down).toHaveBeenCalledTimes(1); expect(up).toHaveBeenCalledTimes(1);
  });
  it('cleans up held inputs on disable and blocks subsequent activation', () => {
    const { press, down, up, disable } = setup();
    press.begin(); disable(); press.end(); press.activate({ semantic: true });
    expect(down).toHaveBeenCalledTimes(1); expect(up).toHaveBeenCalledTimes(1);
  });
  it('keeps keyboard repeat alive during a hold and ends it on release', () => {
    vi.useFakeTimers();
    const sent: ClientPayload[] = [];
    const keyboard = new KeyboardController(message => { sent.push(message); return true; });
    const press = new PressLifecycle({ onDown: () => keyboard.press('backspace'), onUp: () => keyboard.release('backspace') });
    press.begin(); vi.advanceTimersByTime(600);
    expect(sent.some(message => message.type === 'keyboard_down' && message.repeat)).toBe(true);
    press.end(); press.activate(); const count = sent.length; vi.advanceTimersByTime(1000);
    expect(sent).toHaveLength(count);
    expect(sent.filter(message => message.type === 'keyboard_up')).toHaveLength(1);
  });
});
