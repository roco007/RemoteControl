type Point = { x: number; y: number };

const FULL_TURN = Math.PI * 2;
const RADIANS_PER_STEP = FULL_TURN / 64;
const MAX_SAMPLE_ARC = Math.PI / 2;
const ROUNDING_EPSILON = 1e-9;

/** Converts a finger path around a center into signed fine adjustment steps. */
export class CircularControlGesture {
  private center: Point | null = null;
  private deadZoneRadius = 0;
  private previousAngle: number | null = null;
  private pendingSteps = 0;

  begin(point: Point, center: Point, deadZoneRadius: number): void {
    this.reset();
    if (![point.x, point.y, center.x, center.y, deadZoneRadius].every(Number.isFinite)
      || deadZoneRadius < 0
      || !Number.isFinite(Math.hypot(point.x - center.x, point.y - center.y))) return;

    this.center = { ...center };
    this.deadZoneRadius = deadZoneRadius;
    this.previousAngle = this.angleAt(point);
  }

  /** Clockwise is positive in screen coordinates; one complete turn is 64 steps. */
  move(point: Point): number {
    if (!this.center) return 0;

    const angle = this.angleAt(point);
    if (angle === null) {
      this.previousAngle = null;
      this.pendingSteps = 0;
      return 0;
    }

    const previousAngle = this.previousAngle;
    this.previousAngle = angle;
    if (previousAngle === null) return 0;

    let arc = angle - previousAngle;
    if (arc > Math.PI) arc -= FULL_TURN;
    else if (arc < -Math.PI) arc += FULL_TURN;

    // Sparse or discontinuous samples do not establish a trustworthy direction.
    if (Math.abs(arc) > MAX_SAMPLE_ARC + ROUNDING_EPSILON) {
      this.pendingSteps = 0;
      return 0;
    }

    // Signed accumulation cancels small reversals instead of amplifying jitter.
    this.pendingSteps += arc / RADIANS_PER_STEP;
    const magnitude = Math.floor(Math.abs(this.pendingSteps) + ROUNDING_EPSILON);
    if (magnitude === 0) return 0;

    const steps = Math.sign(this.pendingSteps) * magnitude;
    this.pendingSteps -= steps;
    if (Math.abs(this.pendingSteps) < ROUNDING_EPSILON) this.pendingSteps = 0;
    return steps;
  }

  reset(): void {
    this.center = null;
    this.deadZoneRadius = 0;
    this.previousAngle = null;
    this.pendingSteps = 0;
  }

  private angleAt(point: Point): number | null {
    if (!this.center || !Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
    const x = point.x - this.center.x;
    const y = point.y - this.center.y;
    const radius = Math.hypot(x, y);
    if (!Number.isFinite(radius) || radius <= this.deadZoneRadius) return null;
    return Math.atan2(y, x);
  }
}
