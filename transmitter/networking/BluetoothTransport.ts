import { PROTOCOL } from '../../shared/protocol';
import type { BleBridge } from '../modules/bluetooth-transport';
import type { Transport } from './Transport';

export const BLE = {
  service: '9D4B0001-7A8B-4E9A-AF33-6C7D8E9F0010',
  write: '9D4B0002-7A8B-4E9A-AF33-6C7D8E9F0010',
  notify: '9D4B0003-7A8B-4E9A-AF33-6C7D8E9F0010',
} as const;
export const bluetoothUnavailableReason = 'Bluetooth requires a physical phone with a new Expo development or release build. It is unavailable in Expo Go and the browser preview.';

// The bridge is process-wide: serialize teardown before a later transport connects.
const cleanup = new WeakMap<BleBridge, Promise<void>>();
export class BluetoothTransport implements Transport {
  readonly kind = 'bluetooth';
  connected = false;
  bufferedAmount = 0;
  onMessage?: Transport['onMessage'];
  onConnectionStateChange?: Transport['onConnectionStateChange'];
  private subscriptions: Array<{ remove(): void }> = [];
  private generation = 0;
  private earlyMessages: string[] = [];
  private queue: Array<{ data: string; bytes: number; created: number }> = [];
  private inFlight?: { data: string; bytes: number; created: number };
  private deadline?: ReturnType<typeof setTimeout>;
  constructor(private bridge: BleBridge | null | undefined, private deviceId: string) {}
  connect() {
    const gen = ++this.generation;
    const bridge = this.bridge;
    if (!bridge) { this.onConnectionStateChange?.('error', bluetoothUnavailableReason); return; }
    void (cleanup.get(bridge) ?? Promise.resolve()).then(async () => {
      if (gen !== this.generation) return;
      this.subscriptions = [
        bridge.addListener('onData', event => {
          if (gen !== this.generation) return;
          // Do not authenticate until native subscription setup has completed.
          if (this.connected) this.onMessage?.(event.data);
          else if (this.earlyMessages.length < 8) this.earlyMessages.push(event.data);
          else this.failed('Too many Bluetooth messages before connection was ready.', gen);
        }),
        bridge.addListener('onDisconnected', event => this.failed(event.message || 'Bluetooth connection lost.', gen)),
        // Scan errors share onError; connection failures also reject connect/send
        // or emit onDisconnected, so a discovery failure cannot drop input.
      ];
      await bridge.stopScan();
      if (gen !== this.generation) return;
      await bridge.connect(this.deviceId, BLE.service, BLE.write, BLE.notify);
      if (gen !== this.generation) return;
      this.connected = true;
      this.onConnectionStateChange?.('connected');
      for (const data of this.earlyMessages.splice(0)) { if (gen === this.generation) this.onMessage?.(data); }
    }).catch(error => this.failed(error instanceof Error ? error.message : 'Bluetooth connection failed. Check permissions and system pairing.', gen));
  }
  send(data: string) {
    if (!this.connected || !this.bridge) throw Error('Bluetooth is disconnected.');
    const bytes = unescape(encodeURIComponent(data)).length + 4;
    const last = this.queue.at(-1);
    // Only merge adjacent unsent deltas. Never move a delta across a button/key,
    // gesture, ping or release boundary; never rewrite an in-flight frame.
    if (last) {
      const next = JSON.parse(data), previous = JSON.parse(last.data);
      if ((next.type === 'mouse_move' || next.type === 'mouse_scroll') && next.type === previous.type &&
          Math.abs(next.dx + previous.dx) <= PROTOCOL.maxDelta && Math.abs(next.dy + previous.dy) <= PROTOCOL.maxDelta) {
        const merged = JSON.stringify({ ...next, dx: next.dx + previous.dx, dy: next.dy + previous.dy });
        const mergedBytes = unescape(encodeURIComponent(merged)).length + 4;
        this.bufferedAmount += mergedBytes - last.bytes;
        last.data = merged; last.bytes = mergedBytes;
        return;
      }
    }
    if (this.bufferedAmount + bytes > 32_768) throw Error('Bluetooth input queue is full.');
    this.bufferedAmount += bytes;
    this.queue.push({ data, bytes, created: Date.now() });
    this.pump();
  }
  private pump() {
    if (this.inFlight || !this.connected || !this.bridge) return;
    const frame = this.queue.shift(); if (!frame) return;
    const gen = this.generation;
    const remaining = 2_000 - (Date.now() - frame.created);
    if (remaining <= 0) { this.failed('Bluetooth input expired. Reconnecting to discard stale input.', gen); return; }
    this.inFlight = frame;
    this.deadline = setTimeout(() => this.failed('Bluetooth input became stale. Reconnecting…', gen), remaining);
    void this.bridge.send(frame.data).then(() => {
      if (gen !== this.generation) return;
      clearTimeout(this.deadline); this.deadline = undefined;
      this.bufferedAmount -= frame.bytes; this.inFlight = undefined; this.pump();
    }).catch(error => this.failed(error instanceof Error ? error.message : 'Bluetooth write failed.', gen));
  }
  private failed(message: string, gen: number) {
    if (gen !== this.generation) return;
    this.connected = false;
    this.onConnectionStateChange?.('error', message);
  }
  disconnect(): Promise<void> {
    ++this.generation;
    clearTimeout(this.deadline); this.deadline = undefined;
    this.queue = []; this.inFlight = undefined; this.earlyMessages = [];
    this.connected = false; this.bufferedAmount = 0;
    this.subscriptions.forEach(subscription => subscription.remove()); this.subscriptions = [];
    if (this.bridge) {
      const bridge = this.bridge;
      const pending = (cleanup.get(bridge) ?? Promise.resolve()).then(() => bridge.disconnect()).catch(() => {});
      cleanup.set(bridge, pending);
      return pending;
    }
    return Promise.resolve();
  }
}
