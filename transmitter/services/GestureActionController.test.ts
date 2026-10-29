import { describe, expect, it, vi } from 'vitest';
import { GestureActionController, gestureTransportActive, canRunFallbackGesture } from './GestureActionController';
import type { GestureEvent, GestureStatus } from '../modules/gesture-service';
import type { SystemActionCompletion, ConnectionSnapshot } from '../networking/types';
import { SystemActionDispatchError } from '../networking/types';

function deferred<T>() { let resolve!: (value: T) => void; let reject!: (error: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };
const native = (id: string | null = 'op1', owner: 'foreground' | 'background' = 'foreground', state: 'running' | 'unknown' = 'running') => ({ actionPending: !!id, actionOperationId: id, actionName: id ? 'screenshot' : null, actionOwner: id ? owner : null, actionState: id ? state : 'idle', appActive: true }) as GestureStatus;
const event: GestureEvent = { operationId: 'op1', gesture: 'single', count: 1, action: 'screenshot' };
function setup() {
  const result = deferred<SystemActionCompletion>();
  const release = deferred<GestureStatus>();
  let snapshot: ConnectionSnapshot = { status: 'connected' };
  const client = { performSystemAction: vi.fn(() => result.promise), trackSystemAction: vi.fn(() => result.promise), getSnapshot: () => snapshot, resumeSystemActions: vi.fn(() => true) };
  const bridge = { completeGestureAction: vi.fn(() => release.promise), resumeGestureActions: vi.fn(async () => native(null)) };
  const changed = vi.fn(); const controller = new GestureActionController(client, bridge, changed);
  return { controller, client, bridge, result, release, setSnapshot: (next: ConnectionSnapshot) => { snapshot = next; controller.connectionChanged(next); } };
}
describe('gesture action ownership', () => {
  it('status before the original event pauses immediately without adopting or sending twice', async () => {
    const x = setup(); x.controller.receiveNative(native());
    expect(x.controller.getSnapshot().pending).toBe(true);
    expect(x.client.trackSystemAction).not.toHaveBeenCalled();
    expect(x.controller.dispatchNative(event, true)).toBe(true);
    expect(x.controller.dispatchNative(event, true)).toBe(false);
    expect(x.client.performSystemAction).toHaveBeenCalledTimes(1);
    x.result.resolve({ id: 'op1', action: 'screenshot', ok: true }); await tick();
    expect(x.bridge.completeGestureAction).toHaveBeenCalledWith('op1', 'success', null);
    expect(x.controller.getSnapshot().pending).toBe(true);
    x.release.resolve(native(null)); await tick();
    expect(x.controller.getSnapshot().pending).toBe(false);
    x.controller.receiveNative(native());
    expect(x.controller.dispatchNative(event, true)).toBe(false);
  });
  it('recovery adopts read-only, while a late original event is allowed exactly once', () => {
    const x = setup(); x.controller.receiveNative(native(), true);
    expect(x.client.trackSystemAction).toHaveBeenCalledWith('screenshot', 'op1', undefined, undefined);
    expect(x.client.performSystemAction).not.toHaveBeenCalled();
    expect(x.controller.dispatchNative(event, true)).toBe(true);
    expect(x.controller.dispatchNative(event, true)).toBe(false);
    expect(x.client.performSystemAction).toHaveBeenCalledTimes(1);
  });
  it('never adopts or dispatches a background-owned operation and ignores a stale event', () => {
    const x = setup(); x.controller.receiveNative(native('op1', 'background'), true);
    expect(x.client.trackSystemAction).not.toHaveBeenCalled();
    expect(x.controller.dispatchNative(event, true)).toBe(false);
    expect(x.controller.dispatchFallback('screenshot', 'local1')).toBe(false);
    x.controller.receiveNative(native('op2'));
    expect(x.controller.dispatchNative(event, true)).toBe(false);
    expect(x.bridge.completeGestureAction).not.toHaveBeenCalled();
  });
  it('does not dispatch an old native profile event into a different Mac connection', () => {
    const x = setup(); x.setSnapshot({ status: 'connected', serverId: 'new-mac' });
    x.controller.receiveNative({ ...native(), actionServerId: 'old-mac' });
    expect(x.controller.dispatchNative(event, true)).toBe(false);
    expect(x.client.performSystemAction).not.toHaveBeenCalled();
    expect(x.bridge.completeGestureAction).toHaveBeenCalledWith('op1', 'not_sent', expect.any(String));
  });
  it('releases a definitely unsent action but retains uncertain delivery', async () => {
    const x = setup(); x.controller.receiveNative(native()); x.controller.dispatchNative(event, false); await tick();
    expect(x.client.performSystemAction).not.toHaveBeenCalled();
    expect(x.bridge.completeGestureAction).toHaveBeenCalledWith('op1', 'not_sent', expect.any(String));
    const y = setup(); y.controller.receiveNative(native()); y.controller.dispatchNative(event, true);
    y.result.reject(new SystemActionDispatchError('unknown', 'Connection lost')); await tick();
    expect(y.controller.getSnapshot()).toMatchObject({ pending: true, state: 'unknown' });
    expect(y.bridge.completeGestureAction).toHaveBeenCalledWith('op1', 'unknown', 'Connection lost');
  });
  it('keeps paused after a native completion error and retries the terminal acknowledgement on refresh', async () => {
    const x = setup(); x.controller.receiveNative(native()); x.controller.dispatchNative(event, true);
    x.release.reject(Error('bridge failed')); x.result.resolve({ id: 'op1', action: 'screenshot', ok: true }); await tick();
    expect(x.controller.getSnapshot().pending).toBe(true);
    x.bridge.completeGestureAction.mockResolvedValue(native(null));
    x.controller.receiveNative(native(), true); await tick();
    expect(x.controller.getSnapshot().pending).toBe(false);
    expect(x.client.performSystemAction).toHaveBeenCalledTimes(1);
  });
  it('only exposes recovery for unknown, and does not clear a token that became running', async () => {
    const x = setup(); x.controller.receiveNative(native(), true);
    await x.controller.resume(); expect(x.bridge.resumeGestureActions).not.toHaveBeenCalled();
    x.controller.receiveNative(native('op1', 'foreground', 'unknown'));
    x.bridge.resumeGestureActions.mockResolvedValue(native());
    await x.controller.resume(); expect(x.controller.getSnapshot().pending).toBe(true);
    expect(x.client.resumeSystemActions).not.toHaveBeenCalled();
  });
  it('blocks fallback synchronously until completion, preserving independent native and calibration pauses', async () => {
    const result = deferred<SystemActionCompletion>();
    const client = { performSystemAction: vi.fn(() => result.promise), trackSystemAction: vi.fn(() => result.promise), getSnapshot: () => ({ status: 'connected' } as ConnectionSnapshot), resumeSystemActions: vi.fn(() => true) };
    const x = new GestureActionController(client, null, () => {});
    expect(x.dispatchFallback('screenshot', 'local1')).toBe(true);
    expect(x.dispatchFallback('screenshot', 'local2')).toBe(false);
    result.resolve({ id: 'local1', action: 'screenshot', ok: false, message: 'Unavailable' }); await tick();
    expect(x.getSnapshot()).toMatchObject({ pending: false, message: 'Unavailable', completedOperations: 1 });
  });
  it('retains the foreground owner transport in background and defers JS for a background owner', () => {
    expect(gestureTransportActive(false, native('op1'))).toBe(true);
    expect(gestureTransportActive(true, native('op1', 'background'))).toBe(false);
    expect(gestureTransportActive(false, native(null))).toBe(false);
    expect(gestureTransportActive(true, native(null))).toBe(true);
  });
  it('rejects stale native idle before the original event and stale pending after release', async () => {
    const x = setup(); x.controller.receiveNative({ ...native(), actionRevision: 8 });
    expect(x.controller.receiveNative({ ...native(null), actionRevision: 7 }, true)).toBe(false);
    expect(x.controller.dispatchNative(event, true)).toBe(true);
    x.result.resolve({ id: 'op1', action: 'screenshot', ok: true }); await tick();
    x.controller.receiveNative({ ...native(null), actionRevision: 9 });
    expect(x.controller.getSnapshot().pending).toBe(false);
    x.release.resolve({ ...native(), actionRevision: 8 }); await tick();
    expect(x.controller.getSnapshot().pending).toBe(false);
  });
  it('accepts the next native event after release before the old bridge promise resolves', async () => {
    const x = setup(); x.controller.receiveNative({ ...native(), actionRevision: 1 }); x.controller.dispatchNative(event, true);
    x.result.resolve({ id: 'op1', action: 'screenshot', ok: true }); await tick();
    x.controller.receiveNative({ ...native(null), actionRevision: 2 });
    x.controller.receiveNative({ ...native('op2'), actionRevision: 3 });
    x.client.performSystemAction.mockReturnValue(new Promise(() => {}));
    expect(x.controller.dispatchNative({ ...event, operationId: 'op2' }, true)).toBe(true);
    x.release.resolve({ ...native(null), actionRevision: 2 }); await tick();
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, operationId: 'op2' });
  });
  it('uses native recovery confirmation if a late query changes client state meanwhile', async () => {
    const x = setup(); x.controller.receiveNative(native('op1', 'foreground', 'unknown'), true);
    x.controller.receiveNative(native('op1', 'foreground', 'unknown'));
    const reset = deferred<GestureStatus>(); x.bridge.resumeGestureActions.mockReturnValue(reset.promise);
    const resumed = x.controller.resume();
    x.setSnapshot({ status: 'connected', systemAction: { id: 'op1', action: 'screenshot', state: 'running', message: 'Still running' } });
    reset.resolve(native(null)); await resumed;
    expect(x.client.resumeSystemActions).toHaveBeenCalledWith('op1', true);
    expect(x.controller.getSnapshot().pending).toBe(false);
  });
  it('renews a long-running native guard only from fresh receiver confirmations, at a bounded cadence', () => {
    vi.useFakeTimers(); vi.setSystemTime(0);
    try {
      const x = setup(); x.controller.receiveNative(native()); x.controller.dispatchNative(event, true);
      const running = { id: 'op1', action: 'screenshot' as const, state: 'running' as const, message: 'Running' };
      x.setSnapshot({ status: 'connected', systemAction: running });
      expect(x.bridge.completeGestureAction).toHaveBeenCalledTimes(1);
      for (let seconds = 2; seconds <= 80; seconds += 2) {
        vi.setSystemTime(seconds * 1000);
        x.setSnapshot({ status: 'connected', systemAction: { ...running, confirmedAt: seconds * 1000 } });
      }
      expect(x.bridge.completeGestureAction.mock.calls.length).toBeGreaterThanOrEqual(5);
      expect(x.bridge.completeGestureAction.mock.calls.length).toBeLessThanOrEqual(7);
      const calls = x.bridge.completeGestureAction.mock.calls.length;
      vi.setSystemTime(180_000);
      x.setSnapshot({ status: 'connected', latencyMs: 8, systemAction: { ...running, confirmedAt: 80_000 } });
      expect(x.bridge.completeGestureAction).toHaveBeenCalledTimes(calls);
    } finally { vi.useRealTimers(); }
  });
});

