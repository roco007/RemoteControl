import { envelope, isClientMessage, isMessage, MessageType, parseMessage, type ClientPayload, type SystemAction, type InstalledApplication } from '../../shared/protocol';
import { normalizeEndpoint, type Endpoint } from './endpoint';
import { WiFiTransport } from './WiFiTransport';
import type { Transport, TransportFactory, TransportTarget } from './Transport';
import type { ConnectionSnapshot, CredentialStore, Identity, SocketFactory, SystemActionCompletion } from './types';
import { SystemActionDispatchError } from './types';
export type { Endpoint, ConnectionSnapshot, CredentialStore } from './types';

const CONNECT_TIMEOUT = 10_000;
const HEARTBEAT_INTERVAL = 5_000;
const HEARTBEAT_TIMEOUT = 16_000;
const MAX_BUFFERED_BYTES = 32_768;
const MAX_RETRIES = 8;
const ACTION_STATUS_INTERVAL = 2_000;
const ACTION_CONFIRMATION_TIMEOUT = 10_000;
export interface SystemActionParameters { appId?: string; command?: string; url?: string }
interface PendingCatalog {
  id: string; generation: number; cursor: number; apps: InstalledApplication[];
  timer?: ReturnType<typeof setTimeout>;
  promise: Promise<InstalledApplication[]>; resolve: (apps: InstalledApplication[]) => void; reject: (error: Error) => void;
}
interface PendingAction {
  id: string; action: SystemAction; serverId?: string; deviceId?: string; generation: number; lastReply: number; dispatched: boolean; minimumReplySeq: number;
  promise: Promise<SystemActionCompletion>; resolve: (result: SystemActionCompletion) => void; reject: (error: Error) => void;
}

export class RemoteClient {
  private snapshot: ConnectionSnapshot = { status: 'disconnected' };
  private listeners = new Set<() => void>();
  private transport?: Transport;
  private target?: TransportTarget;
  private closing: Promise<void> = Promise.resolve();
  whenDisconnected = () => this.closing;
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
  private pendingAction?: PendingAction;
  private pendingCatalog?: PendingCatalog;
  private nextCatalog = 0;
  private actionTimer?: ReturnType<typeof setTimeout>;
  private usedActionIds = new Set<string>();
  private readonly transportFactory: TransportFactory;

  constructor(private options: { credentials: CredentialStore; socketFactory?: SocketFactory; transportFactory?: TransportFactory; autoReconnect?: boolean; random?: () => number }) {
    this.transportFactory = options.transportFactory ?? (target => {
      if (target.kind !== 'wifi') throw Error('Bluetooth is unavailable. Install a development build.');
      return new WiFiTransport(target.endpoint, options.socketFactory);
    });
  }

