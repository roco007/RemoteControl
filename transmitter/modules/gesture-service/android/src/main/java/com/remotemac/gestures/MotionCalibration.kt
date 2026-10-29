package com.remotemac.gestures

import org.json.JSONObject
import org.json.JSONArray
import kotlin.math.abs
import kotlin.math.max
import kotlin.math.sqrt

data class CalibrationFrame(val x: Double, val y: Double, val z: Double, val timestampMs: Long)
data class CalibrationTrial(val gesture: String, val frames: List<CalibrationFrame>)
data class CalibrationFit(val profile: MotionCalibrationProfile?, val message: String)

/** Recognition tuning and bounded templates; original captures are archived separately. */
data class MotionCalibrationProfile(
  val version: Int = 1,
  val calibratedAt: Long = 0,
  val leftThresholdG: Double = 1.4,
  val rightThresholdG: Double = 1.4,
  val shakeThresholdG: Double = 2.0,
  val sequencePauseMs: Long = 1100,
  val compoundSettleMs: Long = 160,
  val compoundWindowMs: Long = 240,
  val minFlickSpacingMs: Long = 280,
  val countSequencePauseMs: Long = sequencePauseMs,
  val calibratedGestures: Set<String> = MotionCalibration.ALL_GESTURES.toSet(),
  val leftTiltDegrees: Double = 25.0,
  val rightTiltDegrees: Double = 25.0,
  val leftReturnDegrees: Double = 10.0,
  val rightReturnDegrees: Double = 10.0,
  val leftTiltHoldMs: Long = 120,
  val rightTiltHoldMs: Long = 120,
  val leftReturnHoldMs: Long = 160,
  val rightReturnHoldMs: Long = 160,
  val leftTiltTimeoutMs: Long = 4500,
  val rightTiltTimeoutMs: Long = 4500,
  val learnedModels: Map<String, LearnedMotionModel> = emptyMap(),
) {
  init {
    require(version == 1 && calibratedAt >= 0)
    require(leftThresholdG in 0.65..2.8 && rightThresholdG in 0.65..2.8 && shakeThresholdG in 0.85..3.8)
    require(sequencePauseMs in 800..1600 && compoundSettleMs in 160..420 && compoundWindowMs in 240..500 && minFlickSpacingMs in 280..700)
    require(countSequencePauseMs in 800..1600 && calibratedGestures.all { it in MotionCalibration.ALL_GESTURES })
    require(leftTiltDegrees in 16.0..45.0 && rightTiltDegrees in 16.0..45.0)
    require(leftReturnDegrees in 6.0..14.0 && rightReturnDegrees in 6.0..14.0)
    require(leftTiltHoldMs in 80..300 && rightTiltHoldMs in 80..300 && leftReturnHoldMs in 120..400 && rightReturnHoldMs in 120..400)
    require(leftTiltTimeoutMs in 2500..6000 && rightTiltTimeoutMs in 2500..6000)
  }
  fun toJson(): JSONObject = JSONObject().put("version", version).put("calibratedAt", calibratedAt)
    .put("leftThresholdG", leftThresholdG).put("rightThresholdG", rightThresholdG).put("shakeThresholdG", shakeThresholdG)
    .put("sequencePauseMs", sequencePauseMs).put("compoundSettleMs", compoundSettleMs)
    .put("compoundWindowMs", compoundWindowMs).put("minFlickSpacingMs", minFlickSpacingMs)
    .put("countSequencePauseMs", countSequencePauseMs).put("calibratedGestures", JSONArray(calibratedGestures.sorted()))
    .put("leftTiltDegrees", leftTiltDegrees).put("rightTiltDegrees", rightTiltDegrees)
    .put("leftReturnDegrees", leftReturnDegrees).put("rightReturnDegrees", rightReturnDegrees)
    .put("leftTiltHoldMs", leftTiltHoldMs).put("rightTiltHoldMs", rightTiltHoldMs)
    .put("leftReturnHoldMs", leftReturnHoldMs).put("rightReturnHoldMs", rightReturnHoldMs)
    .put("leftTiltTimeoutMs", leftTiltTimeoutMs).put("rightTiltTimeoutMs", rightTiltTimeoutMs)
    .put("learnedModels", LearnedMotionCodec.toJson(learnedModels))
  companion object {
    fun parse(json: JSONObject): MotionCalibrationProfile? = try {
      fun integer(key: String): Long {
        val number = json.get(key) as? Number ?: error("Invalid number")
        val value = number.toDouble()
        require(value.isFinite() && value >= 0 && value <= 9007199254740991.0 && value == number.toLong().toDouble())
        return number.toLong()
      }
      require(integer("version") == 1L)
      val legacy = !json.has("leftTiltDegrees")
      val learnedModels = if (!json.has("learnedModels")) emptyMap() else
        LearnedMotionCodec.parse(json.getJSONObject("learnedModels")) ?: error("Invalid learned models")
      val coverage = if (!json.has("calibratedGestures")) MotionCalibration.ALL_GESTURES.filterNot { it.endsWith("_straight") }.toSet() else {
        val values = json.getJSONArray("calibratedGestures")
        require(values.length() <= 7)
        (0 until values.length()).map { values.getString(it) }.filterNot { it == "left_right" || it == "right_left" }.toSet()
      }
      MotionCalibrationProfile(1, integer("calibratedAt"), json.getDouble("leftThresholdG"), json.getDouble("rightThresholdG"),
        json.getDouble("shakeThresholdG"), integer("sequencePauseMs"), if (legacy) 160 else integer("compoundSettleMs"), if (legacy) 240 else integer("compoundWindowMs"), if (legacy) 280 else integer("minFlickSpacingMs"),
        if (json.has("countSequencePauseMs")) integer("countSequencePauseMs") else integer("sequencePauseMs"), coverage,
        if (legacy) 25.0 else json.getDouble("leftTiltDegrees"), if (legacy) 25.0 else json.getDouble("rightTiltDegrees"),
        if (legacy) 10.0 else json.getDouble("leftReturnDegrees"), if (legacy) 10.0 else json.getDouble("rightReturnDegrees"),
        if (legacy) 120 else integer("leftTiltHoldMs"), if (legacy) 120 else integer("rightTiltHoldMs"),
        if (legacy) 160 else integer("leftReturnHoldMs"), if (legacy) 160 else integer("rightReturnHoldMs"),
        if (legacy) 4500 else integer("leftTiltTimeoutMs"), if (legacy) 4500 else integer("rightTiltTimeoutMs"), learnedModels)
    } catch (_: Exception) { null }
  }
}

