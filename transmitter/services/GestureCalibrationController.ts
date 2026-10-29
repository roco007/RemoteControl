import type { GestureBridge, GestureCalibrationStatus, GestureId } from '../modules/gesture-service';

export type CalibrationBusy = 'starting' | 'resuming' | 'capturing' | 'saving' | 'canceling' | null;
export interface GestureCalibrationView { visible: boolean; status: GestureCalibrationStatus | null; busy: CalibrationBusy; error: string }
type Bridge = Pick<GestureBridge, 'getCalibrationStatus' | 'startCalibration' | 'resumeCalibration' | 'captureCalibrationGesture' | 'saveCalibration' | 'cancelCalibration'>;
const errorMessage = (error: unknown, fallback: string) => error instanceof Error ? error.message : fallback;

/** Owns only the wizard session. Native retains the saved profile and the action guard. */
export class GestureCalibrationController {
  snapshot: GestureCalibrationView = { visible: false, status: null, busy: null, error: '' };
  private operation = 0;
  private eventVersion = 0;
  private blocked = false;
  private appActive = true;
  private closedSessions = new Set<string>();

  constructor(private readonly bridge: Bridge | null, private readonly onChange: (view: GestureCalibrationView) => void,
    private readonly onBlocked: (blocked: boolean) => void) {}

  receive(next: GestureCalibrationStatus) {
    if (next.sessionId && this.closedSessions.has(next.sessionId)) return;
    const previous = this.snapshot.status;
    if (previous && next.sequence < previous.sequence) return;
    if (previous?.sessionId && previous.sessionId !== next.sessionId && next.active) this.closedSessions.add(previous.sessionId);
    if (!this.appActive && next.active) next = { ...next, phase: 'interrupted', canSave: false, message: 'Calibration paused. Your recorded takes are kept. Continue when you return.' };
    this.eventVersion += 1;
    this.snapshot = { ...this.snapshot, status: next, visible: this.snapshot.visible || next.active };
    this.emit();
  }

  setAppActive(active: boolean) {
    this.appActive = active;
    if (!active && this.snapshot.status?.active) {
      this.receive({ ...this.snapshot.status, phase: 'interrupted', canSave: false, message: 'Calibration paused when you left the app. Continue without losing your recorded takes.' });
    }
  }

  async refresh() {
    if (!this.bridge) return;
    const operation = this.operation;
    const eventVersion = this.eventVersion;
    try {
      const next = await this.bridge.getCalibrationStatus();
      if (operation === this.operation) this.acceptReply(next, eventVersion);
    } catch (error) {
      if (operation === this.operation) this.fail(errorMessage(error, 'Could not read calibration status. Try again.'));
    }
  }

  async open() {
    this.snapshot = { ...this.snapshot, visible: true, error: '' };
    this.emit(); // Synchronous: JS actions stop before the native bridge is called.
    await this.refresh();
  }

  async start(gesture?: GestureId) {
    if (!this.bridge || this.snapshot.busy || !this.appActive) return;
    const operation = this.begin('starting');
    const eventVersion = this.eventVersion;
    try {
      const next = await this.bridge.startCalibration(gesture ?? null);
      if (operation !== this.operation) return;
      this.acceptReply(next, eventVersion);
      if (!next.active || next.phase === 'error') this.fail(next.message || 'Could not start calibration. Your saved calibration is unchanged.');
    } catch (error) {
      if (operation === this.operation) this.fail(errorMessage(error, 'Could not start calibration. Try again or cancel.'));
    } finally { this.finish(operation); }
  }

