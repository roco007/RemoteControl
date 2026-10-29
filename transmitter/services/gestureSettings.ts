import type { SystemAction } from '../../shared/protocol';
import { normalizeOpenUrl as normalizeGestureUrl } from '../../shared/openUrl';
export { normalizeGestureUrl };

export const gestureNames = { single: 'Shake', double: 'Double shake', triple: 'Triple shake', right: 'Right', left: 'Left', left_straight: 'Left → Straight', right_straight: 'Right → Straight' } as const;
export type GestureKey = keyof typeof gestureNames;
export type GestureMode = 'count' | 'directional';
export type BuiltinGestureAction = 'screenshot' | 'kill_app' | 'lock' | 'photo_booth';
export type GestureAction = BuiltinGestureAction | 'none';
export type GestureActionStep =
  | { type: 'system'; action: BuiltinGestureAction }
  | { type: 'open_app'; target: 'mobile' | 'server'; appId: string; appName?: string }
  | { type: 'open_url'; target: 'mobile' | 'server'; url: string }
  | { type: 'run_command'; command: string };
export type GestureMapping = GestureAction | GestureActionStep[];
export type GestureMappings = Record<GestureKey, GestureMapping>;
export const MAX_GESTURE_ACTIONS = 20;
export type GestureOrders = Record<GestureMode, GestureKey[]>;
export const actionNames: Record<GestureAction, string> = { screenshot: 'Screenshot', kill_app: 'Kill current app', lock: 'Lock/Unlock Mac', photo_booth: 'Photo Booth', none: 'Disabled' };
export const defaultGestureMappings: GestureMappings = { single: 'screenshot', double: 'kill_app', triple: 'lock', right: 'screenshot', left: 'lock', left_straight: 'kill_app', right_straight: 'photo_booth' };
export const defaultGestureOrders: GestureOrders = { count: ['single', 'double', 'triple'], directional: ['right', 'left', 'left_straight', 'right_straight'] };
const legacyGestureKeys: Readonly<Record<string, GestureKey>> = { left_right: 'left_straight', right_left: 'right_straight' };
const legacyMappingKeys: Partial<Record<GestureKey, string>> = { left_straight: 'left_right', right_straight: 'right_left' };

export const gesturesForMode = (mode: GestureMode, orders: GestureOrders = defaultGestureOrders): GestureKey[] => [...orders[mode]];

export function sanitizeGestureOrders(value: unknown): GestureOrders {
  const saved = value && typeof value === 'object' ? value as Record<string, unknown> : {};
  const result: GestureOrders = { count: [], directional: [] };
  for (const mode of ['count', 'directional'] as const) {
    const candidates = saved[mode];
    const defaults = defaultGestureOrders[mode];
    if (Array.isArray(candidates)) {
      for (const candidate of candidates) {
        if (typeof candidate !== 'string') continue;
        const migrated = Object.hasOwn(legacyGestureKeys, candidate) ? legacyGestureKeys[candidate]! : candidate;
        // A saved canonical position takes precedence over an earlier legacy alias.
        if (migrated !== candidate && candidates.includes(migrated)) continue;
        if (defaults.includes(migrated as GestureKey) && !result[mode].includes(migrated as GestureKey)) {
          result[mode].push(migrated as GestureKey);
        }
      }
    }
    for (const gesture of defaults) if (!result[mode].includes(gesture)) result[mode].push(gesture);
  }
  return result;
}

export function reorderGesture(orders: GestureOrders, mode: GestureMode, gesture: GestureKey, destination: number): GestureOrders {
  const result: GestureOrders = { count: [...orders.count], directional: [...orders.directional] };
  const list = result[mode];
  const index = list.indexOf(gesture);
  if (index >= 0 && Number.isInteger(destination) && destination >= 0 && destination < list.length) {
    list.splice(index, 1);
    list.splice(destination, 0, gesture);
  }
  return result;
}

