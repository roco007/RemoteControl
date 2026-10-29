import type { GestureBridge, GestureConfiguration, GestureStatus } from '../modules/gesture-service';

export type NativeGestureControl = { enabled: boolean | null; background: boolean };
type Bridge = Pick<GestureBridge, 'getStatus' | 'setEnabled' | 'setBackgroundEnabled' | 'configure'>;
type Events = { onStatus: (status: GestureStatus) => void; onControl: (control: NativeGestureControl) => void; onReady: () => void };

/** Orders the persisted native switch independently from transient sensor/connection status. */
export class NativeGestureSync {
  private status: GestureStatus | null = null;
  private loaded = false;
  private generation = 0;
  private intent = 0;
  private pendingIntent: number | null = null;

  constructor(private readonly bridge: Bridge, private readonly events: Events) {}
  get ready() { return this.loaded && this.status !== null && this.pendingIntent === null; }
  get revision() { return this.status?.controlRevision ?? 0; }

  setLoaded(loaded: boolean) {
    this.loaded = loaded;
    this.reconcile();
  }

  receive(next: GestureStatus) {
    if (this.status && next.controlRevision < this.status.controlRevision) return;
    const changed = !this.status || next.controlRevision > this.status.controlRevision;
    this.status = next;
    this.events.onStatus(next);
    if (changed) {
      this.invalidate();
      this.reconcile();
      this.events.onReady();
    }
  }

  /** Invalidates credential/permission work before a new app setting or lifecycle takes effect. */
  invalidate() { this.generation += 1; }

  async refresh() {
    this.invalidate();
    this.receive(await this.bridge.getStatus());
    // A foreground read also retries configuration after a transient credential/bridge failure.
    this.events.onReady();
  }

  async setBackgroundEnabled(enabled: boolean) {
    return this.changeControl(() => this.bridge.setBackgroundEnabled(enabled));
  }

  async setEnabled(enabled: boolean) {
    return this.changeControl(() => this.bridge.setEnabled(enabled));
  }

  private async changeControl(change: () => Promise<GestureStatus>) {
    const intent = ++this.intent;
    this.pendingIntent = intent;
    this.invalidate();
    try {
      this.receive(await change());
    } catch (error) {
      // A rejected bridge call may still have reached native; read its persisted decision.
      await this.refresh().catch(() => {});
      throw error;
    } finally {
      if (this.pendingIntent === intent) {
        this.pendingIntent = null;
        this.reconcile();
        this.events.onReady();
      }
    }
  }

  async configure(build: () => Promise<GestureConfiguration | null>) {
    if (!this.ready) return;
    const generation = this.generation;
    const revision = this.revision;
    const config = await build();
    if (!config || !this.ready || generation !== this.generation) return;
    // Native performs the same revision check atomically, closing the final JS/native gap.
    this.receive(await this.bridge.configure(JSON.stringify({
      ...config, enabled: this.status?.controlEnabled ?? config.enabled, controlRevision: revision,
    } satisfies GestureConfiguration)));
  }

  private reconcile() {
    if (!this.loaded || this.pendingIntent !== null || !this.status) return;
    if (this.status.controlEnabled === null && this.status.controlRevision === 0) return;
    this.events.onControl({ enabled: this.status.controlEnabled, background: this.status.controlBackground });
  }
}
