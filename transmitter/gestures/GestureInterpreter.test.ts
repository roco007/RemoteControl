import type { ClientPayload } from '../../shared/protocol';
import { describe, expect, it, vi } from 'vitest';
import { GestureInterpreter } from './GestureInterpreter';
import type { Settings } from '../services/settings';

const settings: Settings = { pointerSensitivity: 1.2, scrollSensitivity: 1, naturalScroll: true, tapToClick: true, twoFingerRightClick: true, haptics: true, host: '', port: 9876, transportMode: 'automatic' };
function setup(overrides: Partial<Settings> = {}) {
  const input = { send: vi.fn((_payload: ClientPayload) => true), move: vi.fn(), scroll: vi.fn(), clear: vi.fn(), releaseAll: vi.fn() };
  return { input, gesture: new GestureInterpreter(input, () => ({ ...settings, ...overrides })) };
}
describe('gesture interpretation', () => {
  it('maps tap, double tap and two-finger tap to native clicks', () => {
    const { input, gesture } = setup(); gesture.tap(); gesture.doubleTap(); gesture.rightTap();
    expect(input.send.mock.calls.map(c => c[0])).toEqual([
      { type: 'mouse_click', button: 'left', count: 1 },
      { type: 'mouse_click', button: 'left', count: 2 },
      { type: 'mouse_click', button: 'right', count: 1 },
    ]);
  });
  it('honors tap settings', () => {
    const { input, gesture } = setup({ tapToClick: false, twoFingerRightClick: false });
    gesture.tap(); gesture.doubleTap(); gesture.rightTap(); expect(input.send).not.toHaveBeenCalled();
  });
  it('holds and releases a real left button around relative drag motion', () => {
    const { input, gesture } = setup(); gesture.beginPointer(0, 0); gesture.beginDrag(); gesture.pointer(10, 5, 1, 0, 0); gesture.endDrag(); gesture.endDrag();
    expect(input.move).toHaveBeenCalledWith(12, 6);
    expect(input.send.mock.calls.map(c => c[0])).toEqual([{ type: 'mouse_down', button: 'left' }, { type: 'mouse_up', button: 'left' }]);
  });
  it('rebases when the pointer count changes instead of jumping', () => {
    const { input, gesture } = setup(); gesture.beginPointer(0, 0); gesture.pointer(100, 100, 2, 0, 0); gesture.pointer(105, 105, 1, 0, 0);
    expect(input.move).not.toHaveBeenCalled();
    gesture.pointer(107, 106, 1, 0, 0); expect(input.move).toHaveBeenCalledWith(2.4, 1.2);
  });
  it('supports horizontal and vertical natural scrolling and reversing it', () => {
    const { input, gesture } = setup(); gesture.beginScroll(0, 0); gesture.scroll(5, 9, 2);
    expect(input.scroll).toHaveBeenCalledWith(5, 9);
    const reverse = setup({ naturalScroll: false }); reverse.gesture.beginScroll(0, 0); reverse.gesture.scroll(5, 9, 2);
    expect(reverse.input.scroll).toHaveBeenCalledWith(-5, -9);
  });
  it('keeps page scrolling exclusive to two fingers and rebases after other fingers join or lift', () => {
    const { input, gesture } = setup();
    gesture.beginScroll(0, 0, 2);
    gesture.scroll(5, 6, 2);
    gesture.scroll(100, 100, 3);
    gesture.scroll(104, 108, 3);
    gesture.scroll(40, 40, 2);
    gesture.scroll(43, 42, 2);
    gesture.scroll(50, 50, 1);
    gesture.scroll(60, 60, 4);
    expect(input.scroll.mock.calls).toEqual([[5, 6], [3, 2]]);
  });
  it('discards invalid or discontinuous scroll samples', () => {
    const { input, gesture } = setup();
    gesture.beginScroll(0, 0, 2);
    gesture.scroll(500, 500, 2);
    gesture.scroll(501, 502, 2);
    gesture.scroll(Number.NaN, 503, 2);
    expect(input.scroll).toHaveBeenCalledExactlyOnceWith(1, 2);
  });
  it('uses pinch thresholds for meaningful native zoom and suppresses concurrent scroll', () => {
    const { input, gesture } = setup(); gesture.beginPinch(); gesture.pinch(1.05); expect(input.send).not.toHaveBeenCalled();
    gesture.pinch(1.3); gesture.beginScroll(0, 0); gesture.scroll(20, 30, 2);
    expect(input.send).toHaveBeenCalledWith({ type: 'mouse_gesture', gesture: 'zoom', amount: 1 });
    expect(input.scroll).not.toHaveBeenCalled(); gesture.endPinch();
  });
  it('maps deliberate multi-finger swipes and rejects diagonal noise', () => {
    const { input, gesture } = setup(); gesture.swipe(3, 80, 10); gesture.swipe(4, 2, -70); gesture.swipe(3, 50, 50);
    expect(input.send.mock.calls.map(c => c[0])).toEqual([
      { type: 'mouse_gesture', gesture: 'swipe', direction: 'right', fingers: 3 },
      { type: 'mouse_gesture', gesture: 'swipe', direction: 'up', fingers: 4 },
    ]);
  });
});
