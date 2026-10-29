import { isOpenUrl } from './openUrl';
export { isOpenUrl, normalizeOpenUrl, MAX_OPEN_URL_LENGTH } from './openUrl';
import { MessageType, PROTOCOL } from './constants';
export { MessageType, PROTOCOL } from './constants';
export type Button = typeof PROTOCOL.buttons[number];
export type Modifier = typeof PROTOCOL.modifiers[number];
export type Key = typeof PROTOCOL.keys[number];
export type SystemAction = typeof PROTOCOL.systemActions[number];
export type BuiltinSystemAction = Exclude<SystemAction, 'open_app' | 'run_command' | 'open_url'>;
export type SystemActionRequest =
  | { action: BuiltinSystemAction; appId?: never; command?: never; url?: never }
  | { action: 'open_app'; appId: string; command?: never; url?: never }
  | { action: 'run_command'; command: string; appId?: never; url?: never }
  | { action: 'open_url'; url: string; appId?: never; command?: never };
export type InstalledApplication = { id: string; name: string; icon?: string };
export type SystemControl = typeof PROTOCOL.systemControls[number];
export type Direction = typeof PROTOCOL.directions[number];
export type Envelope = { v: 1; seq: number; timestamp: number };
export type ClientPayload =
  | { type: 'authentication'; deviceId: string; deviceName: string; code?: string; token?: string }
  | { type: 'mouse_move' | 'mouse_scroll'; dx: number; dy: number }
  | { type: 'mouse_down' | 'mouse_up'; button: Button }
  | { type: 'mouse_click'; button: Button; count: 1 | 2 }
  | { type: 'mouse_gesture'; gesture: 'zoom'; amount: number }
  | { type: 'mouse_gesture'; gesture: 'swipe'; direction: Direction; fingers: 2 | 3 | 4 }
  | { type: 'keyboard_down'; key: Key; modifiers: Modifier[]; repeat: boolean }
  | { type: 'keyboard_up'; key: Key; modifiers: Modifier[] }
  | { type: 'keyboard_text'; text: string }
  | ({ type: 'system_action'; id?: string } & SystemActionRequest)
  | { type: 'apps_list'; id: string; cursor?: number }
  | { type: 'system_action_status'; action: SystemAction; id: string }
  | { type: 'system_adjust'; control: SystemControl; steps: number }
  | { type: 'release_all' }
  | { type: 'ping'; id: string };
export type ServerPayload =
  | { type: 'connection'; state: 'hello' | 'ready' | 'permission_required' | 'busy'; serverId: string; name: string; permission: boolean; capabilities: string[] }
  | { type: 'authentication_result'; ok: boolean; serverId: string; permission: boolean; token?: string; error?: string }
  | { type: 'pong'; id: string }
  | { type: 'system_action_result'; id: string; action: SystemAction; ok: boolean; message?: string; state?: 'running' | 'unknown' }
  | { type: 'apps_list_result'; id: string; apps: InstalledApplication[]; nextCursor?: number; error?: string }
  | { type: 'error'; code: string; message: string };
export type ClientMessage = ClientPayload & Envelope;
export type ServerMessage = ServerPayload & Envelope;
export type Message = ClientMessage | ServerMessage;
export type SendInput = (payload: ClientPayload) => void;

export function envelope<T extends ClientPayload | ServerPayload>(payload: T, seq: number, now = Date.now()): T & Envelope {
  return { ...payload, v: 1, seq, timestamp: now };
}

const BASE = ['v', 'type', 'seq', 'timestamp'];
const fields: Record<string, string[]> = {
  connection: ['state', 'serverId', 'name', 'permission', 'capabilities'],
  authentication: ['deviceId', 'deviceName', 'code', 'token'],
  authentication_result: ['ok', 'serverId', 'permission', 'token', 'error'],
  mouse_move: ['dx', 'dy'], mouse_scroll: ['dx', 'dy'], mouse_down: ['button'], mouse_up: ['button'], mouse_click: ['button', 'count'],
  mouse_gesture: ['gesture', 'amount', 'direction', 'fingers'], keyboard_down: ['key', 'modifiers', 'repeat'], keyboard_up: ['key', 'modifiers'],
  keyboard_text: ['text'], system_action: ['action', 'id', 'appId', 'command', 'url'], system_action_status: ['action', 'id'], system_action_result: ['id', 'action', 'ok', 'message', 'state'], system_adjust: ['control', 'steps'], release_all: [], ping: ['id'], pong: ['id'], error: ['code', 'message'],
};
fields.apps_list = ['id', 'cursor'];
fields.apps_list_result = ['id', 'apps', 'nextCursor', 'error'];
const str = (x: unknown, max: number, min = 1): x is string => typeof x === 'string' && x.length >= min && x.length <= max;
const number = (x: unknown, max: number, min = -max): x is number => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const integer = (x: unknown): x is number => number(x, Number.MAX_SAFE_INTEGER, 0) && Number.isInteger(x);
const oneOf = (x: unknown, values: readonly unknown[]) => values.includes(x);
const token = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const uuid = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);

function isInstalledApplication(input: unknown): input is InstalledApplication {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const app = input as Record<string, unknown>;
  return Object.keys(app).every(key => ['id', 'name', 'icon'].includes(key)) && str(app.id, 2048) && str(app.name, 160) &&
    (app.icon === undefined || (str(app.icon, 8192) && /^data:image\/png;base64,[A-Za-z0-9+/]+=*$/.test(app.icon)));
}