/** Small deterministic search, followed by exact replay through the production detector. */
object MotionCalibration {
  val ALL_GESTURES = listOf("left", "right", "left_straight", "right_straight", "single", "double", "triple")
  private val countGestures = listOf("single", "double", "triple")
  private val gestures = ALL_GESTURES
  private data class V(val x: Double, val y: Double, val z: Double) {
    fun length() = sqrt(x * x + y * y + z * z)
    operator fun minus(v: V) = V(x - v.x, y - v.y, z - v.z)
    fun axis(index: Int) = when (index) { 0 -> x; 1 -> y; else -> z }
  }
  private data class Lobe(val sign: Int, val start: Long, val end: Long, val peak: Double, val rawPeak: Double)
  private data class Measured(val trial: CalibrationTrial, val left: List<Double>, val right: List<Double>, val shakes: List<Double>,
    val longestGap: Long,
    val tiltAngle: Double? = null, val returnError: Double = 0.0, val tiltDurationMs: Long = 0)

  fun fit(trials: List<CalibrationTrial>, requireComplete: Boolean = true,
    selectedGestures: List<String> = ALL_GESTURES, existingProfile: MotionCalibrationProfile? = null): CalibrationFit {
    fun failure(message: String) = CalibrationFit(null, message)
    if (selectedGestures.isEmpty() || selectedGestures.distinct().size != selectedGestures.size || selectedGestures.any { it !in gestures } ||
      trials.isEmpty() || trials.size > selectedGestures.size || trials.any { it.gesture !in selectedGestures }) return failure("Record each selected gesture once.")
    val counts = trials.groupingBy { it.gesture }.eachCount()
    if (counts.values.any { it > 1 } || (requireComplete && selectedGestures.any { counts[it] != 1 })) return failure("Record each selected gesture once before saving.")
    val measured = mutableListOf<Measured>()
    for (trial in trials) {
      val result = measure(trial.copy(frames = trial.frames.map(MotionXY::frame)))
      if (result.first == null) return failure("${trial.gesture.replace('_', ' ')}: ${result.second}")
      measured.add(result.first!!)
    }
    val prior = existingProfile ?: MotionCalibrationProfile(calibratedGestures = emptySet())
    val base = prior.copy(calibratedAt = System.currentTimeMillis(), calibratedGestures = prior.calibratedGestures + trials.map { it.gesture })
    val countTrials = measured.filter { it.trial.gesture in countGestures }
    val directionTrials = measured.filter { it.trial.gesture in listOf("left", "right") }
    val tiltTrials = measured.filter { it.trial.gesture.endsWith("_straight") }
    fun strengths(values: List<Double>, fallback: Double, low: Double, high: Double) = if (values.isEmpty()) listOf(fallback)
      else ((if (existingProfile == null) emptyList() else listOf(fallback)) + listOf(0.72, 0.60, 0.85).map { (values.min() * it).coerceIn(low, high) }).distinct()
    fun pauses(values: List<Measured>) = listOf(((values.maxOfOrNull { it.longestGap } ?: 0) + 240).coerceIn(800, 1600), 1100L, 1400L, 1600L).distinct()
    // At most 20 count candidates, independent of left/right fitting.
    var countProfile: MotionCalibrationProfile? = if (countTrials.isEmpty()) base else null
    countSearch@ for (pause in (listOf(base.countSequencePauseMs) + pauses(countTrials)).distinct()) for (strength in strengths(countTrials.flatMap { it.shakes }, base.shakeThresholdG, 0.85, 3.8)) {
      if (countProfile != null) break@countSearch
      val candidate = base.copy(shakeThresholdG = strength, countSequencePauseMs = pause)
      if (countTrials.all { matches(it.trial, candidate) }) countProfile = candidate
    }
    if (countProfile == null) return failure("Shake recordings do not agree. Repeat each count with complete out-and-back movements and a still finish.")
    var directionProfile: MotionCalibrationProfile? = if (directionTrials.isEmpty()) base else null
    directionSearch@ for (left in strengths(directionTrials.flatMap { it.left }, base.leftThresholdG, 0.65, 2.8))
        for (right in strengths(directionTrials.flatMap { it.right }, base.rightThresholdG, 0.65, 2.8)) {
          if (directionProfile != null) break@directionSearch
          val candidate = base.copy(leftThresholdG = left, rightThresholdG = right)
          if (directionTrials.all { matches(it.trial, candidate) }) directionProfile = candidate
        }
    if (directionProfile == null) return failure("The flick did not match clearly. Make the selected direction once, then relax briefly.")
    var profile = directionProfile.copy(shakeThresholdG = countProfile.shakeThresholdG, countSequencePauseMs = countProfile.countSequencePauseMs)
    for (tilt in tiltTrials) {
      val isLeft = tilt.trial.gesture == "left_straight"
      val angle = (tilt.tiltAngle!! * 0.82).coerceIn(16.0, 45.0)
      val tolerance = (tilt.returnError + 4.0).coerceIn(10.0, 14.0)
      val timeout = (tilt.tiltDurationMs + 1000).coerceIn(2500, 6000)
      fun tuned(hold: Long, returnHold: Long) = if (isLeft) profile.copy(leftTiltDegrees = angle, leftReturnDegrees = tolerance,
        leftTiltHoldMs = hold, leftReturnHoldMs = returnHold, leftTiltTimeoutMs = timeout)
        else profile.copy(rightTiltDegrees = angle, rightReturnDegrees = tolerance,
          rightTiltHoldMs = hold, rightReturnHoldMs = returnHold, rightTiltTimeoutMs = timeout)
      val candidates = (if (tilt.trial.gesture in prior.calibratedGestures) listOf(profile) else emptyList()) + listOf(tuned(120, 160), tuned(80, 120))
      profile = candidates.firstOrNull { matches(tilt.trial, it) }
        ?: return failure("Tilt a little to the selected side, then return to your starting angle and relax briefly.")
    }
    if (!measured.all { matches(it.trial, profile) }) return failure("The recordings need incompatible timing. Retry the last movement at your usual pace.")
    return CalibrationFit(profile, if (requireComplete) "Your selected movements match. Calibration is ready to save." else "Movement matched. Continue when ready.")
  }

