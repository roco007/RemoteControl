import { describe, expect, it, vi } from 'vitest';
import { GestureInterpreter } from './GestureInterpreter';
import { InputEngine } from '../services/InputEngine';
import type { ClientPayload } from '../../shared/protocol';

// Exercise the actual registered callbacks in the native event order. This
// models Android's ACTION_POINTER_UP -> touchesUp -> FAILED sequence, which
// cannot be represented by the pure swipe direction tests.
const { recognizers, makeGesture } = vi.hoisted(() => {
  type Node = { kind: string; config: Record<string, unknown>; handlers: Record<string, (...args: any[]) => void> };
  const recognizers: Node[] = [];
  const makeGesture = (kind: string) => {
    const node: Node = { kind, config: {}, handlers: {} };
    recognizers.push(node);
    const builder: Record<string, unknown> = {};
    return new Proxy(builder, {
      get: (_target, name: string) => (...args: unknown[]) => {
        if (name.startsWith('on')) node.handlers[name] = args[0] as (...args: any[]) => void;
        else node.config[name] = args.length === 1 ? args[0] : args;
        return new Proxy(builder, { get: (_t, next: string) => (...more: unknown[]) => set(next, more) });
      },
    });
    function set(name: string, args: unknown[]): any {
      if (name.startsWith('on')) node.handlers[name] = args[0] as (...args: any[]) => void;
      else node.config[name] = args.length === 1 ? args[0] : args;
      return new Proxy(builder, { get: (_t, next: string) => (...more: unknown[]) => set(next, more) });
    }
  };
  return { recognizers, makeGesture };
});
vi.mock('react-native-gesture-handler', () => ({ Gesture: {
  Pan: () => makeGesture('pan'), Tap: () => makeGesture('tap'), Pinch: () => makeGesture('pinch'),
  Exclusive: (...gestures: unknown[]) => gestures, Simultaneous: (...gestures: unknown[]) => gestures,
} }));
import { createTrackpadGesture } from './createTrackpadGesture';

function setup(fingers: 3 | 4) {
  recognizers.length = 0;
  const interpreter = { swipe: vi.fn(), beginSwipe: vi.fn(), endDrag: vi.fn() } as unknown as GestureInterpreter;
  createTrackpadGesture(interpreter);
  const node = recognizers.find(r => r.kind === 'pan' && r.config.minPointers === fingers)!;
  const fire = (name: string, event: Record<string, unknown> = {}, success?: boolean) => node?.handlers[name]?.(event, success);
  return { interpreter, fire };
}

describe('multi-finger recognizer lifecycle', () => {
  it.each([3, 4] as const)('commits a %i-finger swipe before Android fails on staggered release', fingers => {
    const { interpreter, fire } = setup(fingers);
    fire('onBegin'); fire('onStart', { numberOfPointers: fingers, translationX: 0, translationY: 0 });
    fire('onUpdate', { numberOfPointers: fingers, translationX: 90, translationY: 8 });
    fire('onTouchesUp', { numberOfTouches: fingers - 1 });
    fire('onEnd', { numberOfPointers: fingers - 1, translationX: 999, translationY: 999 }, false);
    fire('onFinalize');
    expect(interpreter.swipe).toHaveBeenCalledExactlyOnceWith(fingers, 90, 8);
  });
  it('commits only once when a normal end also arrives after touchesUp', () => {
    const { interpreter, fire } = setup(4);
    fire('onBegin'); fire('onStart', { numberOfPointers: 4, translationX: 0, translationY: 0 });
    fire('onUpdate', { numberOfPointers: 4, translationX: 0, translationY: -80 });
    fire('onTouchesUp', { numberOfTouches: 3 });
    fire('onEnd', { numberOfPointers: 0, translationX: 0, translationY: -80 }, true);
    expect(interpreter.swipe).toHaveBeenCalledExactlyOnceWith(4, 0, -80);
  });
  it('rejects cancellation and extra fingers instead of treating either as a swipe release', () => {
    for (const cancellation of ['onTouchesCancelled', 'onTouchesDown']) {
      const { interpreter, fire } = setup(4);
      fire('onBegin'); fire('onStart', { numberOfPointers: 4, translationX: 0, translationY: 0 });
      fire('onUpdate', { numberOfPointers: 4, translationX: 90, translationY: 8 });
      fire(cancellation, { numberOfTouches: 5 });
      fire('onTouchesUp', { numberOfTouches: 3 });
      fire('onEnd', { translationX: 90, translationY: 8 }, false);
      expect(interpreter.swipe).not.toHaveBeenCalled();
    }
  });
  it('does not turn a failed unactivated pan into a swipe', () => {
    const { interpreter, fire } = setup(4);
    fire('onBegin'); fire('onTouchesUp', { numberOfTouches: 2 }); fire('onFinalize');
    expect(interpreter.swipe).not.toHaveBeenCalled();
  });
  it('supports platforms with a successful end and resets between gestures', () => {
    const { interpreter, fire } = setup(4);
    for (let attempt = 0; attempt < 2; attempt++) {
      fire('onBegin'); fire('onStart', { numberOfPointers: 4, translationX: 0, translationY: 0 });
      fire('onUpdate', { numberOfPointers: 4, translationX: -90, translationY: 2 });
      fire('onEnd', { numberOfPointers: 0, translationX: -90, translationY: 2 }, true); fire('onFinalize');
    }
    expect(interpreter.swipe).toHaveBeenCalledTimes(2);
  });
});

