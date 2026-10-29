import type { SystemAction } from '../../shared/protocol';
import { isOpenUrl } from '../../shared/openUrl';
import type { GestureActionOutcome, GestureBridge, GestureEvent, GestureId, GestureStatus } from '../modules/gesture-service';
import type { SystemActionParameters } from '../networking/RemoteClient';
import { actionStepName, type GestureActionStep } from './gestureSettings';
import type { ConnectionSnapshot, SystemActionCompletion } from '../networking/types';
import { SystemActionDispatchError } from '../networking/types';
type Client = { getSnapshot(): ConnectionSnapshot; performSystemAction(action: SystemAction, id: string, parameters?: SystemActionParameters): Promise<SystemActionCompletion>; trackSystemAction(action: SystemAction, id: string, serverId?: string, deviceId?: string): Promise<SystemActionCompletion>; resumeSystemActions(id: string, nativeResetConfirmed?: boolean): boolean };
interface Operation { id: string; action: SystemAction; gesture: GestureId | null; native: boolean; dispatched: boolean; watching: boolean; finishing: boolean; confirmationMessage?: string; terminal?: { outcome: GestureActionOutcome; message?: string } }
export interface GestureActionState { pending: boolean; operationId: string | null; activeGesture?: GestureId | null; state: 'idle' | 'running' | 'unknown'; message: string; resuming: boolean; completedOperations: number }
export function gestureTransportActive(active: boolean, native?: Partial<GestureStatus> | null) {
  if (native?.batchPending) return native.batchOwner === 'foreground';
  if (native?.actionPending) return native.actionOwner === 'foreground';
  return active;
}
export function canRunFallbackGesture(steps: GestureActionStep[], connection: ConnectionSnapshot, phoneUrlsAvailable: boolean) {
  if (!steps.length) return false;
  return (connection.status === 'connected' && connection.capabilities?.includes('system_actions') === true && connection.capabilities.includes('action_completion')) ||
    (phoneUrlsAvailable && steps.some(step => step.type === 'open_url' && step.target === 'mobile'));
}
/** Owns the synchronous JS gate; React state is only its presentation. */
export class GestureActionController {
  private native?: GestureStatus;
  private operation?: Operation;
  private batch?: { id: string; gesture: GestureId | null; steps: GestureActionStep[]; index: number; failures: string[] };
  private nativeBatchGesture: GestureId | null = null;
  private closed = new Set<string>();
  private forwarded = '';
  private forwardedAt = -Infinity;
  private revision = -1;
  private state: GestureActionState = { pending: false, operationId: null, activeGesture: null, state: 'idle', message: '', resuming: false, completedOperations: 0 };
  constructor(private client: Client, private bridge: Pick<GestureBridge, 'completeGestureAction' | 'resumeGestureActions'> | null, private changed: () => void, private beforeDispatch: () => void = () => {}, private openPhoneUrl?: (url: string) => Promise<unknown>) {}
  getSnapshot = () => this.state;
  acceptRevision(status: Pick<GestureStatus, 'actionRevision'>) {
    if ((status.actionRevision ?? 0) < this.revision) return false;
    this.revision = status.actionRevision ?? 0; return true;
  }
  private update(patch: Partial<GestureActionState>) { this.state = { ...this.state, ...patch }; this.changed(); }
  private nativeGesture(status: GestureStatus | undefined): GestureId | null {
    if (!status || (!status.actionPending && !status.batchPending) || status.actionState === 'unknown') return null;
    if (this.operation?.confirmationMessage && status.actionOperationId === this.operation.id) return null;
    // An explicit null is authoritative; only older builds use the admitted event fallback.
    if (status.activeGesture !== undefined) return status.activeGesture;
    if (this.operation?.native && status.actionOperationId === this.operation.id) return this.operation.gesture;
    return status.batchPending ? this.nativeBatchGesture : null;
  }
  private setNative(status: GestureStatus) {
    this.native = status;
    if (!status.batchPending) this.nativeBatchGesture = null;
    else if (status.activeGesture !== undefined) this.nativeBatchGesture = status.activeGesture;
  }
  receiveNative(status: GestureStatus, recovery = false) {
    if (!this.acceptRevision(status) || (status.actionOperationId && this.closed.has(status.actionOperationId))) return false;
    this.setNative(status);
    if (this.operation?.terminal && (!status.actionPending || status.actionOperationId !== this.operation.id)) this.close(this.operation, this.operation.terminal.message);
    if (status.actionPending && status.actionOperationId) {
      const confirmationMessage = this.operation?.id === status.actionOperationId ? this.operation.confirmationMessage : undefined;
      this.update({ pending: true, operationId: status.actionOperationId, activeGesture: this.nativeGesture(status), state: status.actionState === 'unknown' ? 'unknown' : 'running', message: confirmationMessage ?? (status.actionState === 'unknown' ? status.message || 'Completion is unknown. Check your Mac before resuming gestures.' : 'Action in progress…') });
      if (recovery && status.actionOwner === 'foreground' && status.actionName) {
        if (this.operation?.terminal) { void this.finish(this.operation); return true; }
        if (!this.operation) {
          const op = this.makeOperation(status.actionOperationId, status.actionName, true, false, this.nativeGesture(status));
          this.watch(op, this.client.trackSystemAction(op.action, op.id, status.actionServerId ?? undefined, status.actionDeviceId ?? undefined));
          this.connectionChanged(this.client.getSnapshot());
        } else void this.client.trackSystemAction(this.operation.action, this.operation.id, status.actionServerId ?? undefined, status.actionDeviceId ?? undefined).catch(() => {});
      }
    } else if (!this.operation) this.update({ pending: !!status.batchPending, operationId: null, activeGesture: this.nativeGesture(status), state: status.batchPending ? 'running' : 'idle', message: status.batchSummary || (status.batchPending ? 'Action list in progress…' : '') });
    return true;
  }
  dispatchNative(event: GestureEvent, allowed: boolean) {
    const status = this.native;
    if (!event.operationId || this.closed.has(event.operationId) || !status?.actionPending || status.actionOperationId !== event.operationId || status.actionOwner !== 'foreground' || status.actionName !== event.action) return false;
    if (this.operation && (this.operation.id !== event.operationId || this.operation.dispatched || this.operation.terminal)) return false;
    const op = this.operation ?? this.makeOperation(event.operationId, event.action, true, false, this.nativeGesture(status));
    // A reconciliation query may already have found it running on the Mac.
    if (op.watching && this.client.getSnapshot().systemAction?.state === 'running') { op.dispatched = true; return false; }
    op.dispatched = true;
    if (!allowed || (status.actionServerId && status.actionServerId !== this.client.getSnapshot().serverId)) { op.terminal = { outcome: 'not_sent', message: 'Gesture was not sent while controls or the Mac connection were changing.' }; void this.finish(op); return false; }
    op.gesture = status.activeGesture === undefined ? event.gesture : status.activeGesture;
    if (status.batchPending) this.nativeBatchGesture = op.gesture;
    this.update({ activeGesture: this.nativeGesture(status) });
    this.beforeDispatch();
    const parameters = event.action === 'open_app' ? { appId: event.appId } : event.action === 'run_command' ? { command: event.command } : event.action === 'open_url' ? { url: event.url } : undefined;
    const promise = parameters ? this.client.performSystemAction(op.action, op.id, parameters) : this.client.performSystemAction(op.action, op.id);
    if (!op.watching) this.watch(op, promise);
    else void promise.catch(error => this.failed(op, error));
    return true;
  }
  dispatchFallback(action: SystemAction, id: string) {
    if (this.state.pending || this.operation || this.closed.has(id)) return false;
    const op = this.makeOperation(id, action, false, true);
    this.beforeDispatch();
    this.watch(op, this.client.performSystemAction(action, id));
    return true;
  }
  dispatchFallbackSequence(steps: GestureActionStep[], id: string, gesture?: GestureId) {
    if (!steps.length || this.state.pending || this.operation || this.batch || this.closed.has(id)) return false;
    this.closed.add(id);
    this.batch = { id, gesture: gesture ?? null, steps: steps.map(step => ({ ...step })), index: 0, failures: [] };
    this.runNextStep();
    return true;
  }
  private runNextStep() {
    const batch = this.batch;
    if (!batch) return;
    const step = batch.steps[batch.index];
    if (!step) {
      this.batch = undefined;
      const completed = batch.steps.length - batch.failures.length;
      this.update({ pending: false, operationId: null, activeGesture: null, state: 'idle', completedOperations: this.state.completedOperations + 1,
        message: `${completed} of ${batch.steps.length} actions completed.${batch.failures.length ? ` ${batch.failures.join(' · ')}` : ''}` });
      return;
    }
    // iOS does not expose a catalog/launcher; Android sequences are native-owned.
    if (step.type === 'open_app' && step.target === 'mobile') {
      batch.failures.push(`${batch.index + 1}. Phone app launch requires Android.`); ++batch.index; this.runNextStep(); return;
    }
    const action: SystemAction = step.type === 'system' ? step.action : step.type;
    const parameters = step.type === 'open_app' ? { appId: step.appId } : step.type === 'run_command' ? { command: step.command } : step.type === 'open_url' ? { url: step.url } : undefined;
    const op = this.makeOperation(`${batch.id}-${batch.index + 1}`, action, false, true, batch.gesture);
    this.update({ message: `${batch.index + 1} of ${batch.steps.length}: ${actionStepName(step)}` });
    this.beforeDispatch();
    if (step.type === 'open_url' && step.target === 'mobile') {
      const handoff = Promise.resolve().then(() => {
        if (!this.openPhoneUrl || !isOpenUrl(step.url)) throw Error('Phone URL opening is unavailable.');
        return this.openPhoneUrl(step.url);
      }).then(
        (): SystemActionCompletion => ({ id: op.id, action: 'open_url', ok: true, message: 'URL handed to the phone.' }),
        (): SystemActionCompletion => ({ id: op.id, action: 'open_url', ok: false, message: 'Could not open the URL on this phone.' }),
      );
      this.watch(op, handoff);
      return;
    }
    this.watch(op, parameters ? this.client.performSystemAction(action, op.id, parameters) : this.client.performSystemAction(action, op.id));
  }
  private makeOperation(id: string, action: SystemAction, native: boolean, dispatched: boolean, gesture: GestureId | null = null) {
    const op: Operation = { id, action, gesture, native, dispatched, watching: false, finishing: false };
    this.operation = op; this.forwarded = '';
    const unknown = native && this.native?.actionOperationId === id && this.native.actionState === 'unknown';
    this.update({ pending: true, operationId: id, activeGesture: unknown ? null : gesture, state: unknown ? 'unknown' : 'running', message: unknown ? this.state.message : 'Action in progress…' });
    return op;
  }
  private watch(op: Operation, promise: Promise<SystemActionCompletion>) {
    op.watching = true;
    void promise.then(result => {
      if (this.operation !== op || result.id !== op.id || result.action !== op.action) return;
      op.terminal = { outcome: result.ok ? 'success' : 'failed', message: result.message };
      void this.finish(op);
    }, error => this.failed(op, error));
  }
  private failed(op: Operation, error: unknown) {
    if (this.operation !== op || op.terminal) return;
    const message = error instanceof Error ? error.message : 'Could not confirm action completion.';
    if (error instanceof SystemActionDispatchError && error.delivery === 'not_sent') { op.terminal = { outcome: 'not_sent', message }; void this.finish(op); }
    else { this.update({ state: 'unknown', activeGesture: null, message }); this.forward(op, 'unknown', message); }
  }
  connectionChanged(snapshot: ConnectionSnapshot) {
    const op = this.operation, pending = snapshot.systemAction;
    if (!op || op.terminal || !pending || pending.id !== op.id || pending.action !== op.action) return;
    this.update({ state: pending.state, activeGesture: pending.state === 'unknown' ? null : op.native ? this.nativeGesture(this.native) : op.gesture, message: pending.message });
    this.forward(op, pending.state, pending.message, pending.confirmedAt);
  }
  private forward(op: Operation, outcome: 'running' | 'unknown', message: string, confirmedAt?: number) {
    if (!op.native || !this.bridge) return;
    if (this.forwarded === `${op.id}/${outcome}` && (outcome !== 'running' || confirmedAt === undefined || confirmedAt - this.forwardedAt < 15_000)) return;
    this.forwarded = `${op.id}/${outcome}`;
    this.forwardedAt = confirmedAt ?? Date.now();
    void this.bridge.completeGestureAction(op.id, outcome, message).catch(() => { if (this.operation === op) { this.forwarded = ''; this.update({ message: 'Could not update gesture status. Recognition remains paused.' }); } });
  }
  private async finish(op: Operation) {
    if (this.operation !== op || !op.terminal || op.finishing) return;
    op.finishing = true;
    try {
      if (op.native && this.bridge) {
        const result = await this.bridge.completeGestureAction(op.id, op.terminal.outcome, op.terminal.message ?? null);
        if (this.operation !== op) return;
        if (result.actionPending && result.actionOperationId === op.id) {
          op.confirmationMessage = 'Waiting for the gesture service to confirm completion.';
          this.update({ activeGesture: null, message: op.confirmationMessage }); return;
        }
        if (!this.acceptRevision(result)) return;
        this.setNative(result);
      }
      this.close(op, op.terminal.message);
    } catch {
      if (this.operation === op) {
        op.confirmationMessage = 'Could not confirm gesture completion. Reopen the app to retry; recognition remains paused.';
        this.update({ activeGesture: null, message: op.confirmationMessage });
      }
    }
    finally { op.finishing = false; }
  }
  private close(op: Operation, message = '') {
    if (this.operation !== op) return;
    this.closed.add(op.id); this.operation = undefined;
    // A read-only adopted token rejected before send must also leave the client gate.
    if (op.terminal?.outcome === 'not_sent') this.client.resumeSystemActions(op.id, op.native);
    if (this.batch && !op.native) {
      if (op.terminal?.outcome !== 'success') this.batch.failures.push(`${this.batch.index + 1}. ${message || 'Action failed.'}`);
      ++this.batch.index; this.runNextStep(); return;
    }
    this.update({ pending: !!this.native?.batchPending, operationId: null, activeGesture: this.nativeGesture(this.native), state: this.native?.batchPending ? 'running' : 'idle', message: this.native?.batchSummary || message, resuming: false, completedOperations: this.state.completedOperations + 1 });
  }
  async resume() {
    const id = this.state.operationId;
    if (!id || this.state.state !== 'unknown' || this.state.resuming) return;
    this.update({ resuming: true });
    try {
      if (this.bridge && this.native?.actionPending) {
        const status = await this.bridge.resumeGestureActions(id);
        if (this.state.operationId !== id) return;
        if (status.actionPending) { this.receiveNative(status); return; }
        if (!this.acceptRevision(status)) return;
        this.setNative(status);
      }
      // Clear our operation before the abandoned client promise rejects.
      const op = this.operation;
      if (!this.bridge && !this.client.resumeSystemActions(id)) return;
      this.batch = undefined;
      if (op) this.close(op); else { this.closed.add(id); this.update({ pending: false, operationId: null, activeGesture: null, state: 'idle', message: '' }); }
      if (this.bridge) this.client.resumeSystemActions(id, true);
    } catch { this.update({ message: 'Could not resume gestures. Try again; recognition remains paused.' }); }
    finally { this.update({ resuming: false }); }
  }
}