  getSnapshot = (): ConnectionSnapshot => this.snapshot;
  performSystemAction = (action: SystemAction, id: string, parameters: SystemActionParameters = {}): Promise<SystemActionCompletion> => {
    const reject = (message: string) => Promise.reject(new SystemActionDispatchError('not_sent', message));
    // Only a live original native event can promote an adopted read-only token.
    const adopted = this.pendingAction?.id === id && this.pendingAction.action === action && !this.pendingAction.dispatched ? this.pendingAction : undefined;
    if (this.pendingAction && !adopted) return reject('Action in progress. Gesture recognition is paused.');
    if (this.usedActionIds.has(id) && !adopted) return reject('This gesture action was already submitted.');
    if (!this.authenticated || !this.active || this.snapshot.status !== 'connected' || !this.transport?.connected) return reject('Connect to your Mac before using gestures.');
    if (!this.snapshot.capabilities?.includes('system_actions') || !this.snapshot.capabilities.includes('action_completion')) return reject('Update the Mac receiver to support action completion.');
    if ((action === 'open_app' || action === 'run_command' || action === 'open_url' || action === 'photo_booth') && !this.snapshot.capabilities.includes(action)) return reject('Update the Mac receiver to support this action.');
    const payload = { ...parameters, type: MessageType.system_action, action, id } as Extract<ClientPayload, { type: 'system_action' }>;
    if (!isMessage(envelope(payload, 0))) return reject('Invalid gesture action request.');
    if (this.transport.bufferedAmount > MAX_BUFFERED_BYTES) return reject('Connection is busy. This gesture was not sent.');
    if (adopted && ((adopted.serverId && adopted.serverId !== this.snapshot.serverId) || (adopted.deviceId && adopted.deviceId !== this.identity?.deviceId))) return reject('Reconnect to the Mac that owns this gesture action.');
    const transport = this.transport;
    const pending = adopted ?? this.createPendingAction(action, id, this.snapshot.serverId, this.identity?.deviceId, 'running', true);
    pending.dispatched = true;
    pending.generation = this.generation; pending.lastReply = Date.now();
    pending.minimumReplySeq = this.seq + 1;
    this.updateActionState('running', 'Action in progress…');
    this.usedActionIds.add(id);
    try {
      transport.send(JSON.stringify(envelope(payload, ++this.seq)));
      this.scheduleActionQuery();
    } catch {
      // A throwing transport may already have handed bytes to the platform.
      // Keep the operation and reconcile it; never retry the action itself.
      this.markActionUnknown('Connection lost before action completion was confirmed.');
      this.fail('Connection lost while sending the gesture action.', this.generation);
    }
    return pending.promise;
  };

  /** Catalogs travel over the paired transport, with one bounded page per reply. */
  listInstalledApps = (): Promise<InstalledApplication[]> => {
    if (!this.authenticated || !this.active || !this.transport?.connected) return Promise.reject(Error('Connect to your Mac to list its apps.'));
    if (!this.snapshot.capabilities?.includes('app_catalog')) return Promise.reject(Error('Update the Mac receiver to list installed apps.'));
    if (this.pendingCatalog) return this.pendingCatalog.promise;
    let resolve!: PendingCatalog['resolve']; let reject!: PendingCatalog['reject'];
    const promise = new Promise<InstalledApplication[]>((yes, no) => { resolve = yes; reject = no; });
    this.pendingCatalog = { id: `apps-${Date.now()}-${++this.nextCatalog}`, generation: this.generation, cursor: 0, apps: [], promise, resolve, reject };
    this.requestCatalogPage();
    return promise;
  };
  private requestCatalogPage() {
    const pending = this.pendingCatalog;
    if (!pending) return;
    clearTimeout(pending.timer);
    pending.timer = setTimeout(() => this.failCatalog('The Mac app list timed out. Try refreshing.'), 15_000);
    if (!this.write({ type: MessageType.apps_list, id: pending.id, cursor: pending.cursor })) this.failCatalog('Connection changed while loading the Mac app list.');
  }
  private failCatalog(message: string) {
    const pending = this.pendingCatalog;
    if (!pending) return;
    this.pendingCatalog = undefined; clearTimeout(pending.timer); pending.reject(Error(message));
  }

  /** Adopt a native operation after JS remount. This only sends status queries. */
  trackSystemAction = (action: SystemAction, id: string, serverId?: string, deviceId?: string): Promise<SystemActionCompletion> => {
    if (this.pendingAction) {
      if (this.pendingAction.id === id && this.pendingAction.action === action && (!serverId || this.pendingAction.serverId === serverId) && (!deviceId || this.pendingAction.deviceId === deviceId)) { this.queryPendingAction(); return this.pendingAction.promise; }
      return Promise.reject(new SystemActionDispatchError('not_sent', 'Another gesture action is already pending.'));
    }
    if (!isMessage(envelope({ type: MessageType.system_action_status, action, id }, 0))) return Promise.reject(new SystemActionDispatchError('not_sent', 'Invalid gesture operation.'));
    const pending = this.createPendingAction(action, id, serverId ?? this.snapshot.serverId, deviceId ?? this.identity?.deviceId, 'unknown');
    this.usedActionIds.add(id);
    this.queryPendingAction();
    return pending.promise;
  };

