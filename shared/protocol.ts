import { MessageType, PROTOCOL } from './constants';
export { MessageType, PROTOCOL } from './constants';
export type Button = typeof PROTOCOL.buttons[number];
export type Modifier = typeof PROTOCOL.modifiers[number];
export type Key = typeof PROTOCOL.keys[number];
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
  | { type: 'release_all' }
  | { type: 'ping'; id: string };
export type ServerPayload =
  | { type: 'connection'; state: 'hello' | 'ready' | 'permission_required' | 'busy'; serverId: string; name: string; permission: boolean; capabilities: string[] }
  | { type: 'authentication_result'; ok: boolean; serverId: string; permission: boolean; token?: string; error?: string }
  | { type: 'pong'; id: string }
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
  keyboard_text: ['text'], release_all: [], ping: ['id'], pong: ['id'], error: ['code', 'message'],
};
const str = (x: unknown, max: number, min = 1): x is string => typeof x === 'string' && x.length >= min && x.length <= max;
const number = (x: unknown, max: number, min = -max): x is number => typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max;
const integer = (x: unknown): x is number => number(x, Number.MAX_SAFE_INTEGER, 0) && Number.isInteger(x);
const oneOf = (x: unknown, values: readonly unknown[]) => values.includes(x);
const token = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{64}$/.test(x);
const uuid = (x: unknown) => typeof x === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(x);

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
export const CLIENT_TYPES = [MessageType.authentication, MessageType.mouse_move, MessageType.mouse_scroll, MessageType.mouse_down, MessageType.mouse_up, MessageType.mouse_click, MessageType.mouse_gesture, MessageType.keyboard_down, MessageType.keyboard_up, MessageType.keyboard_text, MessageType.release_all, MessageType.ping] as readonly string[];
export function isClientMessage(message: Message): message is ClientMessage { return CLIENT_TYPES.includes(message.type); }