describe('gesture action lists', () => {
  it('retains the foreground transport between native batch steps', () => {
    expect(gestureTransportActive(false, { batchPending: true, batchOwner: 'foreground' })).toBe(true);
    expect(gestureTransportActive(true, { batchPending: true, batchOwner: 'background' })).toBe(false);
  });
  it('forwards native app and command parameters without dropping correlation', () => {
    const x = setup();
    x.controller.receiveNative({ ...native(), actionName: 'open_app' });
    expect(x.controller.dispatchNative({ ...event, action: 'open_app', appId: '/Applications/Notes.app' }, true)).toBe(true);
    expect(x.client.performSystemAction).toHaveBeenCalledWith('open_app', 'op1', { appId: '/Applications/Notes.app' });
  });
  it('runs fallback steps in saved order, continues after definite failure, and blocks overlap', async () => {
    const results = [deferred<SystemActionCompletion>(), deferred<SystemActionCompletion>()];
    const requests: { action: string; id: string }[] = [];
    const client = { getSnapshot: () => ({ status: 'connected' } as ConnectionSnapshot), performSystemAction: (action: any, id: string) => { requests.push({ action, id }); return results[requests.length - 1]!.promise; }, trackSystemAction: () => new Promise<SystemActionCompletion>(() => {}), resumeSystemActions: () => true };
    const controller = new GestureActionController(client, null, () => {});
    expect(controller.dispatchFallbackSequence([{ type: 'system', action: 'screenshot' }, { type: 'run_command', command: 'true' }], 'batch')).toBe(true);
    expect(requests.map(r => r.action)).toEqual(['screenshot']);
    expect(controller.dispatchFallback('lock', 'overlap')).toBe(false);
    results[0]!.resolve({ ...requests[0]!, action: 'screenshot', ok: false, message: 'Could not capture' }); await tick();
    expect(requests.map(r => r.action)).toEqual(['screenshot', 'run_command']);
    expect(controller.getSnapshot().pending).toBe(true);
    results[1]!.resolve({ ...requests[1]!, action: 'run_command', ok: true }); await tick();
    expect(controller.getSnapshot()).toMatchObject({ pending: false, state: 'idle' });
    expect(controller.getSnapshot().message).toContain('1 of 2');
  });
  it('drops unsent remainder when an unknown batch is explicitly resumed', async () => {
    const first = deferred<SystemActionCompletion>();
    const client = { getSnapshot: () => ({ status: 'connected' } as ConnectionSnapshot), performSystemAction: vi.fn(() => first.promise), trackSystemAction: () => first.promise, resumeSystemActions: () => true };
    const controller = new GestureActionController(client, null, () => {});
    controller.dispatchFallbackSequence([{ type: 'system', action: 'screenshot' }, { type: 'system', action: 'lock' }], 'batch');
    first.reject(new SystemActionDispatchError('unknown', 'Disconnected')); await tick();
    expect(controller.getSnapshot().state).toBe('unknown');
    await controller.resume();
    expect(client.performSystemAction).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().pending).toBe(false);
  });
});

