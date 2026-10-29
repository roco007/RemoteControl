import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { GestureStatus, GestureTriggerResult } from '../modules/gesture-service';
import type { Settings } from './settings';
import type { GestureActionStep } from './gestureSettings';

const env = vi.hoisted(() => ({
  cleanups: [] as (() => void)[],
  states: [] as unknown[],
  listeners: new Map<string, (event: unknown) => void>(),
  trigger: vi.fn(),
  bridge: {
    triggerGesture: undefined as ReturnType<typeof vi.fn> | undefined,
    getStatus: vi.fn(), configure: vi.fn(), setEnabled: vi.fn(), setBackgroundEnabled: vi.fn(),
  },
}));
vi.mock('react', () => ({
  // Capture committed state so async status writes remain observable without
  // mounting a native renderer; effects and the real synchronizer still run.
  useState: (initial: unknown) => {
    const index = env.states.length;
    env.states.push(initial);
    return [initial, (next: unknown) => { env.states[index] = typeof next === 'function' ? next(env.states[index]) : next; }];
  },
  useRef: (value: unknown) => ({ current: value }),
  useEffect: (effect: () => (() => void) | undefined) => { const cleanup = effect(); if (cleanup) env.cleanups.push(cleanup); },
}));
vi.mock('react-native', () => ({ AppState: { currentState: 'active', addEventListener: () => ({ remove: vi.fn() }) } }));
vi.mock('../modules/gesture-service', () => ({ gestureBridge: {
  ...env.bridge,
  get triggerGesture() { return env.bridge.triggerGesture; },
  addListener: (name: string, listener: (event: unknown) => void) => {
    env.listeners.set(name, listener);
    return { remove: () => env.listeners.delete(name) };
  },
} }));
vi.mock('./credentials', () => ({ credentials: { getIdentity: vi.fn(), getToken: vi.fn() } }));

import { defaultGestureMappings, sanitizeGestureOrders } from './gestureSettings';
import { useNativeGestures } from './useNativeGestures';

const tick = async () => { for (let index = 0; index < 6; index++) await Promise.resolve(); };
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(yes => { resolve = yes; }); return { promise, resolve }; }
function status(overrides: Partial<GestureStatus> = {}): GestureStatus {
  return {
    controlEnabled: true, controlRevision: 4, controlBackground: false,
    enabled: true, listening: true, background: false, appActive: true, connection: 'foreground',
    count: 0, lastCount: 0, lastGesture: '', lastAction: '', message: '', stoppedByUser: false,
    actionRevision: 1, actionPending: false, actionOwner: null, actionState: 'idle', ...overrides,
  };
}
function settings(): Settings {
  return {
    pointerSensitivity: 1, scrollSensitivity: 1, naturalScroll: true, tapToClick: true,
    twoFingerRightClick: true, haptics: false, shakeActions: true, backgroundGestures: false,
    gestureMode: 'directional', gestureMappings: { ...defaultGestureMappings }, gestureOrders: sanitizeGestureOrders(undefined),
    host: '', port: 9876, transportMode: 'automatic',
  };
}
function mount(initial = settings(), getSettings = vi.fn(() => initial)) {
  const onNativeStatus = vi.fn();
  const onGesture = vi.fn(() => true);
  const hook = useNativeGestures({
    settings: initial, getSettings, loaded: true, connection: { status: 'disconnected' }, paused: false,
    onGesture, onNativeStatus, onNativeControl: vi.fn(), onNativeLifecycle: vi.fn(),
  });
  return { hook, onNativeStatus, onGesture };
}
function unmount() { env.cleanups.splice(0).reverse().forEach(cleanup => cleanup()); }
beforeEach(() => {
  vi.resetAllMocks();
  env.cleanups = []; env.states = []; env.listeners.clear();
  env.bridge.triggerGesture = env.trigger;
  env.bridge.getStatus.mockResolvedValue(status());
  env.trigger.mockResolvedValue({ accepted: true, message: '', status: status() });
});
afterEach(unmount);

