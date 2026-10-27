import type { Endpoint } from './endpoint';

export type TransportKind = 'wifi' | 'bluetooth';
export type TransportMode = 'automatic' | TransportKind;
export interface BluetoothPeer { id: string; name: string; serverId?: string }
export type TransportTarget =
  | { kind: 'wifi'; endpoint: Endpoint; expectedServerId?: string }
  | { kind: 'bluetooth'; device: BluetoothPeer; expectedServerId?: string };

/** Complete JSON messages. Framing, MTU and platform APIs belong to the transport. */
export interface Transport {
  readonly kind: TransportKind;
  readonly connected: boolean;
  readonly bufferedAmount: number;
  onMessage?: (raw: unknown) => void;
  onConnectionStateChange?: (state: 'connected' | 'disconnected' | 'error', message?: string) => void;
  connect(): void;
  disconnect(): void | Promise<void>;
  send(data: string): void;
}
export type TransportFactory = (target: TransportTarget) => Transport;
