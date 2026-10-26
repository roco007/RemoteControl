import { envelope, isClientMessage, isMessage, MessageType, parseMessage, type ClientPayload } from '../../shared/protocol';
import { endpointURL, normalizeEndpoint, type Endpoint } from './endpoint';
import { createSocket } from './socketFactory';
import type { ConnectionSnapshot, CredentialStore, Identity, SocketFactory, SocketLike } from './types';
export type { Endpoint, ConnectionSnapshot, CredentialStore } from './types';

const CONNECT_TIMEOUT = 10_000;
const HEARTBEAT_INTERVAL = 5_000;
const HEARTBEAT_TIMEOUT = 16_000;
const MAX_BUFFERED_BYTES = 32_768;
const MAX_RETRIES = 8;

export class RemoteClient {
  private snapshot: ConnectionSnapshot = { status: 'disconnected' };
  private listeners = new Set<() => void>();
  private socket?: SocketLike;
  private identity?: Identity;
  private seq = 0;
  private generation = 0;
  private authenticated = false;
  private receiverPermission = false;
  private desired = false;
  private active = true;
  private retries = 0;
  private endpoint?: Endpoint;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private connectTimer?: ReturnType<typeof setTimeout>;
  private authTimer?: ReturnType<typeof setTimeout>;
  private authenticationPending = false;
  private heartbeatTimer?: ReturnType<typeof setInterval>;
  private lastPong = 0;
  private pendingPing?: { id: string; sent: number };
  private readonly socketFactory: SocketFactory;

  constructor(private options: { credentials: CredentialStore; socketFactory?: SocketFactory; random?: () => number }) {
    this.socketFactory = options.socketFactory ?? createSocket;
  }

  getSnapshot = (): ConnectionSnapshot => this.snapshot;
  subscribe = (listener: () => void): (() => void) => { this.listeners.add(listener); return () => this.listeners.delete(listener); };
  private update(patch: Partial<ConnectionSnapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.listeners.forEach(listener => listener());
  }

  async connect(endpoint: Endpoint): Promise<void> {
    let normalized: Endpoint;
    try { normalized = normalizeEndpoint(endpoint); }
    catch (error) {
      this.disconnect();
      this.update({ status: 'error', message: error instanceof Error ? error.message : 'Invalid address.' });
      return;
    }
    this.disconnect(false);
    this.endpoint = normalized;
    this.retries = 0;
    this.desired = true;
    await this.open();
  }

  reconnect = (): void => {
    if (!this.endpoint) return;
    this.disconnect(false);
    this.desired = true;
    this.retries = 0;
    void this.open();
  };

  private async open(): Promise<void> {
    if (!this.endpoint || !this.desired || !this.active) return;
    const gen = ++this.generation;
    this.authenticated = false;
    this.seq = 0;
    this.update({ status: this.retries ? 'reconnecting' : 'connecting', endpoint: this.endpoint, message: undefined, serverId: undefined, serverName: undefined, latencyMs: undefined });
    try {
      this.identity = await this.options.credentials.getIdentity();
      if (gen !== this.generation || !this.desired || !this.active) return;
      const socket = this.socketFactory(endpointURL(this.endpoint));
      this.socket = socket;
      this.connectTimer = setTimeout(() => this.fail('Connection timed out. Check the Mac address, Wi-Fi and receiver.', gen), CONNECT_TIMEOUT);
      socket.onopen = () => { /* Wait for the receiver identity before authentication. */ };
      socket.onmessage = event => { if (gen === this.generation) void this.receive(event.data, gen); };
      socket.onerror = () => this.fail('Receiver unavailable. Check that both devices are on the same network.', gen);
      socket.onclose = () => this.fail('Connection lost.', gen);
    } catch {
      this.fail('Could not initialize the connection or secure device credentials.', gen);
    }
  }

  private async receive(raw: unknown, gen: number): Promise<void> {
    const message = typeof raw === 'string' ? parseMessage(raw) : null;
    if (!message || isClientMessage(message)) { this.fail('Receiver sent an invalid protocol message.', gen, false); return; }
    try {
      switch (message.type) {
        case MessageType.connection: {
          if (message.state === 'busy') { this.fail('This Mac is being controlled by another device.', gen, false); return; }
          if (message.state === 'hello') {
            if (this.snapshot.serverId) { this.fail('Unexpected receiver greeting.', gen, false); return; }
            this.receiverPermission = message.permission;
            this.update({ serverId: message.serverId, serverName: message.name, status: this.retries ? 'reconnecting' : 'connecting', message: 'Checking saved pairing…' });
            this.startHeartbeat(gen);
            const savedToken = await this.options.credentials.getToken(message.serverId);
            if (gen !== this.generation) return;
            clearTimeout(this.connectTimer);
            if (savedToken && this.identity) this.authenticate({ type: MessageType.authentication, ...this.identity, token: savedToken });
            else this.update({ status: 'authentication_required', message: 'Enter the pairing code shown on your Mac.' });
          } else if (message.serverId === this.snapshot.serverId) {
            this.receiverPermission = message.permission;
            if (this.authenticated) this.update({ status: message.permission ? 'connected' : 'permission_required', message: message.permission ? undefined : 'Enable Accessibility for Remote Mac Control on your Mac.' });
          }
          break;
        }
        case MessageType.authentication_result: {
          if (!this.snapshot.serverId || message.serverId !== this.snapshot.serverId) { this.fail('Receiver identity changed during pairing.', gen, false); return; }
          if (!this.authenticationPending) { this.fail('Unexpected authentication result.', gen, false); return; }
          this.authenticationPending = false;
          clearTimeout(this.authTimer);
          this.receiverPermission = message.permission;
          if (!message.ok) {
            this.authenticated = false;
            await this.options.credentials.removeToken(message.serverId);
            if (gen !== this.generation) return;
            this.update({ status: 'authentication_required', message: message.error ?? 'Invalid pairing code. Try the current code on your Mac.' });
            return;
          }
          if (message.token) await this.options.credentials.setToken(message.serverId, message.token);
          if (gen !== this.generation) return;
          this.authenticated = true;
          this.retries = 0;
          this.update({ status: this.receiverPermission ? 'connected' : 'permission_required', message: this.receiverPermission ? undefined : 'Enable Accessibility for Remote Mac Control on your Mac.' });
          break;
        }
        case MessageType.pong:
          if (this.pendingPing?.id === message.id) {
            this.lastPong = Date.now();
            this.update({ latencyMs: Math.max(0, Date.now() - this.pendingPing.sent) });
            this.pendingPing = undefined;
          }
          break;
        case MessageType.error:
          if (message.code === 'permission_required' && this.authenticated) this.update({ status: 'permission_required', message: message.message });
          else if (['unauthorized', 'revoked', 'device_revoked'].includes(message.code)) {
            const serverId = this.snapshot.serverId;
            // Stop retry synchronously: the receiver can close immediately after
            // this error, while SecureStore still has an asynchronous write pending.
            this.fail(message.message, gen, false);
            if (serverId) await this.options.credentials.removeToken(serverId);
          }
          else if (['authentication_timeout', 'rate_limited', 'replayed_message', 'malformed_message', 'invalid_direction'].includes(message.code)) this.fail(message.message, gen, false);
          else this.update({ message: message.message });
          break;
      }
    } catch { this.fail('Secure credential storage failed. Unlock the phone and reconnect.', gen, false); }
  }