  private fun matches(trial: CalibrationTrial, profile: MotionCalibrationProfile): Boolean {
    val actions = mutableListOf<String>()
    val detector = MotionGestureDetector(if (trial.gesture in countGestures) "count" else "directional", { _, _ -> }, { gesture, _ -> actions.add(gesture) }, profile)
    trial.frames.forEach { detector.addSample(it.x, it.y, it.z, it.timestampMs) }
    // No invented tail or forced timeout: the actual captured settle must complete it.
    return actions == listOf(trial.gesture)
  }

  private fun measure(trial: CalibrationTrial): Pair<Measured?, String> {
    fun fail(message: String): Pair<Measured?, String> = null to message
    val input = trial.frames
    if (input.size !in 80..240 || input.any { !it.x.isFinite() || !it.y.isFinite() || !it.z.isFinite() || it.timestampMs < 0 || max(abs(it.x), max(abs(it.y), abs(it.z))) > 12 }) return fail("The sensor recording is incomplete. Try again.")
    if (input.zipWithNext().any { (a, b) -> b.timestampMs - a.timestampMs !in 15..120 } || input.last().timestampMs - input.first().timestampMs !in 3800..8500) return fail("The sensor timing was interrupted. Try again.")
    fun vector(f: CalibrationFrame) = V(f.x, f.y, f.z)
    fun stable(values: List<V>): V? {
      if (values.size < 6) return null
      fun median(values: List<Double>) = values.sorted()[values.size / 2]
      val pose = V(median(values.map { it.x }), median(values.map { it.y }), median(values.map { it.z }))
      if (pose.length() !in 0.85..1.15) return null
      val residual = values.map { (it - pose).length() }.sorted()
      val trimmed = residual.take((residual.size * 0.8).toInt().coerceAtLeast(1))
      return if (sqrt(trimmed.sumOf { it * it } / trimmed.size) <= 0.20 && residual[(residual.size * 0.9).toInt().coerceAtMost(residual.lastIndex)] <= 0.32 && residual.last() <= 0.55) pose else null
    }
    // Tap/grip movement is preparation, not a gesture. Find actual quiet data,
    // then give precisely this same slice to measurement AND production replay.
    var baselineStart = -1
    var baselineEnd = -1
    var resting: V? = null
    for (start in input.indices) {
      val end = (start until input.size).firstOrNull { input[it].timestampMs - input[start].timestampMs >= 280 } ?: break
      if (input[end].timestampMs - input.first().timestampMs > 1200) break
      val pose = stable(input.subList(start, end + 1).map(::vector)) ?: continue
      baselineStart = start; baselineEnd = end - start; resting = pose; break
    }
    val gravity = resting ?: return fail("Let your hand settle briefly before the movement, then try again.")
    val frames = input.drop(baselineStart)
    val prepared = trial.copy(frames = frames)
    val baseline = frames.take(baselineEnd + 1).map(::vector)
    val baselineFinishedAt = frames[baselineEnd].timestampMs
    var settled = false
    for (start in frames.indices) {
      if (frames[start].timestampMs < frames.last().timestampMs - 1000) continue
      val end = (start until frames.size).firstOrNull { frames[it].timestampMs - frames[start].timestampMs >= 240 } ?: break
      val pose = stable(frames.subList(start, end + 1).map(::vector)) ?: continue
      if (frames.drop(end + 1).all { vector(it).length() in 0.75..1.25 && (vector(it) - pose).length() <= 0.45 }) { settled = true; break }
    }
    if (!settled) return fail("Finish the movement and let your hand relax briefly before recording ends.")
    if (trial.gesture.endsWith("_straight")) return measureTilt(prepared, gravity, baselineFinishedAt)
    val directional = trial.gesture !in countGestures
    var pose = gravity
    val motion = frames.mapIndexed { index, frame ->
      if (directional && index >= 7) {
        val average = stable(frames.subList(index - 7, index + 1).map(::vector))
        if (average != null && abs(average.length() - gravity.length()) <= 0.04) pose = average
      }
      vector(frame) - pose
    }
    val axis = if (directional) 0 else (0..2).maxBy { a -> motion.sumOf { it.axis(a) * it.axis(a) } }
    val residual = baseline.map { (it - gravity).length() }.sorted()
    val noise = residual[(residual.size * 0.8).toInt().coerceAtMost(residual.lastIndex)]
    val floor = max(0.24, (noise * 1.6).coerceAtMost(0.32))
    val lobes = mutableListOf<Lobe>()
    var open: Lobe? = null
    for (i in frames.indices) {
      val value = motion[i]
      val strength = abs(value.axis(axis))
      val active = strength >= floor && (!directional || abs(value.x) >= max(abs(value.y), abs(value.z)) * 1.2)
      val sign = if (value.axis(axis) >= 0) 1 else -1
      if (!active || open?.sign?.let { it != sign } == true) { open?.let(lobes::add); open = null }
      if (active) open = open?.copy(end = frames[i].timestampMs, peak = max(open.peak, strength), rawPeak = max(open.rawPeak, vector(frames[i]).length()))
        ?: Lobe(sign, frames[i].timestampMs, frames[i].timestampMs, strength, vector(frames[i]).length())
    }
    open?.let(lobes::add)
    val meaningful = lobes.filter { it.peak >= 0.55 }
    if (meaningful.isEmpty()) return fail("No clear motion was recorded. Make the prompted gesture once.")
    if (meaningful.first().start <= baselineFinishedAt) return fail("Let your hand settle briefly before making the movement.")
    val longestGap = meaningful.zipWithNext().maxOfOrNull { (a, b) -> b.start - a.end } ?: 0
    val left = mutableListOf<Double>(); val right = mutableListOf<Double>(); val shakes = mutableListOf<Double>()
    if (directional) {
      val expected = if (trial.gesture.startsWith("left")) -1 else 1
      val first = meaningful.first()
      if (first.sign != expected) return fail("The first movement went the other direction. Follow the arrow and try again.")
      fun record(lobe: Lobe) { if (lobe.sign < 0) left.add(lobe.peak) else right.add(lobe.peak) }
      record(first)
      val firstIndex = lobes.indexOf(first)
      val brake = (firstIndex + 1 until lobes.size).firstOrNull { lobes[it].sign != first.sign }
      val candidates = (firstIndex + 1 until lobes.size).filter { index ->
        index != brake && lobes[index].peak >= 0.55 && lobes[index].rawPeak >= 1.12 && lobes[index].start - lobes[index - 1].end - 40 >= 160
      }
      fun hasReturn(index: Int) = (index + 1 until lobes.size).any {
        lobes[it].sign != lobes[index].sign && lobes[it].peak >= max(floor, lobes[index].peak * 0.25) && lobes[it].start - lobes[index].end < 1000
      }
      if (candidates.any(::hasReturn)) return fail("That contained another full flick. Make just the selected direction.")
    } else {
      val firstSign = meaningful.first().sign
      var cycles = 1; var returned = false
      shakes.add(meaningful.first().peak)
      meaningful.drop(1).forEachIndexed { i, lobe ->
        if (lobe.sign != firstSign) returned = true
        else if (returned || lobe.start - meaningful[i].end >= 240) { cycles++; returned = false; shakes.add(lobe.peak) }
      }
      if (cycles != countGestures.indexOf(trial.gesture) + 1) return fail("The recorded shake count did not match. Repeat the prompted count.")
    }
    return Measured(prepared, left, right, shakes, longestGap) to ""
  }