describe('URL gesture sequences', () => {
  it('forwards the native Mac URL with its original operation ID', () => {
    const x = setup();
    x.controller.receiveNative({ ...native(), actionName: 'open_url' });
    expect(x.controller.dispatchNative({ ...event, action: 'open_url', url: 'https://example.com/path?q=one#two' }, true)).toBe(true);
    expect(x.client.performSystemAction).toHaveBeenCalledWith('open_url', 'op1', { url: 'https://example.com/path?q=one#two' });
  });
  it('opens a phone URL offline without sending it to the Mac and blocks overlap until handoff', async () => {
    const opened = deferred<void>();
    const client = { getSnapshot: () => ({ status: 'disconnected' } as ConnectionSnapshot), performSystemAction: vi.fn(), trackSystemAction: vi.fn(), resumeSystemActions: vi.fn() };
    const openPhoneUrl = vi.fn(() => opened.promise);
    const controller = new GestureActionController(client, null, () => {}, () => {}, openPhoneUrl);
    expect(controller.dispatchFallbackSequence([{ type: 'open_url', target: 'mobile', url: 'https://example.com/' }], 'local-url')).toBe(true);
    expect(controller.getSnapshot().pending).toBe(true);
    expect(controller.dispatchFallbackSequence([{ type: 'system', action: 'lock' }], 'overlap')).toBe(false);
    await tick();
    expect(openPhoneUrl).toHaveBeenCalledWith('https://example.com/');
    expect(client.performSystemAction).not.toHaveBeenCalled();
    opened.resolve(); await tick();
    expect(controller.getSnapshot()).toMatchObject({ pending: false, state: 'idle' });
    expect(controller.getSnapshot().message).toContain('1 of 1 actions completed');
  });
  it('waits for phone URL handoff before sending the next Mac URL', async () => {
    const opened = deferred<void>(), completed = deferred<SystemActionCompletion>();
    const client = { getSnapshot: () => ({ status: 'connected' } as ConnectionSnapshot), performSystemAction: vi.fn(() => completed.promise), trackSystemAction: vi.fn(), resumeSystemActions: vi.fn() };
    const controller = new GestureActionController(client, null, () => {}, () => {}, () => opened.promise);
    controller.dispatchFallbackSequence([{ type: 'open_url', target: 'mobile', url: 'https://example.com/phone' }, { type: 'open_url', target: 'server', url: 'https://example.com/mac' }], 'mixed-url');
    await tick(); expect(client.performSystemAction).not.toHaveBeenCalled();
    opened.resolve(); await tick();
    expect(client.performSystemAction).toHaveBeenCalledWith('open_url', 'mixed-url-2', { url: 'https://example.com/mac' });
    expect(controller.getSnapshot().pending).toBe(true);
    completed.resolve({ id: 'mixed-url-2', action: 'open_url', ok: true }); await tick();
    expect(controller.getSnapshot().message).toContain('2 of 2 actions completed');
  });
  it('continues after a failed phone handoff without exposing the URL from the platform error', async () => {
    const completed = deferred<SystemActionCompletion>();
    const client = { getSnapshot: () => ({ status: 'connected' } as ConnectionSnapshot), performSystemAction: vi.fn(() => completed.promise), trackSystemAction: vi.fn(), resumeSystemActions: vi.fn() };
    const controller = new GestureActionController(client, null, () => {}, () => {}, () => Promise.reject(Error('cannot open https://example.com/?private=secret')));
    controller.dispatchFallbackSequence([{ type: 'open_url', target: 'mobile', url: 'https://example.com/?private=secret' }, { type: 'system', action: 'screenshot' }], 'failed-url');
    await tick();
    expect(client.performSystemAction).toHaveBeenCalledWith('screenshot', 'failed-url-2');
    completed.resolve({ id: 'failed-url-2', action: 'screenshot', ok: true }); await tick();
    expect(controller.getSnapshot().message).toContain('1 of 2 actions completed');
    expect(controller.getSnapshot().message).not.toContain('private');
  });
});


