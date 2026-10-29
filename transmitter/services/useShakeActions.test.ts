import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const env = vi.hoisted(() => ({ cleanups: [] as (() => void)[], lifecycle: undefined as ((state: string) => void) | undefined, samples: [] as ((sample: { x: number; y: number; z: number; timestamp: number }) => void)[], removals: [] as ReturnType<typeof vi.fn>[], state: 'active' }));
vi.mock('react', () => ({ useState: (value: unknown) => [value, vi.fn()], useRef: (value: unknown) => ({ current: value }), useEffect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) env.cleanups.push(cleanup); } }));
vi.mock('react-native', () => ({ Platform: { OS: 'ios' }, AppState: { get currentState() { return env.state; }, addEventListener: (_: string, listener: (state: string) => void) => { env.lifecycle = listener; return { remove: vi.fn() }; } } }));
vi.mock('expo-sensors', () => ({ Accelerometer: { isAvailableAsync: async () => true, requestPermissionsAsync: async () => ({ granted: true }), setUpdateInterval: vi.fn(), addListener: (listener: (sample: { x: number; y: number; z: number; timestamp: number }) => void) => { env.samples.push(listener); const remove = vi.fn(); env.removals.push(remove); return { remove }; } } }));
import { useShakeActions } from './useShakeActions';
const tick = async () => { for (let i = 0; i < 6; i++) await Promise.resolve(); };
beforeEach(() => { vi.useFakeTimers(); env.cleanups = []; env.samples = []; env.removals = []; env.state = 'active'; });
afterEach(() => { env.cleanups.forEach(cleanup => cleanup()); vi.useRealTimers(); });
it('unsubscribes before dispatch and rejects callbacks queued by a previous subscription after restart', async () => {
  let blocked = false;
  const dispatched = vi.fn(() => { expect(env.removals.at(-1)).toHaveBeenCalledTimes(1); blocked = true; return true; });
  useShakeActions({ enabled: true, session: 'mac', isBlocked: () => blocked, onShake: dispatched }); await tick();
  const old = env.samples[0]!;
  old({ x: 3, y: 0, z: 1, timestamp: 0 }); await vi.advanceTimersByTimeAsync(1100);
  expect(dispatched).toHaveBeenCalledTimes(1);
  env.lifecycle?.('active'); await tick(); expect(env.samples).toHaveLength(1);
  blocked = false; env.lifecycle?.('active'); await tick();
  // A fast screenshot acknowledgement does not turn the movement tail into a
  // new gesture: preserve the original detector's one-second debounce.
  await vi.advanceTimersByTimeAsync(999); expect(env.samples).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1); expect(env.samples).toHaveLength(2);
  old({ x: 3, y: 0, z: 1, timestamp: 2 }); await vi.advanceTimersByTimeAsync(1100);
  expect(dispatched).toHaveBeenCalledTimes(1);
  env.samples[1]!({ x: 3, y: 0, z: 1, timestamp: 4 }); await vi.advanceTimersByTimeAsync(1100);
  expect(dispatched).toHaveBeenCalledTimes(2);
});
it('drops an unfinished sequence when backgrounded, without a delayed action on return', async () => {
  const dispatched = vi.fn(() => true);
  useShakeActions({ enabled: true, session: 'mac', isBlocked: () => false, onShake: dispatched }); await tick();
  env.samples[0]!({ x: 3, y: 0, z: 1, timestamp: 0 });
  env.state = 'background'; env.lifecycle?.('background');
  await vi.advanceTimersByTimeAsync(5000);
  env.state = 'active'; env.lifecycle?.('active'); await tick();
  await vi.advanceTimersByTimeAsync(5000); expect(dispatched).not.toHaveBeenCalled();
});
