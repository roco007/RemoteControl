import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { gestureBridge, type GestureAppState, type GestureConfiguration, type GestureEvent, type GestureId, type GestureStatus } from '../modules/gesture-service';
import type { ConnectionSnapshot } from '../networking/types';
import { credentials } from './credentials';
import { NativeGestureSync, type NativeGestureControl } from './NativeGestureSync';
import { GesturePairingCache } from './GesturePairingCache';
import { gestureSteps, type GestureMappings } from './gestureSettings';
import type { Settings } from './settings';
import { backgroundGesturesEligible } from './gestureAvailability';

/** Native owns Android motion, the persisted master switch and background Wi-Fi. */
export function useNativeGestures({ settings, getSettings, loaded, connection, paused, onGesture, onNativeControl, onNativeStatus, onNativeLifecycle }: {
  settings: Settings; getSettings: () => Settings; loaded: boolean; connection: ConnectionSnapshot; paused: boolean;
  onGesture: (event: GestureEvent) => boolean; onNativeControl: (control: NativeGestureControl) => void;
  onNativeStatus: (status: GestureStatus, recovery: boolean) => void;
  onNativeLifecycle: (event: GestureAppState) => void;
}) {
  const [status, setStatus] = useState<GestureStatus | null>(null);
  const [error, setError] = useState('');
  const [controlVersion, setControlVersion] = useState(0);
  const [notificationDenied, setNotificationDenied] = useState(false);
  const callbacks = useRef({ onGesture, onNativeControl, getSettings, onNativeStatus, onNativeLifecycle }); callbacks.current = { onGesture, onNativeControl, getSettings, onNativeStatus, onNativeLifecycle };
  const statusEpoch = useRef(0);
  const currentStatus = useRef<GestureStatus | null>(null);
  const alive = useRef(false);
  const pairing = useRef(new GesturePairingCache());
  const invalidPairing = useRef('');
  const requestedNotifications = useRef(false);
  const syncRef = useRef<NativeGestureSync | null>(null);
  if (gestureBridge && !syncRef.current) syncRef.current = new NativeGestureSync(gestureBridge, {
    onStatus: next => { if (alive.current) setStatus(next); },
    onControl: next => { if (alive.current) callbacks.current.onNativeControl(next); },
    onReady: () => { if (alive.current) setControlVersion(value => value + 1); },
  });
  const sync = syncRef.current;

  const refreshStatus = async () => {
    if (!gestureBridge || !sync) return null;
    const epoch = statusEpoch.current;
    const next = await gestureBridge.getStatus();
    sync.receive(next);
    // Configuration replies reconcile persisted controls only. Ownership uses
    // live events, or a read that did not race a newer native event.
    if (alive.current && epoch === statusEpoch.current) {
      currentStatus.current = next;
      callbacks.current.onNativeStatus(next, true);
    }
    return currentStatus.current;
  };

  useEffect(() => {
    if (!gestureBridge || !sync) return;
    alive.current = true;
    const refresh = () => { void refreshStatus().then(() => { if (alive.current) setControlVersion(value => value + 1); }).catch(() => { if (alive.current) setError('Could not read gesture status. Reopen the app and try again.'); }); };
    const state = gestureBridge.addListener('onStatus', next => {
      ++statusEpoch.current; currentStatus.current = next;
      callbacks.current.onNativeStatus(next, false);
      sync.receive(next);
    });
    const gestures = gestureBridge.addListener('onGesture', event => {
      // Even paused events need exact not_sent acknowledgement to release native.
      callbacks.current.onGesture(event);
    });
    const foreground = gestureBridge.addListener('onAppState', event => {
      ++statusEpoch.current;
      callbacks.current.onNativeLifecycle(event);
      if (event.active || (event.actionPending && event.actionOwner === 'foreground')) refresh();
    });
    const appState = AppState.addEventListener('change', next => { if (next === 'active') refresh(); });
    refresh();
    return () => { alive.current = false; sync.invalidate(); state.remove(); gestures.remove(); foreground.remove(); appState.remove(); };
  }, [sync]);

  // This runs before configuration, including when native status arrived before AsyncStorage.
  useEffect(() => { sync?.setLoaded(loaded); }, [loaded, sync]);

  useEffect(() => {
    if (!gestureBridge || !sync?.ready || !loaded) return;
    let current = true;
    const clearInvalidPairing = async (reason: string) => {
      pairing.current.clear();
      if (invalidPairing.current === reason) return;
      invalidPairing.current = reason;
      sync.receive(await (gestureBridge!.clearPairing ? gestureBridge!.clearPairing() : gestureBridge!.stop()));
    };
    const configure = async () => {
      const supportsActionLists = typeof gestureBridge?.listInstalledApps === 'function';
      const hasActionLists = Object.values(callbacks.current.getSettings().gestureMappings).some(Array.isArray);
      if (connection.status === 'authentication_required' || (connection.status === 'error' && connection.retryable === false)) {
        await clearInvalidPairing(`${connection.status}/${connection.serverId ?? ''}`);
      }
      await sync.configure(async () => {
        // Disabled gestures still save a paired profile, so the widget can enable them later.
        if (connection.status === 'connected' && connection.serverId) {
          const serverId = connection.serverId;
          const saved = await pairing.current.load(async () => {
            const [identity, token] = await Promise.all([credentials.getIdentity(), credentials.getToken(serverId)]);
            return token ? { ...identity, serverId, token } : null;
          });
          if (!current || saved === undefined) return null;
          if (!saved) await clearInvalidPairing(`missing-token/${serverId}`);
          if (saved) invalidPairing.current = '';
        }
        const savedPairing = pairing.current.value ?? { serverId: '', token: '', deviceId: '', deviceName: 'Android phone' };
        if (!current) return null;
        // Read the synchronously reconciled ref, never the render that preceded a widget event.
        const latest = callbacks.current.getSettings();
        const backgroundEligible = backgroundGesturesEligible(latest);
        const background = latest.backgroundGestures && backgroundEligible;
        if (latest.shakeActions && background && !requestedNotifications.current && AppState.currentState === 'active') {
          requestedNotifications.current = true;
          const granted = await gestureBridge!.requestNotificationPermission();
          if (!current) return null;
          setNotificationDenied(!granted);
        }
        return {
          enabled: latest.shakeActions, controlRevision: sync.revision, controlBackground: latest.backgroundGestures, background, backgroundEligible,
          mode: latest.gestureMode, mappings: supportsActionLists ? latest.gestureMappings : Object.fromEntries(Object.entries(latest.gestureMappings).map(([key, value]) => [key, Array.isArray(value) ? 'none' : value])) as GestureMappings, foregroundAllowed: !paused,
          preservePairing: !invalidPairing.current,
          foregroundReady: connection.status === 'connected' && connection.capabilities?.includes('system_actions') === true && connection.capabilities.includes('action_completion') && !paused,
          host: latest.host.trim(), port: latest.port, ...savedPairing,
        } satisfies GestureConfiguration;
      });
      if (current) setError(hasActionLists && !supportsActionLists ? 'Install the updated Android app to run gesture action lists.' : '');
    };
    void configure().catch(e => { if (current) setError(e instanceof Error ? e.message : 'Could not configure gestures.'); });
    return () => { current = false; sync.invalidate(); pairing.current.cancelPending(); };
  }, [loaded, controlVersion, sync, settings.shakeActions, settings.backgroundGestures, settings.gestureMode, settings.gestureMappings, settings.host, settings.port, settings.transportMode, connection.status, connection.retryable, connection.serverId, connection.capabilities, paused]);

  const setEnabled = (enabled: boolean) => {
    void sync?.setEnabled(enabled).catch(e => { if (alive.current) setError(e instanceof Error ? e.message : 'Could not change gesture controls.'); });
  };
  const setBackgroundEnabled = (enabled: boolean) => {
    void sync?.setBackgroundEnabled(enabled).catch(e => { if (alive.current) setError(e instanceof Error ? e.message : 'Could not change background gestures.'); });
  };
  const settingsChanged = () => { sync?.invalidate(); if (sync) setControlVersion(value => value + 1); };
  const triggerGesture = async (gesture: GestureId) => {
    if (!gestureBridge?.triggerGesture) return { accepted: false, message: 'Install the updated phone app to run actions by tapping a card.' };
    const epoch = statusEpoch.current;
    const latest = callbacks.current.getSettings();
    const expected = JSON.stringify({ mode: latest.gestureMode, steps: gestureSteps(gesture, latest.gestureMappings) });
    const result = await gestureBridge.triggerGesture(gesture, expected);
    // A phone launch or a very fast completion may emit a newer status before
    // this bridge reply arrives. Never restore the earlier action ownership.
    if (alive.current && epoch === statusEpoch.current) {
      sync?.receive(result.status);
      currentStatus.current = result.status;
      callbacks.current.onNativeStatus(result.status, false);
    }
    return result;
  };
  const stop = () => {
    sync?.invalidate(); pairing.current.clear();
    void gestureBridge?.stop().then(next => sync?.receive(next)).catch(() => { if (alive.current) setError('Could not clear the background connection.'); });
  };
  return { available: !!gestureBridge, status, error, notificationDenied, setEnabled, setBackgroundEnabled, settingsChanged, triggerGesture, stop, refreshStatus };
}