  /** Explicit user recovery. Resetting does not claim that the Mac action finished. */
  resumeSystemActions = (id: string, nativeResetConfirmed = false): boolean => {
    if (this.pendingAction?.id !== id || (!nativeResetConfirmed && this.snapshot.systemAction?.state !== 'unknown')) return false;
    this.abandonPendingAction('Gesture recognition was resumed before completion could be confirmed.');
    return true;
  };
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
    await this.connectTarget({ kind: 'wifi', endpoint: normalized });
  }

  async connectTarget(target: TransportTarget): Promise<void> {
    this.disconnect(false);
    this.target = target;
    this.endpoint = target.kind === 'wifi' ? target.endpoint : undefined;
    this.retries = 0;
    this.desired = true;
    const gen = this.generation;
    await this.closing;
    if (gen === this.generation) await this.open();
  }

  reconnect = (): void => {
    if (!this.target) return;
    this.disconnect(false);
    this.desired = true;
    this.retries = 0;
    void this.open();
  };

  private async open(): Promise<void> {
    if (!this.target || !this.desired || !this.active) return;
    const gen = ++this.generation;
    this.authenticated = false;
    this.seq = 0;
    this.update({ status: this.retries ? 'reconnecting' : 'connecting', endpoint: this.endpoint, transport: this.target.kind, retryable: undefined, failureCode: undefined, message: undefined, serverId: undefined, serverName: undefined, latencyMs: undefined, capabilities: [] });
    try {
      this.identity = await this.options.credentials.getIdentity();
      if (gen !== this.generation || !this.desired || !this.active) return;
      const transport = this.transportFactory(this.target);
      this.transport = transport;
      const timeout = this.target.kind === 'bluetooth' ? 45_000 : CONNECT_TIMEOUT;
      this.connectTimer = setTimeout(() => this.fail(this.target?.kind === 'bluetooth' ? 'Bluetooth connection timed out. Check permissions, pairing and that the Mac is awake.' : 'Connection timed out. Check the Mac address, Wi-Fi and receiver.', gen), timeout);
      transport.onMessage = raw => { if (gen === this.generation) void this.receive(raw, gen); };
      transport.onConnectionStateChange = (state, message) => {
        if (state !== 'connected') this.fail(message ?? 'Connection lost.', gen);
      };
      transport.connect();
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
          if (message.state === 'busy') { this.fail('This Mac is being controlled by another device. Waiting for it to release control.', gen, this.options.autoReconnect === false, 'receiver_busy'); return; }
          if (message.state === 'hello') {
            if (this.target?.expectedServerId && message.serverId !== this.target.expectedServerId) { this.fail('Receiver identity does not match the saved Mac. Select and pair the correct receiver.', gen, false); return; }
            if (this.snapshot.serverId) { this.fail('Unexpected receiver greeting.', gen, false); return; }
            this.receiverPermission = message.permission;
            this.update({ serverId: message.serverId, serverName: message.name, capabilities: message.capabilities, status: this.retries ? 'reconnecting' : 'connecting', message: 'Checking saved pairing…' });
            this.startHeartbeat(gen);
            const savedToken = await this.options.credentials.getToken(message.serverId);
            if (gen !== this.generation) return;
            clearTimeout(this.connectTimer);
            if (savedToken && this.identity) this.authenticate({ type: MessageType.authentication, ...this.identity, token: savedToken });
            else this.update({ status: 'authentication_required', message: 'Enter the pairing code shown on your Mac.' });
          } else if (message.serverId === this.snapshot.serverId) {
            this.receiverPermission = message.permission;
            if (this.authenticated) {
              this.update({ status: message.permission ? 'connected' : 'permission_required', capabilities: message.capabilities, message: message.permission ? undefined : 'Enable Accessibility for Remote Mac Control on your Mac.' });
              this.queryPendingAction();
            }
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
          this.queryPendingAction();
          break;
        }
        case MessageType.apps_list_result: {
          const pending = this.pendingCatalog;
          if (!this.authenticated || !pending || pending.generation !== gen || pending.id !== message.id) break;
          clearTimeout(pending.timer);
          if (message.error) { this.failCatalog(message.error); break; }
          pending.apps.push(...message.apps);
          if (pending.apps.length > 10_000 || (message.nextCursor !== undefined && message.nextCursor <= pending.cursor)) { this.failCatalog('The Mac sent an invalid app-list page.'); break; }
          if (message.nextCursor !== undefined) {
            pending.cursor = message.nextCursor;
            pending.id = `apps-${Date.now()}-${++this.nextCatalog}`;
            this.requestCatalogPage();
          } else {
            this.pendingCatalog = undefined;
            const unique = new Map(pending.apps.map(app => [app.id, app]));
            pending.resolve([...unique.values()]);
          }
          break;
        }
        case MessageType.system_action_result: {
          const pending = this.pendingAction;
          if (!this.authenticated || !pending || pending.generation !== gen || pending.id !== message.id || pending.action !== message.action || message.seq < pending.minimumReplySeq) break;
          pending.lastReply = Date.now();
          if (message.state) {
            if (message.state === 'unknown') this.markActionUnknown(message.message || 'Action completion is unknown. Resume gestures when ready.');
            else { pending.dispatched = true; this.updateActionState('running', message.message || 'Action in progress…', pending.lastReply); this.scheduleActionQuery(); }
          } else {
            clearTimeout(this.actionTimer); this.actionTimer = undefined;
            this.pendingAction = undefined;
            this.update({ systemAction: undefined, message: message.ok ? undefined : message.message || 'The Mac could not complete this action.' });
            pending.resolve({ id: message.id, action: message.action, ok: message.ok, message: message.message });
          }
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
    // Actions and their status requests go through the correlated API only.
    if (payload.type === MessageType.system_action || payload.type === MessageType.system_action_status || payload.type === MessageType.apps_list) return false;
    if (payload.type === MessageType.system_adjust && !this.snapshot.capabilities?.includes('system_adjust')) return false;
    return this.write(payload);
  };

  private createPendingAction(action: SystemAction, id: string, serverId: string | undefined, deviceId: string | undefined, state: 'running' | 'unknown', dispatched = false) {
    let resolve!: PendingAction['resolve']; let reject!: PendingAction['reject'];
    const promise = new Promise<SystemActionCompletion>((yes, no) => { resolve = yes; reject = no; });
    const pending: PendingAction = { action, id, serverId, deviceId, generation: this.generation, lastReply: Date.now(), dispatched, minimumReplySeq: 0, promise, resolve, reject };
    this.pendingAction = pending;
    this.updateActionState(state, state === 'running' ? 'Action in progress…' : 'Checking action completion…');
    return pending;
  }
  private updateActionState(state: 'running' | 'unknown', message: string, confirmedAt?: number) {
    const pending = this.pendingAction;
    if (pending) this.update({ systemAction: { id: pending.id, action: pending.action, state, message, confirmedAt } });
  }
  private markActionUnknown(message: string) {
    clearTimeout(this.actionTimer); this.actionTimer = undefined;
    this.updateActionState('unknown', message);
  }
  private scheduleActionQuery() {
    clearTimeout(this.actionTimer);
    if (!this.pendingAction) return;
    this.actionTimer = setTimeout(() => {
      this.actionTimer = undefined;
      if (!this.pendingAction) return;
      if (Date.now() - this.pendingAction.lastReply >= ACTION_CONFIRMATION_TIMEOUT) {
        this.markActionUnknown('Action completion is unknown. Resume gestures when ready.');
      } else this.queryPendingAction();
    }, ACTION_STATUS_INTERVAL);
  }
  private queryPendingAction() {
    const pending = this.pendingAction;
    if (!pending || !this.authenticated || !this.active || !this.transport?.connected) return;
    if ((pending.serverId && pending.serverId !== this.snapshot.serverId) || (pending.deviceId && pending.deviceId !== this.identity?.deviceId)) {
      this.markActionUnknown('This action belongs to the previous Mac connection.'); return;
    }
    if (!this.snapshot.capabilities?.includes('action_completion')) {
      this.markActionUnknown('Update the Mac receiver to confirm action completion.'); return;
    }
    if (pending.generation !== this.generation) { pending.generation = this.generation; pending.lastReply = Date.now(); pending.minimumReplySeq = this.seq + 1; }
    pending.serverId ??= this.snapshot.serverId; pending.deviceId ??= this.identity?.deviceId;
    if (this.write({ type: MessageType.system_action_status, id: pending.id, action: pending.action })) this.scheduleActionQuery();
  }
  private abandonPendingAction(message: string) {
    const pending = this.pendingAction;
    if (!pending) return;
    clearTimeout(this.actionTimer); this.actionTimer = undefined; this.pendingAction = undefined;
    this.update({ systemAction: undefined });
    pending.reject(new SystemActionDispatchError('unknown', message));
  }

  private write(payload: ClientPayload): boolean {
    const transport = this.transport;
    if (!transport || !transport.connected) return false;
    if (transport.bufferedAmount > MAX_BUFFERED_BYTES) {
      // Never queue delayed button releases or replay stale movement after congestion.
      this.fail('Network is too slow for safe input. Reconnecting…', this.generation);
      return false;
    }
    const message = envelope(payload, ++this.seq);
    if (!isMessage(message)) return false;
    try { transport.send(JSON.stringify(message)); return true; }
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

  private fail(message: string, gen: number, retry = true, failureCode?: string) {
    if (gen !== this.generation) return;
    this.closeSocket();
    const shouldRetry = retry && this.options.autoReconnect !== false && this.desired && this.active && this.retries < MAX_RETRIES;
    this.update({ status: shouldRetry ? 'reconnecting' : 'error', message, retryable: retry, failureCode });
    if (!shouldRetry) { this.desired = false; return; }
    const delay = Math.min(15_000, 500 * 2 ** this.retries++) * (0.8 + (this.options.random?.() ?? Math.random()) * 0.4);
    this.retryTimer = setTimeout(() => void this.open(), delay);
  }

  private closeSocket() {
    this.failCatalog('Connection changed while loading the Mac app list.');
    if (this.pendingAction) this.markActionUnknown('Connection changed before action completion was confirmed.');
    ++this.generation;
    clearTimeout(this.connectTimer);
    clearTimeout(this.authTimer);
    clearTimeout(this.retryTimer);
    clearInterval(this.heartbeatTimer);
    this.pendingPing = undefined;
    this.authenticated = false;
    this.authenticationPending = false;
    const transport = this.transport;
    this.transport = undefined;
    if (transport) {
      transport.onMessage = transport.onConnectionStateChange = undefined;
      try {
        const close = transport.disconnect();
        this.closing = Promise.all([this.closing, close]).then(() => {}, () => {});
      } catch { /* A failed platform shutdown must not crash the input UI. */ }
    }
  }

  disconnect = (clearIntent = true): void => {
    if (this.authenticated) this.write({ type: MessageType.release_all });
    if (clearIntent) this.desired = false;
    this.closeSocket();
    this.update({ status: 'disconnected', message: undefined, latencyMs: undefined, capabilities: [] });
  };

  setActive = (active: boolean): void => {
    if (this.active === active) return;
    if (!active) { this.disconnect(false); this.active = false; }
    else { this.active = true; if (this.desired) { this.retries = 0; void this.open(); } }
  };

  dispose = (): void => { this.disconnect(); this.abandonPendingAction('The connection was closed before completion was confirmed.'); this.listeners.clear(); };
}