describe('fallback gesture availability', () => {
  it('allows offline local URLs but requires the receiver for Mac-only lists', () => {
    const offline: ConnectionSnapshot = { status: 'disconnected' };
    const local = [{ type: 'open_url' as const, target: 'mobile' as const, url: 'https://example.com/' }];
    expect(canRunFallbackGesture(local, offline, true)).toBe(true);
    expect(canRunFallbackGesture(local, offline, false)).toBe(false);
    expect(canRunFallbackGesture([{ type: 'open_url', target: 'server', url: 'https://example.com/' }], offline, true)).toBe(false);
    expect(canRunFallbackGesture([], { status: 'connected', capabilities: ['system_actions', 'action_completion'] }, true)).toBe(false);
    expect(canRunFallbackGesture([{ type: 'system', action: 'screenshot' }], { status: 'connected', capabilities: ['system_actions', 'action_completion'] }, false)).toBe(true);
  });
});

describe('active gesture presentation', () => {
  it('uses an accepted matching event on older native builds, never sensor history or rejected events', async () => {
    const x = setup();
    x.controller.receiveNative({ ...native(), lastGesture: 'left' });
    expect(x.controller.getSnapshot().activeGesture).toBeNull();
    expect(x.controller.dispatchNative({ ...event, operationId: 'stale', gesture: 'left' }, true)).toBe(false);
    expect(x.controller.getSnapshot().activeGesture).toBeNull();
    expect(x.controller.dispatchNative({ ...event, gesture: 'right' }, true)).toBe(true);
    expect(x.controller.getSnapshot().activeGesture).toBe('right');
    expect(x.controller.dispatchNative({ ...event, gesture: 'left' }, true)).toBe(false);
    x.controller.receiveNative({ ...native(), lastGesture: 'left_straight' });
    expect(x.controller.getSnapshot().activeGesture).toBe('right');
    x.result.resolve({ id: 'op1', action: 'screenshot', ok: true }); await tick();
    x.release.resolve(native(null)); await tick();
    expect(x.controller.getSnapshot()).toMatchObject({ pending: false, activeGesture: null });
    expect(x.controller.receiveNative(native())).toBe(false);
    expect(x.controller.getSnapshot().activeGesture).toBeNull();
  });
  it('does not turn a disallowed dispatch into a displayed execution', () => {
    const x = setup(); x.controller.receiveNative(native());
    expect(x.controller.dispatchNative({ ...event, gesture: 'left' }, false)).toBe(false);
    expect(x.controller.getSnapshot().activeGesture).toBeNull();
    expect(x.client.performSystemAction).not.toHaveBeenCalled();
  });
  it('respects an explicit native null instead of substituting the event gesture', () => {
    const x = setup(); x.controller.receiveNative({ ...native(), activeGesture: null });
    expect(x.controller.dispatchNative({ ...event, gesture: 'left' }, true)).toBe(true);
    expect(x.controller.getSnapshot().activeGesture).toBeNull();
  });
  it('adopts the authoritative native gesture without deriving it from the last sensor reading', () => {
    const x = setup();
    x.controller.receiveNative({ ...native(), activeGesture: 'right_straight', lastGesture: 'left' }, true);
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, state: 'running', activeGesture: 'right_straight' });
    expect(x.client.performSystemAction).not.toHaveBeenCalled();
    const old = setup(); old.controller.receiveNative({ ...native(), lastGesture: 'right_straight' }, true);
    expect(old.controller.getSnapshot().activeGesture).toBeNull();
  });
  it('keeps a native list visible through a local phone step and clears it when the entire list ends', async () => {
    const x = setup();
    x.controller.receiveNative({ ...native(), actionRevision: 1, batchPending: true, activeGesture: 'left_straight' });
    x.controller.dispatchNative({ ...event, gesture: 'left_straight' }, true);
    x.result.resolve({ id: 'op1', action: 'screenshot', ok: true }); await tick();
    const phoneStep = { ...native(null), actionRevision: 2, batchPending: true, batchOwner: 'foreground' as const, activeGesture: 'left_straight' as const };
    x.release.resolve(phoneStep); await tick();
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, operationId: null, state: 'running', activeGesture: 'left_straight' });
    x.controller.receiveNative({ ...phoneStep, actionRevision: 3, batchIndex: 2 });
    expect(x.controller.getSnapshot().activeGesture).toBe('left_straight');
    x.controller.receiveNative({ ...native(null), actionRevision: 4, activeGesture: null });
    expect(x.controller.getSnapshot()).toMatchObject({ pending: false, state: 'idle', activeGesture: null });
    expect(x.controller.receiveNative(phoneStep)).toBe(false);
    expect(x.controller.getSnapshot().activeGesture).toBeNull();
  });
  it('shows an admitted background list while no Mac operation is pending', () => {
    const x = setup();
    x.controller.receiveNative({ ...native(null), batchPending: true, batchOwner: 'background', activeGesture: 'right' }, true);
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, state: 'running', activeGesture: 'right' });
    expect(x.client.trackSystemAction).not.toHaveBeenCalled();
  });
  it('clears unknown recovery and keeps it clear after explicitly abandoning the native operation', async () => {
    const x = setup();
    x.controller.receiveNative({ ...native('op1', 'foreground', 'unknown'), actionRevision: 4, activeGesture: null, lastGesture: 'right' }, true);
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, state: 'unknown', activeGesture: null });
    x.bridge.resumeGestureActions.mockResolvedValue({ ...native(null), actionRevision: 5, activeGesture: null });
    await x.controller.resume();
    expect(x.controller.getSnapshot()).toMatchObject({ pending: false, state: 'idle', activeGesture: null });
    expect(x.controller.receiveNative({ ...native(), actionRevision: 4, activeGesture: 'right' })).toBe(false);
    expect(x.controller.getSnapshot().activeGesture).toBeNull();
  });
  it('clears uncertain delivery and restores the same gesture only when running is confirmed', async () => {
    const x = setup(); x.controller.receiveNative(native());
    x.controller.dispatchNative({ ...event, gesture: 'right' }, true);
    x.result.reject(new SystemActionDispatchError('unknown', 'Disconnected')); await tick();
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, state: 'unknown', activeGesture: null });
    x.setSnapshot({ status: 'connected', systemAction: { id: 'op1', action: 'screenshot', state: 'running', message: 'Still running' } });
    expect(x.controller.getSnapshot()).toMatchObject({ state: 'running', activeGesture: 'right' });
  });
  it('does not let an old completion acknowledgement clear a newer gesture', async () => {
    const x = setup();
    x.controller.receiveNative({ ...native(), actionRevision: 1, activeGesture: 'left' });
    x.controller.dispatchNative({ ...event, gesture: 'left' }, true);
    x.result.resolve({ id: 'op1', action: 'screenshot', ok: true }); await tick();
    x.controller.receiveNative({ ...native(null), actionRevision: 2, activeGesture: null });
    x.controller.receiveNative({ ...native('op2'), actionRevision: 3, activeGesture: 'right' });
    x.client.performSystemAction.mockReturnValue(new Promise(() => {}));
    x.controller.dispatchNative({ ...event, operationId: 'op2', gesture: 'right' }, true);
    x.release.resolve({ ...native(null), actionRevision: 2, activeGesture: null }); await tick();
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, operationId: 'op2', activeGesture: 'right' });
  });
  it('retains the fallback gesture through phone handoff and later Mac actions without an idle flash', async () => {
    const opened = deferred<void>(), completed = deferred<SystemActionCompletion>();
    const client = { getSnapshot: () => ({ status: 'connected' } as ConnectionSnapshot), performSystemAction: vi.fn(() => completed.promise), trackSystemAction: vi.fn(), resumeSystemActions: vi.fn() };
    const snapshots: { pending: boolean; activeGesture?: string | null }[] = [];
    const controller = new GestureActionController(client, null, () => { snapshots.push({ ...controller.getSnapshot() }); }, () => {}, () => opened.promise);
    expect(controller.dispatchFallbackSequence([{ type: 'open_url', target: 'mobile', url: 'https://example.com/phone' }, { type: 'system', action: 'screenshot' }], 'mixed', 'left_straight')).toBe(true);
    expect(controller.getSnapshot().activeGesture).toBe('left_straight');
    expect(controller.dispatchFallbackSequence([{ type: 'system', action: 'lock' }], 'overlap', 'right')).toBe(false);
    opened.resolve(); await tick();
    expect(controller.getSnapshot()).toMatchObject({ pending: true, operationId: 'mixed-2', activeGesture: 'left_straight' });
    expect(snapshots.every(snapshot => snapshot.pending && snapshot.activeGesture === 'left_straight')).toBe(true);
    completed.resolve({ id: 'mixed-2', action: 'screenshot', ok: true }); await tick();
    expect(controller.getSnapshot()).toMatchObject({ pending: false, state: 'idle', activeGesture: null });
  });
  it('clears the fallback gesture when uncertainty is explicitly resumed and drops remaining steps', async () => {
    const result = deferred<SystemActionCompletion>();
    const client = { getSnapshot: () => ({ status: 'connected' } as ConnectionSnapshot), performSystemAction: vi.fn(() => result.promise), trackSystemAction: vi.fn(), resumeSystemActions: () => true };
    const controller = new GestureActionController(client, null, () => {});
    controller.dispatchFallbackSequence([{ type: 'system', action: 'screenshot' }, { type: 'system', action: 'lock' }], 'batch', 'right');
    result.reject(new SystemActionDispatchError('unknown', 'Disconnected')); await tick();
    expect(controller.getSnapshot()).toMatchObject({ pending: true, state: 'unknown', activeGesture: null });
    await controller.resume();
    expect(controller.getSnapshot()).toMatchObject({ pending: false, state: 'idle', activeGesture: null });
    expect(client.performSystemAction).toHaveBeenCalledTimes(1);
  });
  it('does not reopen a native list from a stale between-step status after it was abandoned', async () => {
    const x = setup();
    x.controller.receiveNative({ ...native('op1', 'foreground', 'unknown'), actionRevision: 6, batchPending: true, activeGesture: null }, true);
    x.bridge.resumeGestureActions.mockResolvedValue({ ...native(null), actionRevision: 7, batchPending: false, activeGesture: null });
    await x.controller.resume();
    expect(x.controller.receiveNative({ ...native(null), actionRevision: 6, batchPending: true, activeGesture: 'right' })).toBe(false);
    expect(x.controller.getSnapshot()).toMatchObject({ pending: false, state: 'idle', activeGesture: null });
  });
  it('reveals a failed completion acknowledgement and keeps the error visible through native refreshes', async () => {
    const x = setup(), running = { ...native(), activeGesture: 'left' as const, batchPending: true };
    x.controller.receiveNative(running); x.controller.dispatchNative({ ...event, gesture: 'left' }, true);
    x.result.resolve({ id: 'op1', action: 'screenshot', ok: true }); await tick();
    expect(x.controller.getSnapshot().activeGesture).toBe('left');
    x.release.reject(Error('Bridge failed')); await tick();
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, state: 'running', activeGesture: null });
    expect(x.controller.getSnapshot().message).toContain('Could not confirm gesture completion');
    x.controller.receiveNative(running);
    expect(x.controller.getSnapshot().activeGesture).toBeNull();
    expect(x.controller.getSnapshot().message).toContain('Could not confirm gesture completion');
    x.bridge.completeGestureAction.mockResolvedValue({ ...native(null), batchPending: true, activeGesture: 'left' });
    x.controller.receiveNative(running, true); await tick();
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, operationId: null, activeGesture: 'left' });
    expect(x.client.performSystemAction).toHaveBeenCalledTimes(1);
  });
  it('reveals a native reply that still awaits completion without showing the finished gesture again', async () => {
    const x = setup(), running = { ...native(), activeGesture: 'right' as const };
    x.controller.receiveNative(running); x.controller.dispatchNative({ ...event, gesture: 'right' }, true);
    x.result.resolve({ id: 'op1', action: 'screenshot', ok: true }); await tick();
    x.release.resolve(running); await tick();
    expect(x.controller.getSnapshot()).toMatchObject({ pending: true, state: 'running', activeGesture: null });
    expect(x.controller.getSnapshot().message).toContain('Waiting for the gesture service');
    x.controller.receiveNative(running);
    expect(x.controller.getSnapshot().activeGesture).toBeNull();
    expect(x.controller.getSnapshot().message).toContain('Waiting for the gesture service');
    x.controller.receiveNative({ ...native(null), activeGesture: null });
    expect(x.controller.getSnapshot()).toMatchObject({ pending: false, activeGesture: null });
  });
});
