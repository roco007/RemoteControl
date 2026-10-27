import { endpointURL, type Endpoint } from './endpoint';
import { createSocket } from './socketFactory';
import type { SocketFactory, SocketLike } from './types';
import type { Transport } from './Transport';

/** Retains the existing WebSocket implementation, port, protocol and native Origin. */
export class WiFiTransport implements Transport {
  readonly kind = 'wifi';
  private socket?: SocketLike;
  onMessage?: Transport['onMessage'];
  onConnectionStateChange?: Transport['onConnectionStateChange'];
  constructor(private endpoint: Endpoint, private factory: SocketFactory = createSocket) {}
  get connected() { return this.socket?.readyState === 1; }
  get bufferedAmount() { return this.socket?.bufferedAmount ?? 0; }
  connect() {
    this.disconnect();
    const socket = this.factory(endpointURL(this.endpoint));
    this.socket = socket;
    socket.onopen = () => this.onConnectionStateChange?.('connected');
    socket.onmessage = event => this.onMessage?.(event.data);
    socket.onerror = () => this.onConnectionStateChange?.('error', 'Receiver unavailable. Check that both devices are on the same network.');
    socket.onclose = () => this.onConnectionStateChange?.('disconnected', 'Wi-Fi connection lost.');
  }
  send(data: string) { if (!this.connected) throw Error('Wi-Fi is disconnected.'); this.socket!.send(data); }
  disconnect() {
    const socket = this.socket; this.socket = undefined;
    if (!socket) return;
    socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
    try { socket.close(1000, 'Controller disconnected'); } catch { /* Already closed. */ }
  }
}