export function sanitizeGestureMappings(value: unknown): GestureMappings {
  const result = { ...defaultGestureMappings };
  if (!value || typeof value !== 'object') return result;
  const saved = value as Record<string, unknown>;
  for (const key of Object.keys(result) as GestureKey[]) {
    const legacy = legacyMappingKeys[key];
    const action = Object.hasOwn(saved, key) ? saved[key] : legacy && Object.hasOwn(saved, legacy) ? saved[legacy] : undefined;
    if (typeof action === 'string' && Object.hasOwn(actionNames, action)) result[key] = action as GestureAction;
    else if (Array.isArray(action)) result[key] = action.slice(0, MAX_GESTURE_ACTIONS).map(sanitizeGestureStep).filter((step): step is GestureActionStep => step !== null);
  }
  return result;
}

export function gestureAction(gesture: string, mappings: GestureMappings, capabilities: readonly string[]): SystemAction | null {
  if (!Object.hasOwn(mappings, gesture) || !capabilities.includes('system_actions')) return null;
  const action = mappings[gesture as GestureKey];
  if (Array.isArray(action)) {
    const step = action.length === 1 ? action[0] : undefined;
    return step?.type === 'system' && (step.action !== 'photo_booth' || capabilities.includes('photo_booth')) ? step.action : null;
  }
  if (action === 'none' || (action === 'photo_booth' && !capabilities.includes('photo_booth'))) return null;
  return action;
}

/** Persist executable parameters; display names never select an application. */
export function sanitizeGestureStep(value: unknown): GestureActionStep | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const step = value as Record<string, unknown>;
  if (step.type === 'system' && typeof step.action === 'string' && step.action !== 'none' && Object.hasOwn(actionNames, step.action)) return { type: 'system', action: step.action as BuiltinGestureAction };
  if (step.type === 'open_app' && (step.target === 'mobile' || step.target === 'server') && typeof step.appId === 'string' && step.appId.trim() && step.appId.length <= 2048 && !/[\u0000-\u001f\u007f]/u.test(step.appId)) {
    const result: GestureActionStep = { type: 'open_app', target: step.target, appId: step.appId };
    if (typeof step.appName === 'string' && step.appName.trim() && step.appName.length <= 160 && !/[\u0000-\u001f\u007f]/u.test(step.appName)) result.appName = step.appName.trim();
    return result;
  }
  if (step.type === 'open_url' && (step.target === 'mobile' || step.target === 'server')) {
    const url = normalizeGestureUrl(step.url);
    return url === null ? null : { type: 'open_url', target: step.target, url };
  }
  if (step.type === 'run_command' && typeof step.command === 'string' && step.command.trim() && step.command.length <= 4096 && !step.command.includes('\0')) return { type: 'run_command', command: step.command };
  return null;
}

export function gestureSteps(gesture: string, mappings: GestureMappings): GestureActionStep[] {
  if (!Object.hasOwn(mappings, gesture)) return [];
  const mapping = mappings[gesture as GestureKey];
  if (Array.isArray(mapping)) return mapping.map(step => ({ ...step }));
  return mapping === 'none' ? [] : [{ type: 'system', action: mapping }];
}

export function actionStepName(step: GestureActionStep): string {
  if (step.type === 'system') return actionNames[step.action];
  if (step.type === 'open_app') return `Open ${step.appName || step.appId} on ${step.target === 'mobile' ? 'phone' : 'Mac'}`;
  if (step.type === 'open_url') return `Open URL on ${step.target === 'mobile' ? 'Phone' : 'Mac'}`;
  return 'Run command on Mac';
}

export function gestureMappingName(mapping: GestureMapping): string {
  if (!Array.isArray(mapping)) return actionNames[mapping];
  if (!mapping.length) return 'Disabled';
  if (mapping.length === 1) return actionStepName(mapping[0]!);
  return `${mapping.length} actions`;
}
