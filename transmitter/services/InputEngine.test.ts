import type { ClientPayload } from '../../shared/protocol';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { InputEngine } from './InputEngine';

afterEach(() => vi.useRealTimers());
describe('input coalescing', () => {
  it('coalesces motion without waiting for a React render', () => {
    vi.useFakeTimers();
    const send = vi.fn((_payload: ClientPayload) => true); const engine = new InputEngine(send);
    engine.move(2, 3); engine.move(4, -2);
    expect(send).not.toHaveBeenCalled();
    vi.advanceTimersByTime(17);
    expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'mouse_move', dx: 6, dy: 1 });
    engine.dispose();
  });
  it('flushes movement before button transitions and never replays cleared input', () => {
    vi.useFakeTimers();
    const send = vi.fn((_payload: ClientPayload) => true); const engine = new InputEngine(send);
    engine.move(5, 0); engine.send({ type: 'mouse_down', button: 'left' });
    expect(send.mock.calls.map(c => c[0])).toEqual([{ type: 'mouse_move', dx: 5, dy: 0 }, { type: 'mouse_down', button: 'left' }]);
    engine.move(9, 0); engine.releaseAll(); vi.advanceTimersByTime(100);
    expect(send).toHaveBeenLastCalledWith({ type: 'release_all' });
    expect(send.mock.calls).toHaveLength(3);
  });
  it('limits deltas and discards malformed motion', () => {
    const send = vi.fn((_payload: ClientPayload) => true); const engine = new InputEngine(send);
    engine.move(NaN, 8); engine.move(600, 0); engine.move(600, 0); engine.flush();
    expect(send.mock.calls.map(c => c[0])).toEqual([{ type: 'mouse_move', dx: 1000, dy: 0 }]);
  });
});
