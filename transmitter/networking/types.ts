import type { Endpoint } from './endpoint';
export type { Endpoint } from './endpoint';

export interface Identity { deviceId: string; deviceName: string }
export interface CredentialStore {
  getIdentity(): Promise<Identity>;
  getToken(serverId: string): Promise<string | null>;
  setToken(serverId: string, token: string): Promise<void>;
  removeToken(serverId: string): Promise<void>;
}
export type ConnectionStatus = 'disconnected' | 'connecting' | 'authentication_required' | 'permission_required' | 'connected' | 'reconnecting' | 'error';
export interface ConnectionSnapshot {
  status: ConnectionStatus;
  message?: string;
  serverName?: string;
  serverId?: string;
  latencyMs?: number;
  endpoint?: Endpoint;
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