  pair = (code: string): boolean => {
    if (this.snapshot.status !== 'authentication_required' || !this.identity || !this.snapshot.serverId || this.authenticationPending) return false;
    if (!/^\d{6}$/.test(code)) { this.update({ message: 'The pairing code must contain six digits.' }); return false; }
    this.update({ message: 'Checking pairing code…' });
    return this.authenticate({ type: MessageType.authentication, ...this.identity, code });
  };

  private authenticate(payload: Extract<ClientPayload, { type: 'authentication' }>): boolean {
    this.authenticationPending = true;
    const gen = this.generation;
    clearTimeout(this.authTimer);
    this.authTimer = setTimeout(() => this.fail('Pairing timed out. Reconnect and try the current code.', gen, false), CONNECT_TIMEOUT);
    if (this.write(payload)) return true;
    this.authenticationPending = false;
    clearTimeout(this.authTimer);
    return false;
  }

  send = (payload: ClientPayload): boolean => {
    if (!this.authenticated || !this.active) return false;
    if (this.snapshot.status !== 'connected' && payload.type !== MessageType.release_all) return false;
    return this.write(payload);
  };

  private write(payload: ClientPayload): boolean {
    const socket = this.socket;
    if (!socket || socket.readyState !== 1) return false;
    if (socket.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Never queue delayed button releases or replay stale movement after congestion.
      this.fail('Network is too slow for safe input. Reconnecting…', this.generation);
      return false;
    }
    const message = envelope(payload, ++this.seq);
    if (!isMessage(message)) return false;
    try { socket.send(JSON.stringify(message)); return true; }
    catch { this.fail('Connection lost while sending input.', this.generation); return false; }
  }

  private startHeartbeat(gen: number) {
    clearInterval(this.heartbeatTimer);
    this.lastPong = Date.now();
    this.heartbeatTimer = setInterval(() => {
      if (gen !== this.generation) return;
      if (Date.now() - this.lastPong > HEARTBEAT_TIMEOUT) { this.fail('The Mac stopped responding.', gen); return; }
      // Keep one outstanding ID, so a delayed response still satisfies the heartbeat.
      if (!this.pendingPing) {
        this.pendingPing = { id: `${Date.now()}-${this.seq}`, sent: Date.now() };
        this.write({ type: MessageType.ping, id: this.pendingPing.id });
      }
    }, HEARTBEAT_INTERVAL);
  }

  private fail(message: string, gen: number, retry = true) {
    if (gen !== this.generation) return;
    this.closeSocket();
    const shouldRetry = retry && this.desired && this.active && this.retries < MAX_RETRIES;
    this.update({ status: shouldRetry ? 'reconnecting' : 'error', message });
    if (!shouldRetry) { this.desired = false; return; }
    const delay = Math.min(15_000, 500 * 2 ** this.retries++) * (0.8 + (this.options.random?.() ?? Math.random()) * 0.4);
    this.retryTimer = setTimeout(() => void this.open(), delay);
  }

  private closeSocket() {
    ++this.generation;
    clearTimeout(this.connectTimer);
    clearTimeout(this.authTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    this.pendingPing = undefined;
    this.authenticated = false;
    this.authenticationPending = false;
    const socket = this.socket;
    this.socket = undefined;
    if (socket) {
      socket.onopen = socket.onclose = socket.onerror = socket.onmessage = null;
      try { socket.close(1000, 'Controller disconnected'); } catch { /* Already closed. */ }
    }
  }

  disconnect = (clearIntent = true): void => {
    if (this.authenticated) this.write({ type: MessageType.release_all });
    if (clearIntent) this.desired = false;
    this.closeSocket();
    this.update({ status: 'disconnected', message: undefined, latencyMs: undefined });
  };

  setActive = (active: boolean): void => {
    if (this.active === active) return;
    if (!active) { this.disconnect(false); this.active = false; }
    else { this.active = true; if (this.desired) { this.retries = 0; void this.open(); } }
  };

  dispose = (): void => { this.disconnect(); this.listeners.clear(); };
}