  async resume() {
    const current = this.snapshot.status;
    if (!this.bridge || this.snapshot.busy || !this.appActive || !current?.active || current.phase !== 'interrupted') return;
    const operation = this.begin('resuming');
    const eventVersion = this.eventVersion;
    try {
      const next = await this.bridge.resumeCalibration(current.sessionId);
      if (operation !== this.operation) return;
      this.acceptReply(next, eventVersion);
      if (!next.active || (next.phase !== 'ready' && next.phase !== 'review')) {
        this.fail(next.message || 'Could not continue calibration. Your recorded takes are kept.');
      }
    } catch (error) {
      if (operation === this.operation) this.fail(errorMessage(error, 'Could not continue calibration. Try again or cancel.'));
    } finally { this.finish(operation); }
  }

  async capture() {
    const current = this.snapshot.status;
    if (!this.bridge || this.snapshot.busy || !this.appActive || !current?.active || current.phase !== 'ready' || !current.sensorAvailable) return;
    const operation = this.begin('capturing');
    const eventVersion = this.eventVersion;
    try {
      const next = await this.bridge.captureCalibrationGesture(current.sessionId);
      if (operation === this.operation) this.acceptReply(next, eventVersion);
    } catch (error) {
      if (operation === this.operation) this.fail(errorMessage(error, 'Could not record sensor data. Try again.'));
    } finally { this.finish(operation); }
  }

  async save() {
    const current = this.snapshot.status;
    if (!this.bridge || this.snapshot.busy || !this.appActive || !current?.active || !current.canSave || current.phase !== 'review') return;
    const operation = this.begin('saving');
    const eventVersion = this.eventVersion;
    try {
      const next = await this.bridge.saveCalibration(current.sessionId);
      if (operation !== this.operation) return;
      this.acceptReply(next, eventVersion);
      if (next.active || next.phase !== 'idle' || next.calibratedAt === null || next.profileRevision <= current.profileRevision) {
        this.fail(next.message || 'Calibration was not saved. Your previous calibration is still available.');
        return;
      }
      this.close(current.sessionId);
    } catch (error) {
      if (operation === this.operation) this.fail(errorMessage(error, 'Calibration could not be saved. Try again or cancel.'));
    } finally { this.finish(operation); }
  }

  async cancel() {
    if (this.snapshot.busy === 'starting' || this.snapshot.busy === 'saving' || this.snapshot.busy === 'canceling') return;
    if (!this.bridge) { this.close(); return; }
    const operation = this.begin('canceling');
    try {
      // A failed start/save call may still have reached native. Verify the guard before closing.
      let next = await this.bridge.getCalibrationStatus();
      const sessionId = next.sessionId;
      if (next.active) next = await this.bridge.cancelCalibration(sessionId);
      if (operation !== this.operation) return;
      this.receive(next);
      if (next.active) { this.fail(next.message || 'Calibration is still paused. Try Cancel again.'); return; }
      this.close(sessionId);
    } catch (error) {
      if (operation === this.operation) this.fail(errorMessage(error, 'Could not end calibration. Try Cancel again; actions remain paused.'));
    } finally { this.finish(operation); }
  }

  private begin(busy: Exclude<CalibrationBusy, null>) {
    const operation = ++this.operation;
    this.snapshot = { ...this.snapshot, visible: true, busy, error: '' };
    this.emit();
    return operation;
  }
  private acceptReply(next: GestureCalibrationStatus, eventVersion: number) {
    if (eventVersion === this.eventVersion || next.sequence > (this.snapshot.status?.sequence ?? -1)) this.receive(next);
  }
  private finish(operation: number) {
    if (operation !== this.operation) return;
    this.snapshot = { ...this.snapshot, busy: null }; this.emit();
  }
  private fail(error: string) { this.snapshot = { ...this.snapshot, error }; this.emit(); }
  private close(sessionId?: string) {
    if (sessionId) this.closedSessions.add(sessionId);
    this.snapshot = { ...this.snapshot, visible: false, busy: null, error: '' }; this.emit();
  }
  private emit() {
    const blocked = this.snapshot.visible || this.snapshot.status?.active === true;
    if (blocked !== this.blocked) { this.blocked = blocked; this.onBlocked(blocked); }
    this.onChange(this.snapshot);
  }
}
