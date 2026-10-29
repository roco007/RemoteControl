package com.remotemac.gestures

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.sqrt

/** A deliberate portrait roll and return, measured against the starting gravity
 * vector. Acceleration flicks and a change of pitch are not roll gestures. */
internal class TiltReturnDetector(private val profile: MotionCalibrationProfile?) {
  companion object {
    // A wrist roll naturally changes forward/backward lean as well. Keep this
    // bound shared with calibration while preserving gravity and roll checks.
    const val MAX_PITCH_CHANGE = 0.35
  }
  private data class Pose(val x: Double, val y: Double, val z: Double, val time: Long) {
    val length get() = sqrt(x * x + y * y + z * z)
    val roll get() = Math.toDegrees(atan2(x, y))
    fun distance(other: Pose) = sqrt((x-other.x)*(x-other.x) + (y-other.y)*(y-other.y) + (z-other.z)*(z-other.z))
  }
  data class Result(val gesture: String? = null, val cancelled: Boolean = false)
  private val window = ArrayDeque<Pose>()
  private val pitchRest = ArrayDeque<Pose>()
  private var baseline: Pose? = null
  private var startedAt: Long? = null
  private var invalidSince: Long? = null
  private var tiltedSince: Long? = null
  private var returnedSince: Long? = null
  private var reachedTilt = false
  var pendingGesture = ""; private set
  val active get() = startedAt != null
  private fun tuning() = profile?.takeIf { pendingGesture in it.calibratedGestures }
  private fun left() = pendingGesture == "left_straight"
  private fun angle() = tuning()?.let { if (left()) it.leftTiltDegrees else it.rightTiltDegrees } ?: 25.0
  private fun tolerance() = (tuning()?.let { if (left()) it.leftReturnDegrees else it.rightReturnDegrees } ?: 10.0).coerceAtLeast(10.0)
  private fun tiltHold() = tuning()?.let { if (left()) it.leftTiltHoldMs else it.rightTiltHoldMs } ?: 120L
  private fun returnHold() = tuning()?.let { if (left()) it.leftReturnHoldMs else it.rightReturnHoldMs } ?: 160L
  private fun timeout() = tuning()?.let { if (left()) it.leftTiltTimeoutMs else it.rightTiltTimeoutMs } ?: 4500L

  fun tick(now: Long): Boolean {
    if (startedAt?.let { now - it >= timeout() } != true) return false
    reset(); return true
  }

  fun addSample(x: Double, y: Double, z: Double, now: Long, allowStart: Boolean, requireTiltAngle: Boolean = false): Result {
    // The public entry point is also used directly; depth must never affect
    // roll validity, stability, ownership, cancellation or dispatch timing.
    val sample = Pose(x, y, 0.0, now)
    val base = baseline
    // A change in comfortable resting pitch is not a roll. Relearn it only
    // after a real 600 ms rest, with unchanged gravity magnitude; never follow
    // the incremental roll of a slow intentional tilt.
    if (base != null && !active && allowStart && sample.length in 0.88..1.12 &&
      abs(sample.length - base.length) <= 0.05 && sample.y / sample.length >= 0.65 && abs(sample.roll) <= 35 &&
      abs(sample.z / sample.length - base.z / base.length) > MAX_PITCH_CHANGE) {
      if (pitchRest.lastOrNull()?.let { now - it.time > 120 } == true) pitchRest.clear()
      pitchRest.addLast(sample)
      while (pitchRest.size > 2 && pitchRest.elementAt(1).time <= now - 600) pitchRest.removeFirst()
      val rest = Pose(pitchRest.sumOf { it.x } / pitchRest.size, pitchRest.sumOf { it.y } / pitchRest.size,
        pitchRest.sumOf { it.z } / pitchRest.size, now)
      if (now - pitchRest.first().time >= 600 && pitchRest.all { it.distance(rest) <= 0.06 } && pitchRest.first().distance(pitchRest.last()) <= 0.025) {
        baseline = rest; pitchRest.clear(); window.clear(); return Result()
      }
    } else pitchRest.clear()
    val valid = sample.length in 0.88..1.12 && sample.y / sample.length >= 0.45 &&
      (base == null || (abs(sample.length - base.length) <= 0.05 && abs(sample.z / sample.length - base.z / base.length) <= MAX_PITCH_CHANGE))
    if (!valid) {
      window.clear(); tiltedSince = null; returnedSince = null
      if (active) {
        if (invalidSince == null) invalidSince = now
        // A real wrist return includes acceleration and braking. Once a stable
        // tilt has qualified, wait briefly for gravity again; invalid samples
        // can never qualify either pose or trigger a command themselves.
        if (now - invalidSince!! >= if (reachedTilt) 600 else 240) { reset(); return Result(cancelled = true) }
      } else if (!allowStart) baseline = null
      return Result()
    }
    invalidSince = null
    if (window.lastOrNull()?.let { now - it.time > 120 } == true) window.clear()
    window.addLast(sample)
    while (window.size > 1 && window.first().time < now - 160) window.removeFirst()
    val mean = Pose(window.sumOf { it.x } / window.size, window.sumOf { it.y } / window.size, window.sumOf { it.z } / window.size, now)
    val stable = window.size >= 4 && now - window.first().time >= 120 &&
      window.all { it.distance(mean) <= 0.08 } && window.first().distance(window.last()) <= 0.045
    if (base == null) {
      if (allowStart && stable && mean.y / mean.length >= 0.65 && abs(mean.roll) <= 35) baseline = mean
      return Result()
    }
    val delta = sample.roll - base.roll
    if (!active) {
      if (!allowStart) { baseline = null; window.clear(); return Result() }
      pendingGesture = if (delta >= 0) "left_straight" else "right_straight"
      val startAngle = if (requireTiltAngle) angle() else minOf(12.0, angle() * 0.6)
      if (abs(delta) < startAngle) {
        pendingGesture = ""
        return Result()
      }
      // A transient wind-up or a flick's moving gravity estimate is not a
      // deliberate tilted pose. Claim ownership only after it actually settles.
      if (!stable || abs(mean.roll - base.roll) < startAngle) { pendingGesture = ""; return Result() }
      startedAt = now
    }
    val directed = delta * if (left()) 1 else -1
    if (directed < -tolerance()) { reset(); return Result(cancelled = true) }
    if (!reachedTilt) {
      if (stable && directed >= angle()) {
        if (tiltedSince == null) tiltedSince = window.first().time
        if (now - tiltedSince!! >= tiltHold()) reachedTilt = true
      } else tiltedSince = null
      // A small excursion which returns before reaching its target is noise.
      if (abs(delta) <= tolerance() && now - startedAt!! >= 400) { reset(); return Result(cancelled = true) }
      return Result()
    }
    if (stable && window.all { abs(it.roll - base.roll) <= tolerance() }) {
      if (returnedSince == null) returnedSince = window.first().time
      if (now - returnedSince!! >= returnHold()) {
        val gesture = pendingGesture; reset(); return Result(gesture)
      }
    } else returnedSince = null
    return Result()
  }

  fun reset() {
    window.clear(); pitchRest.clear(); baseline = null; startedAt = null; invalidSince = null
    tiltedSince = null; returnedSince = null; reachedTilt = false; pendingGesture = ""
  }
}
