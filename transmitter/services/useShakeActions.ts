import { useEffect, useRef, useState } from 'react';
import { AppState, Platform } from 'react-native';
import { Accelerometer } from 'expo-sensors';
import { ShakeDetector } from '../gestures/ShakeDetector';

export type ShakeCount = 1 | 2 | 3;
export type MotionStatus = 'checking' | 'ready' | 'unavailable' | 'permission_required';

/** Motion is subscribed only during a usable foreground control session. */
export function useShakeActions({ enabled, session, onShake, isBlocked }: {
  enabled: boolean; session: string; onShake: (count: ShakeCount) => boolean; isBlocked: () => boolean;
}) {
  const [motionStatus, setMotionStatus] = useState<MotionStatus>('checking');
  const [count, setCount] = useState(0);
  const [lastCount, setLastCount] = useState(0);
  const [lastAction, setLastAction] = useState<ShakeCount | null>(null);
  const callback = useRef(onShake); callback.current = onShake;
  const blocked = useRef(isBlocked); blocked.current = isBlocked;
  const resumeAfter = useRef(0);
  useEffect(() => {
    setCount(0); setLastAction(null);
    if (Platform.OS === 'web') { setMotionStatus('unavailable'); return; }
    if (!enabled) return;
    let disposed = false;
    let generation = 0;
    let listening = false;
    let subscription: ReturnType<typeof Accelerometer.addListener> | undefined;
    let feedbackTimer: ReturnType<typeof setTimeout> | undefined;
    let restartTimer: ReturnType<typeof setTimeout> | undefined;
    const detector = new ShakeDetector(sequence => {
      if (!listening || blocked.current() || AppState.currentState !== 'active') return;
      // Unsubscribe and discard sequence/cooldown timers before dispatch. React's
      // next render is too late to establish an action boundary.
      resumeAfter.current = Date.now() + 1000;
      stop();
      setLastCount(sequence);
      console.info(`Shake-to-Action: completed ${sequence} shakes`);
      if (callback.current(sequence)) {
        setLastAction(sequence);
        clearTimeout(feedbackTimer);
        feedbackTimer = setTimeout(() => setLastAction(null), 2500);
      } else if (!blocked.current()) void start();
    }, progress => {
      if (!disposed) {
        setCount(progress);
        if (progress > 0) console.info(`Shake-to-Action: detected ${progress} shakes`);
      }
    });
    const stop = () => {
      ++generation; listening = false;
      subscription?.remove(); subscription = undefined;
      detector.reset(); clearTimeout(feedbackTimer); clearTimeout(restartTimer);
      if (!disposed) { setCount(0); setLastAction(null); }
    };
    const start = async () => {
      stop(); const current = generation;
      if (blocked.current()) return;
      const remaining = resumeAfter.current - Date.now();
      if (remaining > 0) { restartTimer = setTimeout(() => { if (!disposed && current === generation) void start(); }, remaining); return; }
      setMotionStatus('checking');
      try {
        const available = await Accelerometer.isAvailableAsync();
        if (disposed || current !== generation) return;
        if (!available) { setMotionStatus('unavailable'); return; }
        const permission = await Accelerometer.requestPermissionsAsync();
        if (disposed || current !== generation) return;
        if (!permission.granted) { setMotionStatus('permission_required'); return; }
        if (blocked.current() || AppState.currentState !== 'active') return;
        Accelerometer.setUpdateInterval(40);
        listening = true;
        subscription = Accelerometer.addListener(sample => {
          if (current === generation && listening && !blocked.current() && AppState.currentState === 'active') detector.addSample(sample, sample.timestamp * 1000);
        });
        setMotionStatus('ready');
      } catch { if (!disposed && current === generation) setMotionStatus('unavailable'); }
    };
    const lifecycle = AppState.addEventListener('change', state => {
      if (state === 'active') void start(); else stop();
    });
    if (AppState.currentState === 'active') void start();
    return () => { disposed = true; stop(); detector.dispose(); lifecycle.remove(); };
  }, [enabled, session]);
  return { motionStatus, count, lastCount, lastAction };
}
