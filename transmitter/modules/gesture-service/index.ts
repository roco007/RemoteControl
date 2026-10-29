import { requireOptionalNativeModule } from 'expo-modules-core';
import type { SystemAction } from '../../../shared/protocol';
import type { GestureMappings } from '../../services/gestureSettings';

export type GestureId = 'single' | 'double' | 'triple' | 'right' | 'left' | 'left_straight' | 'right_straight';
export type GestureAction = 'screenshot' | 'kill_app' | 'lock' | 'photo_booth' | 'none';
export interface GestureConfiguration {
  enabled: boolean;
  controlRevision: number;
  controlBackground?: boolean;
  background: boolean;
  backgroundEligible?: boolean;
  mode: 'count' | 'directional';
  mappings: GestureMappings;
  foregroundReady: boolean;
  foregroundAllowed?: boolean;
  preservePairing?: boolean;
  host: string;
  port: number;
  serverId: string;
  token: string;
  deviceId: string;
  deviceName: string;
}
export interface GestureStatus {
  /** Admitted running gesture; null when idle, unknown, or using shake counts. Absent on older native builds. */
  activeGesture?: GestureId | null;
  batchPending?: boolean;
  batchOwner?: 'foreground' | 'background' | null;
  batchIndex?: number;
  batchTotal?: number;
  batchSummary?: string;
  actionRevision?: number;
  actionPending?: boolean;
  actionOperationId?: string | null;
  actionOwner?: 'foreground' | 'background' | null;
  actionState?: 'idle' | 'running' | 'unknown';
  actionName?: SystemAction | null;
  actionServerId?: string | null;
  actionDeviceId?: string | null;
  controlEnabled: boolean | null;
  controlRevision: number;
  controlBackground: boolean;
  enabled: boolean;
  listening: boolean;
  background: boolean;
  appActive: boolean;
  connection: 'foreground' | 'connecting' | 'connected' | 'disconnected' | 'error';
  count: number;
  lastCount: number;
  lastGesture: string;
  lastAction: string;
  message: string;
  stoppedByUser: boolean;
}
export interface GestureTriggerResult {
  accepted: boolean;
  message: string;
  status: GestureStatus;
}
export interface GestureCalibrationStatus {
  sessionId: string;
  sequence: number;
  active: boolean;
  phase: 'idle' | 'ready' | 'hold_still' | 'recording' | 'review' | 'interrupted' | 'error';
  gesture: GestureId | null;
  gestures: GestureId[];
  calibratedGestures: GestureId[];
  /** Saved learned movements, including earlier ten-take profiles; absent on older native builds. */
  learnedGestures?: GestureId[];
  step: number;
  totalSteps: number;
  repetition: number;
  repetitions: number;
  accepted: number;
  total: number;
  remainingMs: number;
  message: string;
  canSave: boolean;
  calibratedAt: number | null;
  profileRevision: number;
  sensorAvailable: boolean;
}
export interface GestureEvent {
  gesture: GestureId; count: number; action: SystemAction; operationId: string;
  appId?: string; command?: string; url?: string; batchIndex?: number; batchTotal?: number;
}
export interface CalibrationVector { x: number; y: number; z: number }
export interface CalibrationRawReading extends CalibrationVector { timeMs: number }
export interface CalibrationTakeReadings {
  take: number;
  raw: CalibrationRawReading[] | null;
  template: {
    points: CalibrationVector[]; durationMs: number; amplitudeG: number; modelVersion: number; maxDistance: number;
    /** Effective-template provenance; absent on older native builds. */
    storedModelVersion?: number | null;
    source?: 'stored' | 'raw_rebuilt' | 'projected' | 'draft';
  } | null;
}
export interface CalibrationReadings {
  gesture: GestureId;
  source: 'saved' | 'draft';
  sessionId: string | null;
  profileRevision: number;
  preparationMs: number;
  /** Confirms the returned templates are the effective XY shapes used by recognition. */
  recognitionAxes?: ['x', 'y'];
  takes: CalibrationTakeReadings[];
}
export type GestureActionOutcome = 'success' | 'failed' | 'not_sent' | 'unknown' | 'running';
export type GestureAppState = Pick<GestureStatus, 'activeGesture' | 'actionRevision' | 'actionPending' | 'actionOperationId' | 'actionOwner' | 'actionState' | 'actionName' | 'actionServerId' | 'actionDeviceId' | 'batchPending' | 'batchOwner' | 'batchIndex' | 'batchTotal' | 'batchSummary'> & { active: boolean };
type Subscription = { remove(): void };
export interface GestureBridge {
  listInstalledApps(): Promise<{ id: string; name: string; icon?: string | null }[]>;
  openMobileApp(appId: string): Promise<void>;
  /** Uses the native sequence owner after checking the visible card's JSON { mode, steps } snapshot. */
  triggerGesture?(gesture: GestureId, expected: string): Promise<GestureTriggerResult>;
  completeGestureAction(operationId: string, outcome: GestureActionOutcome, message: string | null): Promise<GestureStatus>;
  resumeGestureActions(operationId: string): Promise<GestureStatus>;
  getCalibrationStatus(): Promise<GestureCalibrationStatus>;
  getCalibrationReadings?(gesture: GestureId, draftSessionId: string | null): Promise<CalibrationReadings>;
  startCalibration(gesture?: GestureId | null): Promise<GestureCalibrationStatus>;
  resumeCalibration(sessionId: string): Promise<GestureCalibrationStatus>;
  captureCalibrationGesture(sessionId: string): Promise<GestureCalibrationStatus>;
  saveCalibration(sessionId: string): Promise<GestureCalibrationStatus>;
  cancelCalibration(sessionId: string): Promise<GestureCalibrationStatus>;
  configure(config: string): Promise<GestureStatus>;
  setEnabled(enabled: boolean): Promise<GestureStatus>;
  setBackgroundEnabled(enabled: boolean): Promise<GestureStatus>;
  stop(): Promise<GestureStatus>;
  clearPairing?(): Promise<GestureStatus>;
  requestPinWidget(): Promise<boolean>;
  getStatus(): Promise<GestureStatus>;
  requestNotificationPermission(): Promise<boolean>;
  addListener(name: 'onCalibration', listener: (event: GestureCalibrationStatus) => void): Subscription;
  addListener(name: 'onStatus', listener: (event: GestureStatus) => void): Subscription;
  addListener(name: 'onGesture', listener: (event: GestureEvent) => void): Subscription;
  addListener(name: 'onAppState', listener: (event: GestureAppState) => void): Subscription;
}
export const gestureBridge = requireOptionalNativeModule<GestureBridge>('GestureService');
