type ShakeCount = 1 | 2 | 3;
type Acceleration = { x: number; y: number; z: number };
type PlanarAcceleration = Pick<Acceleration, 'x' | 'y'>;
type ExcursionRole = 'outward' | 'return' | 'ignored';
const RAW_TRIGGER_G = 2.3;
const MOTION_TRIGGER_G = 2;
const RETURN_TRIGGER_G = 1;
const REST_G = 1.4;
const PHASE_DEBOUNCE_MS = 60;
const RESTED_JERK_MS = 200;
const UNPAIRED_JERK_MS = 280;
const SEQUENCE_MS = 1100;
const COOLDOWN_MS = 1000;
const length = (v: PlanarAcceleration) => Math.hypot(v.x, v.y);
const opposite = (a: PlanarAcceleration, b: PlanarAcceleration) =>
  (a.x * b.x + a.y * b.y) / (length(a) * length(b)) < -0.35;

/** A strong outward excursion provisionally counts once; its opposing return
 * completes that same shake. The next outward excursion starts the next count.
 * Calm, separate one-way jerks are also accepted without requiring a return. */
export class ShakeDetector {
  private count = 0;
  private gravity?: PlanarAcceleration;
  private quietSince?: number;
  private rested = false;
  private outward?: PlanarAcceleration;
  private returned?: PlanarAcceleration;
  private inExcursion = false;
  private excursionDirection?: PlanarAcceleration;
  private excursionRole: ExcursionRole = 'ignored';
  private excursionStartedAt = -Infinity;
  private lastStrongSample = -Infinity;
  private lastSample = -Infinity;
  private sequenceTimer?: ReturnType<typeof setTimeout>;
  private cooldownTimer?: ReturnType<typeof setTimeout>;
  private coolingDown = false;
  private disposed = false;
  constructor(private onSequence: (count: ShakeCount) => void, private onProgress?: (count: number) => void) {}

  addSample(sample: Acceleration, timestampMs = Date.now()): void {
    if (this.disposed || !Number.isFinite(timestampMs) || timestampMs < this.lastSample ||
        !Number.isFinite(sample.x) || !Number.isFinite(sample.y)) return;
    // Upright phone: X is left/right and Y is up/down. Project once so depth
    // cannot change gravity, excursion direction, calm periods, or completion.
    const planar = { x: sample.x, y: sample.y };
    const magnitude = length(planar);
    if (!Number.isFinite(magnitude)) return;
    this.lastSample = timestampMs;
    if (this.coolingDown) return;
    // Freeze gravity during a sequence: an apparent 1 g valley may itself be motion.
    if (this.count === 0 && magnitude >= 0.85 && magnitude <= 1.15) this.gravity = planar;
    const motion = this.gravity ? {
      x: planar.x - this.gravity.x, y: planar.y - this.gravity.y,
    } : planar;
    const calm = magnitude < REST_G && (!this.gravity || length(motion) < 0.8);
    if (calm) {
      this.inExcursion = false;
      this.quietSince ??= timestampMs;
      return;
    }
    this.rested ||= this.quietSince !== undefined && timestampMs - this.quietSince >= RESTED_JERK_MS;
    this.quietSince = undefined;
    if (this.count > 0) this.waitForSequenceEnd();
    // Preserve the original raw trigger sensitivity. Once a strong outward peak
    // exists, its weaker opposing return may be partly canceled by gravity.
    // Orientation-only 1 g changes still cannot initiate a new sequence.
    const returning = this.count > 0 && this.outward && opposite(motion, this.outward);
    const strong = magnitude >= RAW_TRIGGER_G || (this.gravity &&
      ((length(motion) >= MOTION_TRIGGER_G && magnitude >= 1.6) || (returning && length(motion) >= RETURN_TRIGGER_G)));
    if (!strong) return;
    const strongGap = timestampMs - this.lastStrongSample;
    this.lastStrongSample = timestampMs;
    const reversed = this.excursionDirection && opposite(motion, this.excursionDirection);
    const fresh = !this.inExcursion || (reversed && timestampMs - this.excursionStartedAt >= PHASE_DEBOUNCE_MS);
    if (!fresh) {
      this.excursionDirection = motion;
      if (this.excursionRole === 'outward') this.outward = motion;
      if (this.excursionRole === 'return') this.returned = motion;
      return;
    }
    this.inExcursion = true;
    this.excursionDirection = motion;
    this.excursionStartedAt = timestampMs;
    this.excursionRole = 'ignored';
    const separateJerk = this.rested && strongGap >= UNPAIRED_JERK_MS;
    this.rested = false;
    if (this.count === 0) this.startShake(motion);
    else if (!this.returned && this.outward && opposite(motion, this.outward)) {
      this.returned = motion;
      this.excursionRole = 'return';
    } else if ((this.returned && opposite(motion, this.returned)) || separateJerk) this.startShake(motion);
  }

  private startShake(motion: PlanarAcceleration): void {
    this.outward = motion;
    this.returned = undefined;
    this.excursionRole = 'outward';
    this.count += 1;
    this.onProgress?.(this.count);
    if (this.count === 3) this.finishSequence();
    else if (this.count > 0) this.waitForSequenceEnd();
  }
  private waitForSequenceEnd(): void {
    clearTimeout(this.sequenceTimer);
    this.sequenceTimer = setTimeout(() => this.finishSequence(), SEQUENCE_MS);
  }
  private finishSequence(): void {
    clearTimeout(this.sequenceTimer);
    this.sequenceTimer = undefined;
    if (this.disposed || this.count === 0) return;
    const count = this.count as ShakeCount;
    this.count = 0;
    this.clearMotion();
    this.coolingDown = true;
    this.cooldownTimer = setTimeout(() => {
      this.cooldownTimer = undefined;
      this.coolingDown = false;
    }, COOLDOWN_MS);
    this.onProgress?.(0);
    this.onSequence(count);
  }
  private clearMotion(): void {
    this.gravity = this.outward = this.returned = this.excursionDirection = undefined;
    this.quietSince = undefined;
    this.rested = this.inExcursion = false;
    this.excursionRole = 'ignored';
    this.excursionStartedAt = this.lastStrongSample = -Infinity;
  }
  /** Cancel queued actions before backgrounding, disabling, or changing sessions. */
  reset(): void {
    clearTimeout(this.sequenceTimer);
    clearTimeout(this.cooldownTimer);
    this.sequenceTimer = this.cooldownTimer = undefined;
    const hadProgress = this.count > 0;
    this.count = 0;
    this.clearMotion();
    this.lastSample = -Infinity;
    this.coolingDown = false;
    if (hadProgress) this.onProgress?.(0);
  }
  dispose(): void { this.disposed = true; this.reset(); }
}
