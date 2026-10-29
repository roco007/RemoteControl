import type { ClientPayload } from '../../shared/protocol';
import { CircularControlGesture } from '../gestures/CircularControlGesture';

type Point = { x: number; y: number };
export type SoundLightMode = 'volume' | 'brightness';

export class SoundLightController {
  private circle = new CircularControlGesture();
  private stroke?: { session: string; control: SoundLightMode };
  constructor(private options: { send: (payload: ClientPayload) => boolean; enabled: () => boolean; session: () => string }) {}

  begin(point: Point, center: Point, deadZoneRadius: number, control: SoundLightMode): void {
    this.reset();
    if (!this.options.enabled() || !Number.isFinite(point.x + point.y + center.x + center.y + deadZoneRadius) ||
        Math.hypot(point.x - center.x, point.y - center.y) <= deadZoneRadius) return;
    this.stroke = { session: this.options.session(), control };
    this.circle.begin(point, center, deadZoneRadius);
  }

  move(point: Point, pointers = 1): number {
    if (!this.stroke) return 0;
    if (!this.options.enabled() || this.stroke.session !== this.options.session() || pointers !== 1) { this.reset(); return 0; }
    const steps = this.circle.move(point);
    if (!steps) return 0;
    // A discontinuity filter bounds each sample to a quarter turn (16 steps).
    // No pending packets or fractions survive a failed send or a new session.
    if (!this.options.send({ type: 'system_adjust', control: this.stroke.control, steps })) { this.reset(); return 0; }
    return steps;
  }

  reset(): void { this.stroke = undefined; this.circle.reset(); }
}
