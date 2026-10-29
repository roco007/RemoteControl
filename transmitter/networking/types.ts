import type { TransportKind, TransportMode, BluetoothPeer } from './Transport';
import type { Endpoint } from './endpoint';
import type { SystemAction } from '../../shared/protocol';
export type { Endpoint } from './endpoint';

export interface Identity { deviceId: string; deviceName: string }
export interface CredentialStore {
  getIdentity(): Promise<Identity>;
  getToken(serverId: string): Promise<string | null>;
  setToken(serverId: string, token: string): Promise<void>;
  removeToken(serverId: string): Promise<void>;
}
export type ConnectionStatus = 'disconnected' | 'connecting' | 'authentication_required' | 'permission_required' | 'connected' | 'reconnecting' | 'error';
export interface SystemActionCompletion { id: string; action: SystemAction; ok: boolean; message?: string }
export interface PendingSystemAction { id: string; action: SystemAction; state: 'running' | 'unknown'; message: string; confirmedAt?: number }
export class SystemActionDispatchError extends Error {
  constructor(readonly delivery: 'not_sent' | 'unknown', message: string) { super(message); this.name = 'SystemActionDispatchError'; }
}
export interface ConnectionSnapshot {
  status: ConnectionStatus;
  transport?: TransportKind;
  mode?: TransportMode;
  bluetooth?: BluetoothPeer;
  retryable?: boolean;
  failureCode?: string;
  message?: string;
  serverName?: string;
  serverId?: string;
  capabilities?: string[];
  latencyMs?: number;
  endpoint?: Endpoint;
  systemAction?: PendingSystemAction;
}
export interface SocketLike {
  readyState: number;
  bufferedAmount: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}
export type SocketFactory = (url: string) => SocketLike;
