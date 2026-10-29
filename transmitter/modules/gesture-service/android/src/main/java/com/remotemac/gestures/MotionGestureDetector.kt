package com.remotemac.gestures

import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

/** Pure sensor state machine. Samples are raw acceleration in g, using the same
 * monotonic millisecond clock as [tick]. The caller ticks while samples are quiet
 * and calls [reset] whenever listening, session ownership, or mappings change.
 * Directional gestures include single acceleration flicks and portrait
 * gravity-based tilt-and-return movements. A flick's braking lobe belongs to
 * that same flick; it never completes a tilt-and-return command. */
class MotionGestureDetector @JvmOverloads constructor(
  private val mode: String,
  private val onProgress: (Int, String) -> Unit,
  private val onGesture: (String, Int) -> Unit,
  private val profile: MotionCalibrationProfile? = null,
  recordings: Map<String, List<List<CalibrationFrame>>> = emptyMap(),
) {
  private val learnedRuntime=profile?.takeIf{p->p.learnedModels.keys.any{(LearnedMotionFeatures.kind(it)=="count")== (mode=="count")}}
    ?.let{LearnedMotionRuntime(mode,it,onProgress,onGesture,recordings)}
  /** Adaptive recognition requires fresh measured rest after an action instead
   * of stacking a blind sensor pause before that rest can be observed. */
  val postActionPauseMs: Long get() = learnedRuntime?.postActionPauseMs ?: 1000
  private val countProfile = profile?.takeIf { it.calibratedGestures.any { gesture -> gesture in setOf("single", "double", "triple") } }
  private fun directionProfile(direction: String) = profile?.takeIf { direction in it.calibratedGestures }
  private val tilt = TiltReturnDetector(profile)
  private fun directionThreshold(direction: String): Double = directionProfile(direction)?.let { if (direction == "left") it.leftThresholdG else it.rightThresholdG } ?: 1.4
  private val sequencePause: Long get() = if (mode == "count") countProfile?.countSequencePauseMs ?: 1100L else directionProfile(firstDirection)?.sequencePauseMs ?: 1100L
  private val shakeThreshold = countProfile?.shakeThresholdG ?: 2.0
  private val shakeRawThreshold = if (countProfile == null) 2.3 else 1.0 + shakeThreshold * 0.65
  private val shakeMagnitudeFloor = if (countProfile == null) 1.6 else 1.0 + shakeThreshold * 0.30
  private val shakeCalmMagnitude = if (countProfile == null) 1.4 else 1.0 + shakeThreshold * 0.20
  private data class V(val x: Double, val y: Double, val z: Double) {
    fun length() = sqrt(x * x + y * y + z * z)
    operator fun minus(other: V) = V(x - other.x, y - other.y, z - other.z)
    fun opposite(other: V): Boolean {
      val product = length() * other.length()
      return product > 0 && (x * other.x + y * other.y + z * other.z) / product < -0.35
    }
  }

  private var count = 0
  private var gravity: V? = null
  private var quietSince: Long? = null
  private var rested = false
  private var outward: V? = null
  private var returned: V? = null
  private var inExcursion = false
  private var excursionDirection: V? = null
  private var excursionRole = "ignored"
  private var excursionStartedAt: Long? = null
  private var lastStrongSample: Long? = null
  private var lastSample: Long? = null
  private var lastTick: Long? = null
  private var sequenceDeadline: Long? = null
  private var cooldownUntil: Long? = null
  private var firstDirection = ""
  private var firstFlickAt: Long? = null
  private var firstFlickBraked = false
  private var nextFlickArmedUntil: Long? = null
  private data class Frame(val time: Long, val value: V)
  private val postureWindow = ArrayDeque<Frame>()
  private var directionalCandidateAt: Long? = null
  private var onsetDirection = ""
  private var onsetAt = 0L
  private var onsetImpulse = 0.0
  private var onsetConfirmed = false
  private var previousOnsetSample: Long? = null
  private var previousOnsetMotion: V? = null

  fun addSample(x: Double, y: Double, z: Double, timestampMs: Long) {
    learnedRuntime?.let{it.addSample(CalibrationFrame(x,y,0.0,timestampMs));return}
    if (!x.isFinite() || !y.isFinite() || timestampMs < 0 ||
      lastSample?.let { timestampMs < it } == true) return
    val sample = V(x, y, 0.0)
    val magnitude = sample.length()
    if (!magnitude.isFinite()) return
    tick(timestampMs)
    lastSample = timestampMs
    if (cooldownUntil?.let { timestampMs < it } == true) return
    if (mode == "directional") {
      val wasActive = tilt.active
      // A gentle calibrated threshold can notice the roll's outward acceleration
      // first. It remains provisional until a brake; a stable full-angle tilt
      // may then replace it. A completed flick and brake keep their ownership.
      val result = tilt.addSample(x, y, 0.0, timestampMs, count == 0 || (count == 1 && !firstFlickBraked), requireTiltAngle = count == 1)
      if (wasActive || tilt.active || result.gesture != null || result.cancelled) {
        if (!wasActive && tilt.active) { clearMotion(resetTilt = false); onProgress(1, tilt.pendingGesture) }
        if (result.gesture != null) { count = 2; finish(result.gesture, timestampMs) }
        else if (result.cancelled) { clearMotion(); cooldownUntil = timestampMs + 600; onProgress(0, "") }
        return
      }
    }
    if (mode == "directional") updateDirectionalPosture(sample, timestampMs)
    else if (count == 0 && magnitude in 0.85..1.15) gravity = sample
    val motion = gravity?.let { sample - it } ?: sample
    if (mode == "directional") directional(sample, motion, timestampMs)
    else countShakes(sample, motion, timestampMs)
  }

  fun tick(timestampMs: Long) {
    learnedRuntime?.let{it.tick(timestampMs);return}
    if (timestampMs < 0 || lastTick?.let { timestampMs < it } == true) return
    lastTick = timestampMs
    if (cooldownUntil?.let { timestampMs >= it } == true) cooldownUntil = null
    if (mode == "directional" && tilt.active) {
      if (tilt.tick(timestampMs)) { clearMotion(); cooldownUntil = timestampMs + 600; onProgress(0, "") }
      return
    }
    if (mode == "directional" && (firstFlickAt ?: directionalCandidateAt)?.let { timestampMs - it >= 3000 } == true) {
      val hadProgress = count > 0
      clearMotion()
      cooldownUntil = timestampMs + 1000
      if (hadProgress) onProgress(0, "")
      return
    }
    if (sequenceDeadline?.let { timestampMs >= it } == true && count > 0) {
      // Anchor cooldown to actual dispatch time, never an old sample deadline.
      finish(if (mode == "directional") firstDirection else countName(), timestampMs)
    }
  }

  private fun countShakes(sample: V, motion: V, now: Long) {
    val magnitude = sample.length()
    val calm = magnitude < shakeCalmMagnitude && (gravity == null || motion.length() < shakeThreshold * 0.4)
    if (calm) {
      inExcursion = false
      if (quietSince == null) quietSince = now
      return
    }
    rested = rested || quietSince?.let { now - it >= 200 } == true
    quietSince = null
    if (count > 0) sequenceDeadline = now + sequencePause
    val returning = count > 0 && outward?.let { motion.opposite(it) } == true
    val strong = magnitude >= shakeRawThreshold || (gravity != null &&
      ((motion.length() >= shakeThreshold && magnitude >= shakeMagnitudeFloor) || (returning && motion.length() >= shakeThreshold * 0.5)))
    if (!strong) return
    val strongGap = lastStrongSample?.let { now - it } ?: Long.MAX_VALUE
    lastStrongSample = now
    val reversed = excursionDirection?.let { motion.opposite(it) } == true
    val fresh = !inExcursion || (reversed && excursionStartedAt?.let { now - it >= 60 } == true)
    if (!fresh) {
      excursionDirection = motion
      if (excursionRole == "outward") outward = motion
      if (excursionRole == "return") returned = motion
      return
    }
    inExcursion = true
    excursionDirection = motion
    excursionStartedAt = now
    excursionRole = "ignored"
    val separateJerk = rested && strongGap >= 280
    rested = false
    if (count == 0) startShake(motion, now)
    else if (returned == null && outward?.let { motion.opposite(it) } == true) {
      returned = motion
      excursionRole = "return"
    } else if (returned?.let { motion.opposite(it) } == true || separateJerk) startShake(motion, now)
  }

  private fun startShake(motion: V, now: Long) {
    outward = motion
    returned = null
    excursionRole = "outward"
    count += 1
    onProgress(count, countName())
    if (count == 3) finish("triple", now) else sequenceDeadline = now + sequencePause
  }

  private fun directional(sample: V, motion: V, now: Long) {
    if (count == 0) recordOnset(motion, now)
    val currentDirection = firstDirection.ifEmpty { if (motion.x < 0) "left" else "right" }
    val directionalCalm = if (directionProfile(currentDirection) == null) 0.65 else (directionThreshold(currentDirection) * 0.46).coerceIn(0.28, 0.65)
    val brakeThreshold = if (directionProfile(currentDirection) == null) 0.7 else (directionThreshold(currentDirection) * 0.5).coerceIn(0.30, 0.9)
    val calm = sample.length() < 1.4 && (gravity == null || motion.length() < directionalCalm)
    if (calm) {
      if (quietSince == null) quietSince = now
      return
    }
    val settledGap = quietSince?.let { now - it >= 160 } == true
    quietSince = null
    // A deliberate flick often ramps through weak acceleration before its peak.
    // Keep the settled-gap evidence briefly instead of requiring a single jump.
    if (settledGap && count > 0 && firstFlickBraked && firstFlickAt?.let { now - it >= 280 } == true) {
      nextFlickArmedUntil = now + 240
    }
    // Weaker movement/braking delays the single action until the phone settles.
    if (count > 0) sequenceDeadline = now + sequencePause
    val opposingBrake = (firstDirection == "right" && motion.x <= -brakeThreshold) ||
      (firstDirection == "left" && motion.x >= brakeThreshold)
    if (count > 0 && !firstFlickBraked && opposingBrake &&
      abs(motion.x) >= max(abs(motion.y), abs(motion.z)) * 1.2) {
      // Even delayed deceleration belongs to the first flick. Require its brake
      // and then a calm gap before a second deliberate direction can be armed.
      firstFlickBraked = true
      nextFlickArmedUntil = null
      return
    }
    val peakDirection = if (motion.x < 0) "left" else "right"
    val threshold = directionThreshold(peakDirection)
    val magnitudeFloor = if (directionProfile(peakDirection) == null) 1.8 else (sqrt(1 + threshold * threshold) * 0.95).coerceAtLeast(1.12)
    val horizontal = abs(motion.x) >= threshold && sample.length() >= magnitudeFloor &&
      abs(motion.x) >= max(abs(motion.y), abs(motion.z)) * 1.2
    if (!horizontal) return
    val direction = if (motion.x > 0) "right" else "left"
    if (count == 0) {
      if (onsetConfirmed && direction != onsetDirection) {
        // A sustained weak start followed by a stronger opposite braking peak
        // is ambiguous. Do not turn that brake into the opposite Mac action.
        clearMotion()
        cooldownUntil = now + 1000
        return
      }
      count = 1
      firstDirection = direction
      firstFlickAt = now
      sequenceDeadline = now + sequencePause
      onProgress(1, direction)
      return
    }
    // Recoil and braking are ignored until a real calm gap separates movements.
    if (nextFlickArmedUntil?.let { now <= it } != true) return
    // There is no two-flick command. A second deliberate flick makes this
    // sequence ambiguous; tilt-and-return commands use gravity above.
    clearMotion()
    cooldownUntil = now + 1000
    onProgress(0, "")
  }

  private fun countName() = when (count) { 1 -> "single"; 2 -> "double"; 3 -> "triple"; else -> "" }

  private fun updateDirectionalPosture(sample: V, now: Long) {
    if (gravity == null && sample.length() in 0.85..1.15) gravity = sample
    // Near 1 g is not proof of rest: gentle sideways acceleration can still have
    // that magnitude. Freeze at its onset, before the strong peak is accepted.
    if (count == 0 && directionalCandidateAt == null && gravity?.let { (sample - it).length() >= 0.2 } == true) directionalCandidateAt = now
    postureWindow.addLast(Frame(now, sample))
    while (postureWindow.size > 2 && postureWindow.elementAt(1).time <= now - 120) postureWindow.removeFirst()
    if (postureWindow.size < 2 || now - postureWindow.first().time < 100) return
    val mean = V(postureWindow.sumOf { it.value.x } / postureWindow.size,
      postureWindow.sumOf { it.value.y } / postureWindow.size,
      postureWindow.sumOf { it.value.z } / postureWindow.size)
    val postureTolerance = if (count > 0 && directionProfile(firstDirection) != null) 0.24 else 0.14
    if (mean.length() !in 0.85..1.15 || postureWindow.any { (it.value - mean).length() > postureTolerance }) return
    if (count == 0 && (directionalCandidateAt == null || gravity?.let { abs(mean.length() - it.length()) <= 0.04 } == true)) {
      // A stable rotation preserves gravity's magnitude. Relearn that idle pose
      // without waiting for a candidate timeout and its action cooldown.
      gravity = mean
      directionalCandidateAt = null
      clearOnset()
    }
    else if (count > 0 && firstFlickBraked) {
      // A flick can leave the phone tilted. Its stable new posture is rest even
      // when gravity differs greatly from the posture at the first peak.
      gravity = mean
      quietSince = quietSince ?: postureWindow.first().time
    }
  }

  private fun recordOnset(motion: V, now: Long) {
    val dt = previousOnsetSample?.let { (now - it).coerceIn(0, 80) } ?: 0
    val previous = previousOnsetMotion
    if (previous != null && abs(previous.x) >= 0.35 &&
      abs(previous.x) >= max(abs(previous.y), abs(previous.z)) * 1.2 &&
      (if (previous.x > 0) "right" else "left") == onsetDirection) {
      // Credit the interval occupied by the prior sample before inspecting a
      // newly arrived opposite peak; that peak may be the braking boundary.
      onsetImpulse += abs(previous.x) * dt / 1000.0
      if (now - onsetAt >= 100 && onsetImpulse >= 0.05) onsetConfirmed = true
    }
    previousOnsetSample = now
    previousOnsetMotion = motion
    if (abs(motion.x) < 0.35 || abs(motion.x) < max(abs(motion.y), abs(motion.z)) * 1.2) return
    val direction = if (motion.x > 0) "right" else "left"
    if (onsetDirection.isEmpty() || (!onsetConfirmed && direction != onsetDirection)) {
      onsetDirection = direction
      // At 25 Hz, onset lies between the last quiet and first meaningful sample.
      // Include that bounded interval only for conservatively rejecting a
      // conflicting brake; this evidence can never trigger an action itself.
      onsetAt = now - dt
      onsetImpulse = abs(motion.x) * dt / 1000.0
    }
  }

  private fun clearOnset() {
    onsetDirection = ""
    onsetAt = 0
    onsetImpulse = 0.0
    onsetConfirmed = false
    previousOnsetSample = null
    previousOnsetMotion = null
  }

  private fun finish(gesture: String, now: Long) {
    val completedCount = count
    if (completedCount == 0) return
    clearMotion()
    cooldownUntil = now + 1000
    onProgress(0, "")
    onGesture(gesture, completedCount)
  }

  private fun clearMotion(resetTilt: Boolean = true) {
    if (resetTilt) tilt.reset()
    count = 0
    gravity = null
    quietSince = null
    rested = false
    outward = null
    returned = null
    inExcursion = false
    excursionDirection = null
    excursionRole = "ignored"
    excursionStartedAt = null
    lastStrongSample = null
    sequenceDeadline = null
    firstDirection = ""
    firstFlickAt = null
    firstFlickBraked = false
    nextFlickArmedUntil = null
    postureWindow.clear()
    directionalCandidateAt = null
    clearOnset()
  }

  fun reset() {
    learnedRuntime?.reset()
    val hadProgress = count > 0
    clearMotion()
    cooldownUntil = null
    lastSample = null
    lastTick = null
    if (hadProgress) onProgress(0, "")
  }
}
