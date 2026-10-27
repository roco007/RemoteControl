import { isClientMessage, parseMessage, type ClientPayload } from '../../shared/protocol';
import type { BleBridge } from '../modules/bluetooth-transport';
import { RemoteClient } from './RemoteClient';
import { BluetoothTransport } from './BluetoothTransport';
import { WiFiTransport } from './WiFiTransport';
import { normalizeEndpoint, type Endpoint } from './endpoint';
import type { BluetoothPeer, Transport, TransportFactory, TransportKind, TransportMode, TransportTarget } from './Transport';
import type { ConnectionSnapshot, CredentialStore, SocketFactory } from './types';

export interface ConnectionConfiguration { mode: TransportMode; endpoint?: Endpoint; bluetooth?: BluetoothPeer }
interface Options {
  credentials: CredentialStore;
  bluetooth?: BleBridge | null;
  transportFactory?: TransportFactory;
  socketFactory?: SocketFactory;
  random?: () => number;
  onBluetoothPaired?: (peer: BluetoothPeer) => void;
}
/** Owns one authenticated session. A recovery probe never sends authentication or input. */
export class ConnectionManager {
  private config: ConnectionConfiguration = { mode: 'automatic' };
  private snapshot: ConnectionSnapshot = { status: 'disconnected', mode: 'automatic' };
  private listeners = new Set<() => void>();
  private client: RemoteClient;
  private factory: TransportFactory;
  private desired = false;
  private active = true;
  private attempts = 0;
  private generation = 0;
  private retryTimer?: ReturnType<typeof setTimeout>;
  private probeTimer?: ReturnType<typeof setTimeout>;
  private probeTimeout?: ReturnType<typeof setTimeout>;
  private probe?: Transport;
  private expectedServerId?: string;
  private configVersion = 0;
  private sessionConfigVersion = -1;
  private unsubscribe: () => void;
  constructor(private options: Options) {
    this.factory = options.transportFactory ?? (target => target.kind === 'wifi'
      ? new WiFiTransport(target.endpoint, options.socketFactory)
      : new BluetoothTransport(options.bluetooth, target.device.id));
    this.client = new RemoteClient({ credentials: options.credentials, transportFactory: this.factory, autoReconnect: false });
    this.unsubscribe = this.client.subscribe(this.changed);
  }
  getSnapshot = () => this.snapshot;
  subscribe = (listener: () => void) => { this.listeners.add(listener); return () => { this.listeners.delete(listener); }; };
  private publish(value: ConnectionSnapshot) {
    this.snapshot = { ...value, mode: this.config.mode, bluetooth: this.config.bluetooth };
    this.listeners.forEach(listener => listener());
  }
  configure(config: ConnectionConfiguration) {
    if (config.endpoint?.host !== this.config.endpoint?.host || config.endpoint?.port !== this.config.endpoint?.port || config.bluetooth?.id !== this.config.bluetooth?.id || config.mode !== this.config.mode) { this.expectedServerId = undefined; ++this.configVersion; }
    this.config = { ...config, bluetooth: config.bluetooth ? { ...config.bluetooth } : undefined };
    this.publish(this.snapshot);
  }
  private target(kind: TransportKind): TransportTarget | undefined {
    if (kind === 'wifi' && this.config.endpoint) return { kind, endpoint: normalizeEndpoint(this.config.endpoint), expectedServerId: this.expectedServerId ?? (this.config.mode === 'automatic' ? this.config.bluetooth?.serverId : undefined) };
    if (kind === 'bluetooth' && this.config.bluetooth) return { kind, device: this.config.bluetooth, expectedServerId: this.expectedServerId ?? this.config.bluetooth.serverId };
    return undefined;
  }
  async connect(endpoint?: Endpoint) {
    if (endpoint) this.configure({ ...this.config, endpoint });
    this.desired = true; this.attempts = 0;
    await this.open(this.config.mode === 'bluetooth' || (!this.config.endpoint && this.config.mode === 'automatic') ? 'bluetooth' : 'wifi');
  }
  reconnect = () => { void this.connect(); };
  private async open(kind: TransportKind) {
    if (!this.desired || !this.active) return;
    this.clearTimers(); const gen = ++this.generation;
    // release_all + close occurs before constructing any replacement transport.
    this.client.disconnect();
    await this.client.whenDisconnected();
    if (gen !== this.generation || !this.desired || !this.active) return;
    try {
      const target = this.target(kind);
      if (!target) {
        this.desired = false;
        this.publish({ status: 'error', message: kind === 'bluetooth' ? 'Choose your Mac in Bluetooth discovery first.' : 'Enter the Mac Wi-Fi address first.' });
        return;
      }
      this.sessionConfigVersion = this.configVersion;
      await this.client.connectTarget(target);
    } catch (error) {
      this.desired = false;
      this.publish({ status: 'error', message: error instanceof Error ? error.message : 'Unable to connect.' });
    }
  }
  private changed = () => {
    const value = this.client.getSnapshot();
    if (value.status === 'connected' || value.status === 'permission_required') {
      this.attempts = 0;
      if (this.sessionConfigVersion === this.configVersion) this.expectedServerId = value.serverId;
      if (this.sessionConfigVersion === this.configVersion && value.transport === 'bluetooth' && this.config.bluetooth && value.serverId && this.config.bluetooth.serverId !== value.serverId) {
        this.config.bluetooth = { ...this.config.bluetooth, serverId: value.serverId, name: value.serverName ?? this.config.bluetooth.name };
        this.options.onBluetoothPaired?.(this.config.bluetooth);
      }
      this.publish(value);
      if (value.transport === 'bluetooth') this.scheduleProbe();
      return;
    }
    if (value.status !== 'error' || !this.desired || !this.active) { this.publish(value); return; }
    this.clearTimers();
    if (!value.retryable) { this.desired = false; this.publish(value); return; }
    const kind = value.failureCode === 'receiver_busy' && value.transport ? value.transport : this.config.mode === 'automatic'
      ? value.transport === 'wifi' && this.config.bluetooth ? 'bluetooth' : this.config.endpoint ? 'wifi' : 'bluetooth'
      : this.config.mode;
    const delay = Math.min(15_000, 500 * 2 ** Math.min(this.attempts++, 6)) * (0.8 + (this.options.random?.() ?? Math.random()) * 0.4);
    this.publish({ ...value, status: 'reconnecting', message: `${value.message ?? 'Disconnected.'} Retrying ${kind === 'wifi' ? 'Wi-Fi' : 'Bluetooth'}…` });
    const gen = this.generation;
    this.retryTimer = setTimeout(() => { if (gen === this.generation) void this.open(kind); }, delay);
  };
  private scheduleProbe() {
    if (this.config.mode !== 'automatic' || !this.config.endpoint || !this.desired || !this.active || this.probe || this.probeTimer) return;
    this.probeTimer = setTimeout(() => { this.probeTimer = undefined; this.startProbe(); }, 15_000);
  }
  private startProbe() {
    if (!this.desired || !this.active || this.snapshot.transport !== 'bluetooth' || this.config.mode !== 'automatic' || !this.config.endpoint) return;
    const gen = this.generation;
    try {
      const probe = this.factory({ kind: 'wifi', endpoint: normalizeEndpoint(this.config.endpoint) }); this.probe = probe;
      const finish = (available: boolean) => {
        if (this.probe !== probe || gen !== this.generation) return;
        this.closeProbe();
        if (available) void this.open('wifi'); else this.scheduleProbe();
      };
      probe.onMessage = raw => {
        const message = typeof raw === 'string' ? parseMessage(raw) : null;
        finish(!!message && !isClientMessage(message) && message.type === 'connection' && message.state === 'hello' && message.serverId === this.expectedServerId);
      };
      probe.onConnectionStateChange = state => { if (state !== 'connected') finish(false); };
      this.probeTimeout = setTimeout(() => finish(false), 4_000);
      probe.connect();
    } catch { this.closeProbe(); this.scheduleProbe(); }
  }
  private closeProbe() {
    clearTimeout(this.probeTimeout); this.probeTimeout = undefined;
    const probe = this.probe; this.probe = undefined;
    if (probe) { probe.onMessage = probe.onConnectionStateChange = undefined; probe.disconnect(); }
  }
  private clearTimers() {
    clearTimeout(this.retryTimer); this.retryTimer = undefined;
    clearTimeout(this.probeTimer); this.probeTimer = undefined;
    this.closeProbe();
  }
  send = (payload: ClientPayload) => this.desired && this.active && this.client.send(payload);
  pair = (code: string) => this.client.pair(code);
  disconnect = () => {
    this.desired = false; ++this.generation; this.clearTimers(); this.client.disconnect();
  };
  setActive = (active: boolean) => {
    if (this.active === active) return;
    this.active = active;
    if (!active) { ++this.generation; this.clearTimers(); this.client.disconnect(); }
    else if (this.desired) this.reconnect();
  };
  dispose = () => { this.disconnect(); this.unsubscribe(); this.client.dispose(); this.listeners.clear(); };
}