  private fun measureTilt(trial: CalibrationTrial, gravity: V, baselineFinishedAt: Long): Pair<Measured?, String> {
    fun fail(message: String): Pair<Measured?, String> = null to message
    fun roll(v: V) = Math.toDegrees(kotlin.math.atan2(v.x, v.y))
    if (gravity.y / gravity.length() < 0.65 || abs(roll(gravity)) > 35) return fail("Start with the phone upright in portrait, comfortably facing you.")
    val expected = if (trial.gesture == "left_straight") 1 else -1
    val stable = mutableListOf<Pair<Long, Double>>()
    val window = ArrayDeque<Pair<CalibrationFrame, V>>()
    for (frame in trial.frames) {
      val v = V(frame.x, frame.y, frame.z)
      if (v.length() !in 0.88..1.12 || abs(v.length() - gravity.length()) > 0.05 || v.y / v.length() < 0.45 || abs(v.z / v.length() - gravity.z / gravity.length()) > TiltReturnDetector.MAX_PITCH_CHANGE) { window.clear(); continue }
      window.addLast(frame to v)
      while (window.size > 1 && window.first().first.timestampMs < frame.timestampMs - 160) window.removeFirst()
      if (window.size < 4 || frame.timestampMs - window.first().first.timestampMs < 120) continue
      val average = V(window.sumOf { it.second.x } / window.size, window.sumOf { it.second.y } / window.size, window.sumOf { it.second.z } / window.size)
      if (window.any { (it.second - average).length() > 0.08 } || (window.first().second - window.last().second).length() > 0.045) continue
      stable.add(frame.timestampMs to (roll(average) - roll(gravity)))
    }
    val movement = stable.filter { it.first > baselineFinishedAt && abs(it.second) >= 12 }
    if (movement.isEmpty()) return fail("Tilt to the selected side, then return upright; a sideways flick is a different movement.")
    if (movement.any { it.second * expected <= -12 }) return fail("Tilt only to the selected side, then return to your starting angle.")
    val peak = movement.maxOf { it.second * expected }
    if (peak < 16) return fail("Tilt a little farther to the selected side, then return upright.")
    val tail = stable.filter { it.first >= trial.frames.last().timestampMs - 400 }
    if (tail.size < 4 || tail.any { abs(it.second) > 14 }) return fail("Return to your starting upright angle before recording ends.")
    var excursions = 0; var armed = true; var neutralSince: Long? = null
    for ((time, angle) in stable) {
      if (abs(angle) >= 16) {
        if (armed) { excursions++; armed = false }
        neutralSince = null
      } else if (abs(angle) <= 12) {
        if (neutralSince == null) neutralSince = time
        if (time - neutralSince >= 120) armed = true
      } else neutralSince = null
    }
    if (excursions != 1) return fail("Record one tilt and return only.")
    val peakAt = movement.maxBy { it.second * expected }.first
    val returnedAt = stable.firstOrNull { it.first > peakAt && abs(it.second) <= 14 }?.first
      ?: return fail("Return to your starting upright angle before recording ends.")
    // Include the outward ramp before the first stable tilted pose. Runtime
    // suppression starts there too; timing only the plateau truncates slow rolls.
    val startedAt = trial.frames.first { it.timestampMs > baselineFinishedAt &&
      abs(roll(V(it.x, it.y, it.z)) - roll(gravity)) >= 8 }.timestampMs
    return Measured(trial, emptyList(), emptyList(), emptyList(), 0,
      peak, tail.maxOf { abs(it.second) }, returnedAt - startedAt) to ""
  }
}