it('passes one latest settings snapshot with the current mode and ordered steps to native', async () => {
  const initial = settings();
  let latest = initial;
  const getSettings = vi.fn(() => latest);
  const { hook, onNativeStatus } = mount(initial, getSettings);
  await tick();
  const steps: GestureActionStep[] = [
    { type: 'open_url', target: 'mobile', url: 'https://example.com/first' },
    { type: 'system', action: 'screenshot' },
    { type: 'run_command', command: 'echo finished' },
  ];
  latest = { ...initial, gestureMode: 'count', gestureMappings: { ...initial.gestureMappings, double: steps } };
  getSettings.mockClear(); onNativeStatus.mockClear();
  const accepted = { accepted: true, message: 'Started', status: status({ actionPending: true, actionOwner: 'foreground', actionState: 'running' }) };
  env.trigger.mockResolvedValueOnce(accepted);

  await expect(hook.triggerGesture('double')).resolves.toBe(accepted);

  expect(getSettings).toHaveBeenCalledTimes(1);
  expect(env.trigger).toHaveBeenCalledExactlyOnceWith('double', JSON.stringify({ mode: 'count', steps }));
  expect(env.states[0]).toBe(accepted.status);
  expect(onNativeStatus).toHaveBeenCalledExactlyOnceWith(accepted.status, false);
});

it('keeps newer live status and ownership when an earlier trigger reply arrives late', async () => {
  const response = deferred<GestureTriggerResult>();
  env.trigger.mockReturnValueOnce(response.promise);
  const { hook, onNativeStatus } = mount();
  await tick(); onNativeStatus.mockClear();
  const pending = hook.triggerGesture('right');
  const completed = status({ actionRevision: 3, message: 'Completed', actionPending: false, actionOwner: null, actionState: 'idle' });
  env.listeners.get('onStatus')!(completed);
  const earlier = { accepted: true, message: 'Started', status: status({ actionRevision: 2, actionPending: true, actionOwner: 'foreground', actionState: 'running' }) };

  response.resolve(earlier);
  await expect(pending).resolves.toBe(earlier);

  expect(env.states[0]).toBe(completed);
  expect(onNativeStatus).toHaveBeenCalledExactlyOnceWith(completed, false);
});

it('suppresses late status and ownership writes after unmount', async () => {
  const response = deferred<GestureTriggerResult>();
  env.trigger.mockReturnValueOnce(response.promise);
  const { hook, onNativeStatus } = mount();
  await tick(); onNativeStatus.mockClear();
  const previous = [...env.states];
  const pending = hook.triggerGesture('left');
  unmount();
  const accepted = { accepted: true, message: 'Started', status: status({ actionRevision: 2, actionPending: true, actionOwner: 'background', actionState: 'running' }) };

  response.resolve(accepted);
  await expect(pending).resolves.toBe(accepted);

  expect(env.states).toEqual(previous);
  expect(onNativeStatus).not.toHaveBeenCalled();
  expect(env.listeners.size).toBe(0);
});

it('asks for an updated phone app when the native trigger is missing, without dispatching a fallback', async () => {
  env.bridge.triggerGesture = undefined;
  const { hook, onGesture, onNativeStatus } = mount();
  await tick(); onNativeStatus.mockClear(); env.bridge.getStatus.mockClear();

  await expect(hook.triggerGesture('right')).resolves.toEqual({
    accepted: false, message: 'Install the updated phone app to run actions by tapping a card.',
  });

  expect(env.trigger).not.toHaveBeenCalled();
  expect(onGesture).not.toHaveBeenCalled();
  expect(onNativeStatus).not.toHaveBeenCalled();
  expect(env.bridge.getStatus).not.toHaveBeenCalled();
  expect(env.bridge.configure).not.toHaveBeenCalled();
  expect(env.bridge.setEnabled).not.toHaveBeenCalled();
});
