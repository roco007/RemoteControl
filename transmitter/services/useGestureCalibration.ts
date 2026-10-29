import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { gestureBridge, type GestureId } from '../modules/gesture-service';
import { GestureCalibrationController, type GestureCalibrationView } from './GestureCalibrationController';
import { CALIBRATION_TAKES } from './gestureCalibrationDefaults';

export function useGestureCalibration(onBlocked: (blocked: boolean) => void) {
  const available = Platform.OS === 'android' && !!gestureBridge &&
    typeof gestureBridge.getCalibrationStatus === 'function' && typeof gestureBridge.startCalibration === 'function' &&
    typeof gestureBridge.resumeCalibration === 'function' &&
    typeof gestureBridge.captureCalibrationGesture === 'function' && typeof gestureBridge.saveCalibration === 'function' &&
    typeof gestureBridge.cancelCalibration === 'function';
  const [view, setView] = useState<GestureCalibrationView>({ visible: false, status: null, busy: null, error: '' });
  const callbacks = useRef(onBlocked); callbacks.current = onBlocked;
  const alive = useRef(false);
  const controllerRef = useRef<GestureCalibrationController | null>(null);
  if (!controllerRef.current) controllerRef.current = new GestureCalibrationController(available ? gestureBridge : null,
    next => { if (alive.current) setView(next); }, blocked => { if (alive.current) callbacks.current(blocked); });
  const controller = controllerRef.current;

  useEffect(() => {
    alive.current = true;
    controller.setAppActive(AppState.currentState === 'active');
    if (!available || !gestureBridge) return () => { alive.current = false; };
    const statuses = gestureBridge.addListener('onCalibration', next => controller.receive(next));
    const lifecycle = gestureBridge.addListener('onAppState', event => {
      controller.setAppActive(event.active);
      if (event.active) void controller.refresh();
    });
    const foreground = AppState.addEventListener('change', next => { if (next === 'active') void controller.refresh(); });
    void controller.refresh();
    return () => { alive.current = false; controller.setAppActive(false); statuses.remove(); lifecycle.remove(); foreground.remove(); };
  }, [available, controller]);

  const calibratedAt = view.status?.calibratedAt ?? null;
  const learned = view.status?.learnedGestures ?? [];
  const earlierCount = view.status?.calibratedGestures.filter(id => !learned.includes(id)).length ?? 0;
  const coverage = `${learned.length} of 7 learned${earlierCount ? ` · ${earlierCount} use earlier calibration` : ''}`;
  const summary = !available ? 'Calibration is available in the updated Android app.' : calibratedAt !== null ?
    `${coverage} · ${new Date(calibratedAt).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' })}` :
    view.status ? `Not learned yet · Record ${CALIBRATION_TAKES} takes per movement` : view.error ? 'Calibration status unavailable' : 'Checking calibration…';
  return {
    ...view, available, calibratedAt, summary,
    open: () => { void controller.open(); },
    start: (gesture?: GestureId) => { void controller.start(gesture); },
    resume: () => { void controller.resume(); },
    capture: () => { void controller.capture(); },
    save: () => { void controller.save(); },
    cancel: () => { void controller.cancel(); },
    refresh: () => { void controller.refresh(); },
  };
}