function setupGestures() {
  recognizers.length = 0;
  const packets: ClientPayload[] = [];
  const engine = new InputEngine(packet => { packets.push(packet); return true; });
  const interpreter = new GestureInterpreter(engine, () => ({
    pointerSensitivity: 1, scrollSensitivity: 1, naturalScroll: true,
    tapToClick: true, twoFingerRightClick: true, haptics: false, host: '', port: 9876,
  }));
  createTrackpadGesture(interpreter);
  const pan = recognizers.find(r => r.kind === 'pan' && r.config.minPointers === 2)!;
  const swipe = recognizers.find(r => r.kind === 'pan' && r.config.minPointers === 3);
  const pinch = recognizers.find(r => r.kind === 'pinch')!;
  const fire = (node: typeof swipe, name: string, event: Record<string, unknown> = {}, success?: boolean) => node?.handlers[name]?.(event, success);
  return { packets, engine, pan, swipe, pinch, fire };
}

describe('two-finger scrolling and three-finger system navigation', () => {
  it('keeps continuous horizontal/vertical page scrolling on two fingers only', () => {
    const { packets, engine, pan, fire } = setupGestures();
    fire(pan, 'onStart', { numberOfPointers: 2, translationX: 10, translationY: 10 });
    fire(pan, 'onUpdate', { numberOfPointers: 2, translationX: 20, translationY: 10 });
    engine.flush();
    fire(pan, 'onUpdate', { numberOfPointers: 2, translationX: 20, translationY: 30 });
    engine.flush();
    fire(pan, 'onUpdate', { numberOfPointers: 3, translationX: 24, translationY: 35 });
    fire(pan, 'onUpdate', { numberOfPointers: 3, translationX: 30, translationY: 40 });
    engine.flush();
    expect(packets).toEqual([{ type: 'mouse_scroll', dx: 10, dy: 0 }, { type: 'mouse_scroll', dx: 0, dy: 20 }]);
    expect(pan.config.maxPointers).toBe(2);
  });

  it.each([
    { dx: -90, dy: 4, direction: 'left' }, { dx: 90, dy: 4, direction: 'right' },
    { dx: 4, dy: -90, direction: 'up' }, { dx: 4, dy: 90, direction: 'down' },
  ])('sends exactly one three-finger $direction navigation gesture on release', ({ dx, dy, direction }) => {
    const { packets, engine, swipe, fire } = setupGestures();
    fire(swipe, 'onBegin');
    fire(swipe, 'onStart', { numberOfPointers: 3, translationX: 0, translationY: 0 });
    fire(swipe, 'onUpdate', { numberOfPointers: 3, translationX: dx, translationY: dy });
    expect(packets).toEqual([]);
    fire(swipe, 'onTouchesUp', { numberOfTouches: 2 });
    fire(swipe, 'onEnd', {}, false);
    fire(swipe, 'onFinalize');
    engine.flush();
    expect(packets).toEqual([{ type: 'mouse_gesture', gesture: 'swipe', direction, fingers: 3 }]);
  });

  it('clears queued two-finger scrolling when a three-finger navigation gesture takes over', () => {
    const { packets, engine, pan, swipe, fire } = setupGestures();
    fire(pan, 'onStart', { numberOfPointers: 2, translationX: 0, translationY: 0 });
    fire(pan, 'onUpdate', { numberOfPointers: 2, translationX: 5, translationY: 7 });
    fire(swipe, 'onBegin');
    fire(swipe, 'onStart', { numberOfPointers: 3, translationX: 0, translationY: 0 });
    fire(swipe, 'onUpdate', { numberOfPointers: 3, translationX: 0, translationY: -90 });
    fire(swipe, 'onTouchesUp', { numberOfTouches: 2 });
    fire(swipe, 'onFinalize');
    engine.flush();
    expect(packets).toEqual([{ type: 'mouse_gesture', gesture: 'swipe', direction: 'up', fingers: 3 }]);
  });

  it('keeps a third-finger pinch block across staggered lift, then allows a fresh two-finger pinch', () => {
    const { packets, engine, swipe, pinch, fire } = setupGestures();
    fire(pinch, 'onStart', { numberOfPointers: 2 });
    fire(pinch, 'onTouchesDown', { numberOfTouches: 3 });
    fire(swipe, 'onBegin');
    fire(swipe, 'onStart', { numberOfPointers: 3, translationX: 0, translationY: 0 });
    fire(pinch, 'onUpdate', { numberOfPointers: 3, scale: 1.4 });
    fire(swipe, 'onUpdate', { numberOfPointers: 3, translationX: 0, translationY: -90 });
    fire(pinch, 'onTouchesUp', { numberOfTouches: 2 });
    fire(pinch, 'onUpdate', { numberOfPointers: 2, scale: 1.6 });
    fire(swipe, 'onTouchesUp', { numberOfTouches: 2 });
    fire(swipe, 'onFinalize');
    engine.flush();
    expect(packets).toEqual([{ type: 'mouse_gesture', gesture: 'swipe', direction: 'up', fingers: 3 }]);
    fire(pinch, 'onFinalize');
    fire(pinch, 'onTouchesDown', { numberOfTouches: 1 });
    fire(pinch, 'onStart', { numberOfPointers: 2 });
    fire(pinch, 'onUpdate', { numberOfPointers: 2, scale: 1.3 });
    expect(packets.at(-1)).toEqual({ type: 'mouse_gesture', gesture: 'zoom', amount: 1 });
  });

  it('preserves pinch cancellation when iOS reports touches before BEGAN', () => {
    const { packets, engine, pinch, fire } = setupGestures();
    fire(pinch, 'onTouchesDown', { numberOfTouches: 3 });
    fire(pinch, 'onBegin');
    fire(pinch, 'onTouchesUp', { numberOfTouches: 2 });
    fire(pinch, 'onStart', { numberOfPointers: 2 });
    fire(pinch, 'onUpdate', { numberOfPointers: 2, scale: 1.4 });
    engine.flush();
    expect(packets).toEqual([]);
  });

  it('does not turn a pre-BEGAN four-finger sequence into a three-finger swipe', () => {
    const { packets, engine, swipe, fire } = setupGestures();
    fire(swipe, 'onTouchesDown', { numberOfTouches: 4 });
    fire(swipe, 'onBegin');
    fire(swipe, 'onStart', { numberOfPointers: 3, translationX: 0, translationY: 0 });
    fire(swipe, 'onUpdate', { numberOfPointers: 3, translationX: 90, translationY: 0 });
    fire(swipe, 'onTouchesUp', { numberOfTouches: 2 });
    fire(swipe, 'onFinalize');
    engine.flush();
    expect(packets).toEqual([]);
  });
});