export function isMessage(input: unknown): input is Message {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return false;
  const m = input as Record<string, unknown>;
  if (m.v !== PROTOCOL.version || !str(m.type, 32) || !Object.prototype.hasOwnProperty.call(fields, m.type) || !integer(m.seq) || !integer(m.timestamp)) return false;
  const allowed = [...BASE, ...fields[m.type]!];
  if (Object.keys(m).some(k => !allowed.includes(k))) return false;
  switch (m.type) {
    case MessageType.authentication:
      return uuid(m.deviceId) && str(m.deviceName, 80) &&
        ((typeof m.code === 'string' && /^\d{6}$/.test(m.code) && m.token === undefined) || (token(m.token) && m.code === undefined));
    case MessageType.connection:
      return oneOf(m.state, ['hello', 'ready', 'permission_required', 'busy']) && uuid(m.serverId) && str(m.name, 80) && typeof m.permission === 'boolean' && Array.isArray(m.capabilities) && m.capabilities.length <= 20 && m.capabilities.every(c => str(c, 40));
    case MessageType.authentication_result:
      return typeof m.ok === 'boolean' && uuid(m.serverId) && typeof m.permission === 'boolean' && (m.token === undefined || token(m.token)) && (m.error === undefined || str(m.error, 240));
    case MessageType.mouse_move:
    case MessageType.mouse_scroll: return number(m.dx, PROTOCOL.maxDelta) && number(m.dy, PROTOCOL.maxDelta);
    case MessageType.mouse_down:
    case MessageType.mouse_up: return oneOf(m.button, PROTOCOL.buttons);
    case MessageType.mouse_click: return oneOf(m.button, PROTOCOL.buttons) && oneOf(m.count, [1, 2]);
    case MessageType.mouse_gesture:
      return (m.gesture === 'zoom' && number(m.amount, 1) && m.direction === undefined && m.fingers === undefined) ||
        (m.gesture === 'swipe' && oneOf(m.direction, PROTOCOL.directions) && oneOf(m.fingers, [2, 3, 4]) && m.amount === undefined);
    case MessageType.keyboard_down:
    case MessageType.keyboard_up:
      return oneOf(m.key, PROTOCOL.keys) && Array.isArray(m.modifiers) && m.modifiers.length <= 4 && new Set(m.modifiers).size === m.modifiers.length && m.modifiers.every(k => oneOf(k, PROTOCOL.modifiers)) && (m.type !== 'keyboard_down' || typeof m.repeat === 'boolean');
    case MessageType.keyboard_text: return str(m.text, PROTOCOL.maxTextLength);
    case MessageType.system_action:
      if (!oneOf(m.action, PROTOCOL.systemActions) || (m.id !== undefined && !str(m.id, 64))) return false;
      if (m.action === 'open_app') return str(m.id, 64) && str(m.appId, 2048) && !m.appId.includes('\0') && m.command === undefined && m.url === undefined;
      if (m.action === 'run_command') return str(m.id, 64) && str(m.command, 4096) && m.command.trim().length > 0 && !m.command.includes('\0') && m.appId === undefined && m.url === undefined;
      if (m.action === 'open_url') return str(m.id, 64) && isOpenUrl(m.url) && m.appId === undefined && m.command === undefined;
      return m.appId === undefined && m.command === undefined && m.url === undefined;
    case MessageType.apps_list: return str(m.id, 64) && (m.cursor === undefined || integer(m.cursor));
    case MessageType.apps_list_result:
      return str(m.id, 64) && Array.isArray(m.apps) && m.apps.length <= 100 && m.apps.every(isInstalledApplication) &&
        (m.nextCursor === undefined || integer(m.nextCursor)) && (m.error === undefined || str(m.error, 240));
    case MessageType.system_action_status: return oneOf(m.action, PROTOCOL.systemActions) && str(m.id, 64);
    case MessageType.system_action_result:
      return str(m.id, 64) && oneOf(m.action, PROTOCOL.systemActions) && typeof m.ok === 'boolean' && (m.message === undefined || str(m.message, 240)) &&
        (m.state === undefined || (m.ok === false && oneOf(m.state, ['running', 'unknown'])));
    case MessageType.system_adjust:
      return oneOf(m.control, PROTOCOL.systemControls) && number(m.steps, PROTOCOL.maxSystemAdjustSteps) && Number.isInteger(m.steps) && m.steps !== 0;
    case MessageType.release_all: return true;
    case MessageType.ping:
    case MessageType.pong: return str(m.id, 64);
    case MessageType.error: return str(m.code, 64) && str(m.message, 240);
    default: return false;
  }
}

export function parseMessage(raw: string): Message | null {
  // UTF-8 byte bound without requiring TextEncoder on native Hermes.
  if (typeof raw !== 'string' || raw.length > PROTOCOL.maxMessageBytes) return null;
  try {
    if (unescape(encodeURIComponent(raw)).length > PROTOCOL.maxMessageBytes) return null;
    const parsed: unknown = JSON.parse(raw);
    return isMessage(parsed) ? parsed : null;
  } catch { return null; }
}
export const CLIENT_TYPES = [MessageType.authentication, MessageType.mouse_move, MessageType.mouse_scroll, MessageType.mouse_down, MessageType.mouse_up, MessageType.mouse_click, MessageType.mouse_gesture, MessageType.keyboard_down, MessageType.keyboard_up, MessageType.keyboard_text, MessageType.system_action, MessageType.system_action_status, MessageType.apps_list, MessageType.system_adjust, MessageType.release_all, MessageType.ping] as readonly string[];
export function isClientMessage(message: Message): message is ClientMessage { return CLIENT_TYPES.includes(message.type); }
