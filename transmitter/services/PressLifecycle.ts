export interface PressActivation {
  /** Browser accessibility clicks have detail=0 and no pointer lifecycle. */
  semantic?: boolean;
  timestamp?: number;
}

/**
 * A physical hold owns down/up; an accessibility activation owns a complete tap.
 * An ended native cycle expires in a microtask, so a cancelled gesture never
 * consumes an unrelated later activation.
 */
export class PressLifecycle {
  private held = false;
  private endedCycle = false;
  private generation = 0;
  private clickReleaseTimestamp?: number;

  constructor(private callbacks: { onDown: () => void; onUp: () => void; enabled?: () => boolean }) {}
  private enabled() { return this.callbacks.enabled?.() !== false; }

  begin = (): void => {
    if (!this.enabled() || this.held) return;
    ++this.generation;
    this.endedCycle = false; this.clickReleaseTimestamp = undefined;
    this.held = true;
    this.callbacks.onDown();
  };

  end = (event: { expectClick?: boolean; timestamp?: number } = {}): void => {
    if (!this.held) return;
    this.held = false;
    this.callbacks.onUp();
    this.endedCycle = true;
    this.clickReleaseTimestamp = event.expectClick && Number.isFinite(event.timestamp) ? event.timestamp : undefined;
    const generation = ++this.generation;
    queueMicrotask(() => { if (generation === this.generation) this.endedCycle = false; });
  };

  activate = (event: PressActivation = {}): void => {
    if (!this.enabled()) { this.cancel(); return; }
    // Native Pressable can activate before a delayed pressOut callback.
    if (this.held) return;
    const release = this.clickReleaseTimestamp;
    const matchingPhysicalClick = release !== undefined && event.timestamp !== undefined &&
      event.timestamp >= release && event.timestamp - release < 1000;
    const alreadyDelivered = !event.semantic && (this.endedCycle || matchingPhysicalClick);
    ++this.generation;
    this.endedCycle = false; this.clickReleaseTimestamp = undefined;
    if (alreadyDelivered) return;
    this.callbacks.onDown();
    this.callbacks.onUp();
  };

  cancel = (): void => {
    ++this.generation;
    this.endedCycle = false; this.clickReleaseTimestamp = undefined;
    if (!this.held) return;
    this.held = false;
    this.callbacks.onUp();
  };
}
