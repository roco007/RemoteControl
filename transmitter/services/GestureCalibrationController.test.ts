import { describe, expect, it } from 'vitest';
import type { GestureCalibrationStatus, GestureId } from '../modules/gesture-service';
import { GestureCalibrationController } from './GestureCalibrationController';

function status(overrides: Partial<GestureCalibrationStatus> = {}): GestureCalibrationStatus {
  return { sessionId: '', sequence: 0, active: false, phase: 'idle', gesture: null, gestures: ['left', 'right', 'left_straight', 'right_straight', 'single', 'double', 'triple'], calibratedGestures: [], learnedGestures: [], step: 0, totalSteps: 7,
    repetition: 1, repetitions: 5, accepted: 0, total: 35, remainingMs: 0,
    message: '', canSave: false, calibratedAt: 100, profileRevision: 1, sensorAvailable: true, ...overrides };
}
const ready = (sessionId = 'session-a') => status({ sessionId, active: true, phase: 'ready', gesture: 'left' });
function deferred<T>() { let resolve!: (value: T) => void; let reject!: (reason: Error) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
function setup() {
  let native = status();
  const calls: string[] = [];
  const starts: (GestureId | null | undefined)[] = [];
  const blocks: boolean[] = [];
  const bridge = {
    getCalibrationStatus: async () => native,
    startCalibration: async (gesture?: GestureId | null) => { calls.push('start'); starts.push(gesture); native = gesture ? { ...ready(), gesture, gestures: [gesture], totalSteps: 1, total: 5 } : ready(); return native; },
    resumeCalibration: async (_id: string) => { calls.push('resume'); native = { ...native, sequence: native.sequence + 1, phase: 'ready' as const }; return native; },
    captureCalibrationGesture: async (_id: string) => { calls.push('capture'); native = { ...native, phase: 'hold_still' as const, remainingMs: 1200 }; return native; },
    saveCalibration: async (_id: string) => { calls.push('save'); native = status({ sessionId: native.sessionId, calibratedAt: 200, profileRevision: 2 }); return native; },
    cancelCalibration: async (_id: string) => { calls.push('cancel'); native = status({ sessionId: native.sessionId }); return native; },
  };
  const controller = new GestureCalibrationController(bridge, () => {}, blocked => blocks.push(blocked));
  return { controller, bridge, blocks, calls, starts, setNative: (next: GestureCalibrationStatus) => { native = next; } };
}

describe('gesture calibration session lifecycle', () => {
  it('blocks actions before opening the native session without changing master controls', async () => {
    const { controller, bridge, blocks, calls } = setup();
    const read = deferred<GestureCalibrationStatus>(); bridge.getCalibrationStatus = () => read.promise;
    const opening = controller.open();
    expect(blocks).toEqual([true]);
    expect(controller.snapshot.visible).toBe(true);
    read.resolve(status()); await opening; await controller.start();
    expect(calls).toEqual(['start']);
    expect(controller.snapshot.status?.active).toBe(true);
  });
  it('starts only the selected movement without requesting the full set', async () => {
    const { controller, starts } = setup();
    await controller.open(); await controller.start('left_straight');
    expect(starts).toEqual(['left_straight']);
    expect(controller.snapshot.status).toMatchObject({ gestures: ['left_straight'], gesture: 'left_straight', totalSteps: 1, repetitions: 5, total: 5 });
  });
  it('retains earlier ten-take learned coverage while starting and canceling a five-take replacement', async () => {
    const { controller, bridge, setNative } = setup();
    const earlier = status({ repetitions: 10, total: 70, calibratedGestures: ['left', 'right'], learnedGestures: ['left', 'right'] });
    setNative(earlier); await controller.open();
    expect(controller.snapshot.status?.learnedGestures).toEqual(['left', 'right']);
    const replacement = { ...ready(), sequence: 1, gesture: 'left' as const, gestures: ['left' as const], totalSteps: 1, total: 5,
      calibratedGestures: earlier.calibratedGestures, learnedGestures: earlier.learnedGestures };
    bridge.startCalibration = async () => { setNative(replacement); return replacement; };
    await controller.start('left');
    expect(controller.snapshot.status).toMatchObject({ repetitions: 5, total: 5, learnedGestures: ['left', 'right'], calibratedAt: 100, profileRevision: 1 });
    bridge.cancelCalibration = async () => ({ ...earlier, sessionId: 'session-a', sequence: 2 });
    await controller.cancel();
    expect(controller.snapshot.visible).toBe(false);
    expect(controller.snapshot.status).toMatchObject({ learnedGestures: ['left', 'right'], calibratedAt: 100, profileRevision: 1 });
  });
  it('passes explicit null when starting every movement', async () => {
    const { controller, starts } = setup();
    await controller.open(); await controller.start();
    expect(starts).toEqual([null]);
    expect(controller.snapshot.status?.gestures).toHaveLength(7);
  });
  it('continues an interrupted session without discarding its accepted movements', async () => {
    const { controller, setNative, calls, blocks } = setup();
    const interrupted = { ...ready(), sequence: 8, phase: 'interrupted' as const, accepted: 18, step: 3, repetition: 4, gesture: 'right_straight' as const };
    setNative(interrupted); controller.receive(interrupted); await controller.resume();
    expect(calls).toEqual(['resume']);
    expect(controller.snapshot.status).toMatchObject({ sessionId: 'session-a', accepted: 18, total: 35, step: 3, repetition: 4, gesture: 'right_straight', phase: 'ready' });
    expect(blocks).toEqual([true]);
  });
  it('does not replace a newer interruption with an older resume reply', async () => {
    const { controller, bridge } = setup();
    controller.receive({ ...ready(), sequence: 8, phase: 'interrupted', accepted: 13, step: 2, repetition: 4, gesture: 'left_straight' });
    const resumed = deferred<GestureCalibrationStatus>(); bridge.resumeCalibration = () => resumed.promise;
    const pending = controller.resume();
    controller.receive({ ...ready(), sequence: 10, phase: 'interrupted', accepted: 13, step: 2, repetition: 4, gesture: 'left_straight' });
    resumed.resolve({ ...ready(), sequence: 9, accepted: 13, step: 2, repetition: 4, gesture: 'left_straight' }); await pending;
    expect(controller.snapshot.status).toMatchObject({ sequence: 10, phase: 'interrupted', accepted: 13, step: 2, repetition: 4 });
  });
  it('keeps accepted progress and actions paused when Continue fails', async () => {
    const { controller, bridge, blocks } = setup();
    controller.receive({ ...ready(), phase: 'interrupted', accepted: 2 });
    bridge.resumeCalibration = async () => { throw new Error('Could not resume'); };
    await controller.resume();
    expect(controller.snapshot.status?.accepted).toBe(2);
    expect(controller.snapshot.error).toContain('Could not resume');
    expect(controller.snapshot.visible).toBe(true);
    expect(blocks).toEqual([true]);
  });
  it('ignores a delayed Continue reply after cancellation succeeds', async () => {
    const { controller, bridge, setNative, blocks } = setup();
    const interrupted = { ...ready(), sequence: 8, phase: 'interrupted' as const, accepted: 2 };
    setNative(interrupted); controller.receive(interrupted);
    const resumed = deferred<GestureCalibrationStatus>(); bridge.resumeCalibration = () => resumed.promise;
    const pending = controller.resume();
    bridge.cancelCalibration = async () => status({ sessionId: 'session-a', sequence: 10 });
    await controller.cancel();
    resumed.resolve({ ...ready(), sequence: 9, accepted: 2 }); await pending;
    expect(controller.snapshot.visible).toBe(false);
    expect(blocks).toEqual([true, false]);
  });
  it('does not capture before native has acknowledged the calibration guard', async () => {
    const { controller, bridge, calls } = setup();
    await controller.open();
    const start = deferred<GestureCalibrationStatus>(); bridge.startCalibration = () => start.promise;
    const starting = controller.start(); await controller.capture();
    expect(calls).toEqual([]);
    start.resolve(ready()); await starting;
    await controller.capture(); await controller.capture();
    expect(calls).toEqual(['capture']);
  });
  it('ignores a late initial status read after a new session starts', async () => {
    const { controller, bridge } = setup();
    const read = deferred<GestureCalibrationStatus>(); bridge.getCalibrationStatus = () => read.promise;
    const opening = controller.open(); await controller.start();
    read.resolve(status()); await opening;
    expect(controller.snapshot.status?.sessionId).toBe('session-a');
    expect(controller.snapshot.status?.phase).toBe('ready');
  });
  it('keeps newer capture progress when its initial command reply arrives late', async () => {
    const { controller, bridge } = setup();
    await controller.open(); await controller.start();
    const capture = deferred<GestureCalibrationStatus>(); bridge.captureCalibrationGesture = () => capture.promise;
    const pending = controller.capture();
    controller.receive({ ...ready(), sequence: 3, phase: 'recording', remainingMs: 3000 });
    controller.receive({ ...ready(), sequence: 4, accepted: 5, repetition: 1, step: 1, gesture: 'right' });
    capture.resolve({ ...ready(), sequence: 2, phase: 'hold_still', remainingMs: 1200 }); await pending;
    expect(controller.snapshot.status).toMatchObject({ accepted: 5, phase: 'ready', step: 1, repetition: 1, gesture: 'right' });
  });
  it('waits for another explicit Record tap after accepting a take of the same movement', async () => {
    const { controller, calls } = setup();
    await controller.open(); await controller.start('right'); await controller.capture();
    controller.receive(status({ sessionId: 'session-a', sequence: 4, active: true, phase: 'ready', gestures: ['right'], gesture: 'right',
      totalSteps: 1, total: 5, accepted: 1, repetition: 2 }));
    await Promise.resolve();
    expect(controller.snapshot.status).toMatchObject({ phase: 'ready', accepted: 1, repetition: 2, gesture: 'right' });
    expect(calls).toEqual(['start', 'capture']);
    await controller.capture();
    expect(calls).toEqual(['start', 'capture', 'capture']);
  });
  it('keeps actions paused until all thirty-five takes are committed and rejects older progress afterward', async () => {
    const { controller, bridge, blocks, calls } = setup();
    await controller.open(); await controller.start();
    controller.receive({ ...ready(), sequence: 69, accepted: 34, step: 6, repetition: 5, gesture: 'triple', calibratedGestures: ['left'] });
    await controller.save();
    expect(calls).toEqual(['start']);

    const reading = deferred<GestureCalibrationStatus>(); bridge.getCalibrationStatus = () => reading.promise;
    const oldRefresh = controller.refresh();
    const saved = deferred<GestureCalibrationStatus>(); bridge.saveCalibration = () => saved.promise;
    controller.receive({ ...ready(), sequence: 70, phase: 'review', accepted: 35, step: 6, repetition: 5, gesture: 'triple', canSave: true, calibratedGestures: ['left'] });
    const saving = controller.save();
    expect(controller.snapshot).toMatchObject({ visible: true, busy: 'saving', status: { calibratedAt: 100, learnedGestures: [] } });
    expect(blocks).toEqual([true]);

    saved.resolve(status({ sessionId: 'session-a', sequence: 71, accepted: 35, step: 6, repetition: 5, calibratedAt: 200, profileRevision: 2,
      calibratedGestures: ['left', 'right', 'left_straight', 'right_straight', 'single', 'double', 'triple'],
      learnedGestures: ['left', 'right', 'left_straight', 'right_straight', 'single', 'double', 'triple'] }));
    await saving;
    reading.resolve({ ...ready(), sequence: 69, accepted: 34, step: 6, repetition: 5, gesture: 'triple' }); await oldRefresh;
    controller.receive({ ...ready(), sequence: 99, accepted: 10, step: 2, gesture: 'left_straight' });
    expect(controller.snapshot.visible).toBe(false);
    expect(controller.snapshot.status).toMatchObject({ calibratedAt: 200, profileRevision: 2, accepted: 35 });
    expect(controller.snapshot.status?.learnedGestures).toEqual(['left', 'right', 'left_straight', 'right_straight', 'single', 'double', 'triple']);
    expect(blocks).toEqual([true, false]);
  });
  it('keeps the wizard and action block when cancellation fails', async () => {
    const { controller, bridge, blocks } = setup();
    await controller.open(); await controller.start();
    bridge.cancelCalibration = async () => { throw new Error('Native cancellation failed'); };
    await controller.cancel();
    expect(controller.snapshot.visible).toBe(true);
    expect(controller.snapshot.error).toContain('Native cancellation failed');
    expect(blocks).toEqual([true]);
  });
  it('keeps the previous profile and wizard when saving is rejected', async () => {
    const { controller, bridge, blocks } = setup();
    await controller.open(); await controller.start();
    controller.receive({ ...ready(), phase: 'review', accepted: 35, step: 6, repetition: 5, canSave: true });
    bridge.saveCalibration = async () => { throw new Error('Profile was not saved'); };
    await controller.save();
    expect(controller.snapshot.visible).toBe(true);
    expect(controller.snapshot.status?.calibratedAt).toBe(100);
    expect(controller.snapshot.error).toContain('Profile was not saved');
    expect(blocks).toEqual([true]);
  });
  it('does not close on a native save error returned as status', async () => {
    const { controller, bridge } = setup();
    await controller.open(); await controller.start();
    controller.receive({ ...ready(), phase: 'review', accepted: 35, step: 6, repetition: 5, canSave: true });
    bridge.saveCalibration = async () => ({ ...ready(), phase: 'error', message: 'Could not save recordings' });
    await controller.save();
    expect(controller.snapshot.visible).toBe(true);
    expect(controller.snapshot.error).toContain('Could not save recordings');
  });
  it('updates the saved date only after native commit and ignores events from the completed session', async () => {
    const { controller, blocks } = setup();
    await controller.open(); await controller.start();
    controller.receive({ ...ready(), phase: 'review', accepted: 35, step: 6, repetition: 5, canSave: true });
    await controller.save(); controller.receive({ ...ready(), sequence: 5, phase: 'recording', remainingMs: 1000 });
    expect(controller.snapshot.visible).toBe(false);
    expect(controller.snapshot.status?.calibratedAt).toBe(200);
    expect(blocks).toEqual([true, false]);
  });
  it('ignores a canceled session after starting a replacement', async () => {
    const { controller, bridge } = setup();
    await controller.open(); await controller.start(); await controller.cancel();
    await controller.open(); bridge.startCalibration = async () => ready('session-b');
    await controller.start(); controller.receive({ ...ready(), sequence: 10, accepted: 1 });
    expect(controller.snapshot.status?.sessionId).toBe('session-b');
    expect(controller.snapshot.status?.accepted).toBe(0);
  });
  it('retains the action block when backgrounding interrupts capture', async () => {
    const { controller, calls, blocks } = setup();
    await controller.open(); await controller.start(); await controller.capture();
    controller.setAppActive(false); await controller.capture();
    expect(controller.snapshot.status?.phase).toBe('interrupted');
    expect(calls).toEqual(['start', 'capture']);
    expect(blocks).toEqual([true]);
    controller.setAppActive(true); await controller.cancel();
    expect(controller.snapshot.visible).toBe(false);
    expect(blocks).toEqual([true, false]);
  });
  it('recovers a native interrupted session instead of showing an unguarded intro', async () => {
    const { controller, setNative, blocks } = setup();
    setNative({ ...ready(), phase: 'interrupted' }); await controller.refresh();
    expect(controller.snapshot.visible).toBe(true);
    expect(blocks).toEqual([true]);
  });
});
