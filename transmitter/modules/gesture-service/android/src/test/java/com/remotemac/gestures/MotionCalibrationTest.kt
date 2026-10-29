package com.remotemac.gestures

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class MotionCalibrationTest {
  private class Capture {
    val frames = mutableListOf<CalibrationFrame>()
    var now = 0L
    fun sample(x: Double = 0.0, y: Double = 1.0, z: Double = 0.0) {
      frames.add(CalibrationFrame(x, y, z, now)); now += 40
    }
    fun rest(ms: Long) { repeat((ms / 40).toInt()) { sample() } }
    fun lobe(x: Double, samples: Int) { repeat(samples) { sample(x) } }
    fun flick(sign: Double, strength: Double, width: Int) {
      lobe(sign * strength, width); sample(); lobe(-sign * strength * 0.85, width); sample()
    }
    fun finish(gesture: String, duration: Long = 4800): CalibrationTrial { while (now <= duration) sample(); return CalibrationTrial(gesture, frames) }
  }
  private fun trial(gesture: String, left: Double = 2.4, right: Double = 2.8, shake: Double = 3.0,
    width: Int = 2, pause: Long = 280): CalibrationTrial {
    if (gesture.endsWith("_straight")) return tiltTrial(gesture)
    val c = Capture(); c.rest(840)
    if (gesture in listOf("single", "double", "triple")) {
      val count = listOf("single", "double", "triple").indexOf(gesture) + 1
      repeat(count) { index -> c.lobe(shake, width); c.sample(); c.lobe(-shake, width); c.sample(); if (index < count - 1) c.rest(pause) }
    } else {
      val first = if (gesture.startsWith("left")) -1.0 else 1.0
      c.flick(first, if (first < 0) left else right, width)
      if (gesture.contains('_')) { c.rest(pause); c.flick(-first, if (first > 0) left else right, width) }
    }
    return c.finish(gesture)
  }
  private fun complete(left: Double = 2.4, right: Double = 2.8, shake: Double = 3.0, width: Int = 2, pause: Long = 280) =
    listOf("single", "double", "triple", "right", "left", "left_straight", "right_straight").map { gesture -> trial(gesture, left, right, shake, width, pause) }
  private fun tiltTrial(gesture: String, angle: Double = 32.0, moveMs: Int = 400, returnOffset: Double = 0.0): CalibrationTrial {
    val frames = mutableListOf<CalibrationFrame>(); var now = 0L
    val sign = if (gesture == "left_straight") 1 else -1
    fun pose(roll: Double, duration: Int) { repeat(duration / 40) {
      val radians = Math.toRadians(roll)
      frames.add(CalibrationFrame(kotlin.math.sin(radians), kotlin.math.cos(radians), 0.0, now)); now += 40
    } }
    pose(0.0, 1240)
    for (i in 1..moveMs/40) pose(sign * angle * i / (moveMs/40), 40)
    pose(sign * angle, 240)
    for (i in 1..moveMs/40) pose(sign * angle + (returnOffset - sign * angle) * i / (moveMs/40), 40)
    while (now <= 7720) pose(returnOffset, 40)
    return CalibrationTrial(gesture, frames)
  }
  private fun replay(trial: CalibrationTrial, profile: MotionCalibrationProfile?): List<String> {
    val actions = mutableListOf<String>()
    val mode = if (trial.gesture in listOf("single", "double", "triple")) "count" else "directional"
    val detector = MotionGestureDetector(mode, { _, _ -> }, { gesture, _ -> actions.add(gesture) }, profile)
    trial.frames.forEach { detector.addSample(it.x, it.y, it.z, it.timestampMs) }
    return actions
  }

  @Test fun fitsGentleAsymmetricMotionAndReplaysEveryGestureExactly() {
    val trials = complete(left = 0.95, right = 1.3, shake = 1.25)
    assertTrue(trials.any { replay(it, null) != listOf(it.gesture) })
    val fit = MotionCalibration.fit(trials)
    assertNotNull(fit.message, fit.profile)
    val profile = fit.profile!!
    assertTrue(profile.leftThresholdG < profile.rightThresholdG)
    assertTrue(profile.shakeThresholdG < 2.0)
    trials.forEach { assertEquals(it.gesture, listOf(it.gesture), replay(it, profile)) }
  }

  @Test fun fitsStrongFastAndSlowerTrialsWithoutChangingGestureIdentity() {
    for ((width, pause) in listOf(1 to 200L, 4 to 600L)) {
      val trials = complete(left = 3.4, right = 4.0, shake = 4.2, width = width, pause = pause)
      val fit = MotionCalibration.fit(trials)
      assertNotNull("width=$width pause=$pause ${fit.message}", fit.profile)
      trials.forEach { assertEquals(it.gesture, listOf(it.gesture), replay(it, fit.profile)) }
    }
  }

  @Test fun gentleShakeCalibrationWorksOnBothUprightPlaneAxes() {
    for (axis in 0..1) for (gesture in listOf("single", "double", "triple")) {
      val original = trial(gesture, shake = 1.25)
      val moved = original.copy(frames = original.frames.map { f -> when (axis) {
        1 -> f.copy(x = 0.0, y = 1.0 + f.x)
        else -> f
      } })
      val fit = MotionCalibration.fit(listOf(moved), false)
      assertNotNull("axis=$axis gesture=$gesture ${fit.message}", fit.profile)
      assertEquals(listOf(gesture), replay(moved, fit.profile))
    }
  }

  @Test fun fittedSensitivityPreservesRecoilAndConflictingWeakOnsetProtection() {
    val profile = MotionCalibration.fit(complete(left = 0.95, right = 1.3, shake = 1.25)).profile!!
    val recoil = Capture().apply { rest(840); flick(1.0, 1.3, 2); rest(80); lobe(-1.5, 2) }.finish("right")
    assertEquals(listOf("right"), replay(recoil, profile))
    val ambiguous = Capture().apply { rest(840); lobe(0.4, 4); lobe(-1.5, 2) }.finish("right")
    assertTrue(replay(ambiguous, profile).isEmpty())
  }

  @Test fun doesNotInventSettleFramesToAcceptACaptureCutOffBeforeDispatch() {
    val c = Capture().apply { rest(3400); flick(1.0, 2.8, 1) }.finish("right")
    val cutoff = c.copy(frames = c.frames.filter { it.timestampMs <= 4000 })
    assertNull(MotionCalibration.fit(listOf(cutoff), false).profile)
  }

  @Test fun oneRecordingOfEverySelectedPromptIsRequiredForTheFinalProfile() {
    val trials = complete()
    assertNull(MotionCalibration.fit(trials.dropLast(1)).profile)
    assertNull(MotionCalibration.fit(trials + trials.first()).profile)
    assertNotNull(MotionCalibration.fit(listOf(trials.first()), requireComplete = false).profile)
  }

  @Test fun acceptsTapJitterAndMildTremorUsingTheSameTrimmedReplay() {
    val trials = complete(left = 0.95, right = 1.3, shake = 1.25).map { t ->
      t.copy(frames = t.frames.mapIndexed { i, f -> when {
        i == 0 -> f.copy(x = 2.8)
        i == 1 -> f.copy(x = -2.8)
        i == 2 -> f.copy(x = 0.4)
        f.timestampMs >= 4200 -> f.copy(x = (if (t.gesture.endsWith("_straight")) 0.05 else 0.18) * if (i % 2 == 0) 1 else -1)
        else -> f
      } })
    }
    val fit = MotionCalibration.fit(trials)
    assertNotNull(fit.message, fit.profile)
    assertEquals(MotionCalibration.ALL_GESTURES.toSet(), fit.profile!!.calibratedGestures)
  }

  @Test fun acceptsWeakBrakingAndNaturalOneWayShakeBursts() {
    val single = Capture().apply { rest(1240); lobe(0.8, 2); sample(); lobe(-0.35, 2); sample() }.finish("right", 7720)
    assertNotNull(MotionCalibration.fit(listOf(single), selectedGestures = listOf("right")).profile)
    for (count in 1..3) {
      val name = listOf("single", "double", "triple")[count - 1]
      val c = Capture().apply { rest(1240); repeat(count) { lobe(1.3, 2); rest(360) } }.finish(name, 7720)
      val fit = MotionCalibration.fit(listOf(c), selectedGestures = listOf(name))
      assertNotNull("$name: ${fit.message}", fit.profile)
    }
  }

  @Test fun acceptsOneLeftFlickFollowedByDelayedRegripInsteadOfCallingItAnotherFlick() {
    val c = Capture().apply { rest(1240); flick(-1.0, 2.4, 2); rest(320) }
    // A distinct +X lobe follows the brake and a 320 ms pause. The old lobe-gap
    // rule called this another flick, although it is a new stable 1 g grip.
    while (c.now <= 7720) c.sample(0.8, 0.6, 0.0)
    val recorded = CalibrationTrial("left", c.frames)
    val fit = MotionCalibration.fit(listOf(recorded), selectedGestures = listOf("left"))
    assertNotNull(fit.message, fit.profile)
    assertEquals(listOf("left"), replay(recorded, fit.profile))
  }

  @Test fun calibratingOneGesturePreservesSavedUnrelatedParametersAndCoverage() {
    val saved = MotionCalibrationProfile(leftThresholdG = 2.4, rightThresholdG = 1.7, shakeThresholdG = 1.8,
      sequencePauseMs = 1400, countSequencePauseMs = 950, compoundSettleMs = 240, compoundWindowMs = 320,
      minFlickSpacingMs = 400, calibratedGestures = setOf("right", "double"))
    val left = MotionCalibration.fit(listOf(trial("left", left = 0.95)), selectedGestures = listOf("left"), existingProfile = saved)
    assertNotNull(left.message, left.profile)
    val profile = left.profile!!
    assertTrue(profile.leftThresholdG < saved.leftThresholdG)
    assertEquals(saved.copy(leftThresholdG = profile.leftThresholdG, calibratedAt = profile.calibratedAt,
      calibratedGestures = setOf("right", "double", "left")), profile)
    val single = MotionCalibration.fit(listOf(trial("single", shake = 1.25)), selectedGestures = listOf("single"), existingProfile = saved)
    assertNotNull(single.message, single.profile)
    val counted = single.profile!!
    assertEquals(saved.copy(shakeThresholdG = counted.shakeThresholdG, countSequencePauseMs = counted.countSequencePauseMs,
      calibratedAt = counted.calibratedAt, calibratedGestures = setOf("right", "double", "single")), counted)
  }

  @Test fun aNewLeftOnlyProfileLeavesUntunedRightAndCountRuntimeBehaviorUnchanged() {
    val fit = MotionCalibration.fit(listOf(trial("left", left = 0.95)), selectedGestures = listOf("left"))
    assertNotNull(fit.message, fit.profile)
    assertEquals(setOf("left"), fit.profile!!.calibratedGestures)
    // 1.45 g crosses the old X threshold, but not its 1.8 g raw magnitude
    // guard. Merely having some calibration must not relax right's guard.
    for (unrelated in listOf(trial("right", right = 1.45), trial("right", right = 2.8), trial("single", shake = 1.25), trial("double"))) {
      assertEquals(unrelated.gesture, replay(unrelated, null), replay(unrelated, fit.profile))
    }
    assertNull(MotionCalibration.fit(listOf(trial("right")), selectedGestures = listOf("left")).profile)
  }

  @Test fun legacyProfilesRetainTheirOriginalCoverageAndSharedCountPause() {
    val original = MotionCalibrationProfile(sequencePauseMs = 1400)
    val legacy = JSONObject(original.toJson().toString()).apply { remove("calibratedGestures"); remove("countSequencePauseMs") }
    val preserved = setOf("left", "right", "single", "double", "triple")
    assertEquals(original.copy(calibratedGestures = preserved), MotionCalibrationProfile.parse(legacy))
    assertEquals(preserved, MotionCalibrationProfile.parse(legacy)!!.calibratedGestures)
    assertEquals(1400L, MotionCalibrationProfile.parse(legacy)!!.countSequencePauseMs)
  }

  @Test fun rejectsWrongDirectionsAndCountsEvenWhenLaterMotionMatchesThePrompt() {
    for ((prompt, actual) in listOf("left" to "right", "right_straight" to "left_straight", "single" to "double", "double" to "triple")) {
      assertNull("$actual must not train $prompt", MotionCalibration.fit(listOf(trial(actual).copy(gesture = prompt)), false).profile)
    }
  }

  @Test fun fitsGentleAndSlowTiltReturnsWithoutChangingFlickOrOtherSideTuning() {
    val saved = MotionCalibrationProfile(leftThresholdG = 0.85, rightTiltDegrees = 35.0, calibratedGestures = setOf("left", "right_straight"))
    for (angle in listOf(18.0, 45.0)) for (moveMs in listOf(160, 1400)) {
      val recorded = tiltTrial("left_straight", angle, moveMs)
      val fit = MotionCalibration.fit(listOf(recorded), selectedGestures = listOf("left_straight"), existingProfile = saved)
      assertNotNull("angle=$angle duration=$moveMs ${fit.message}", fit.profile)
      val p = fit.profile!!
      assertEquals(listOf("left_straight"), replay(recorded, p))
      assertEquals(saved.copy(calibratedAt = p.calibratedAt, calibratedGestures = saved.calibratedGestures + "left_straight",
        leftTiltDegrees = p.leftTiltDegrees, leftReturnDegrees = p.leftReturnDegrees, leftTiltHoldMs = p.leftTiltHoldMs,
        leftReturnHoldMs = p.leftReturnHoldMs, leftTiltTimeoutMs = p.leftTiltTimeoutMs), p)
    }
  }

  @Test fun tiltCalibrationRejectsWrongSideMissingReturnWrongAxisAndTranslation() {
    val left = tiltTrial("left_straight")
    val noReturn = left.copy(frames = left.frames.map { if (it.timestampMs >= 1880) CalibrationFrame(0.53, 0.848, 0.0, it.timestampMs) else it })
    val wrongAxis = left.copy(frames = left.frames.map { it.copy(x = 0.0, z = it.x) })
    val translation = left.copy(frames = left.frames.map { it.copy(y = 1.0) })
    for (bad in listOf(left.copy(gesture = "right_straight"), noReturn, wrongAxis, translation, trial("left").copy(gesture = "left_straight"))) {
      assertNull(MotionCalibration.fit(listOf(bad), selectedGestures = listOf(bad.gesture)).profile)
    }
  }

  @Test fun tiltCalibrationCannotHideAWeakerSecondTiltInsideRuntimeCooldown() {
    val first = tiltTrial("left_straight", angle = 35.0)
    val second = tiltTrial("left_straight", angle = 18.0)
    val recorded = first.copy(frames = first.frames.map { f ->
      if (f.timestampMs in 2680..4000) second.frames.first { it.timestampMs == f.timestampMs - 1440 }.copy(timestampMs = f.timestampMs) else f
    })
    assertNull(MotionCalibration.fit(listOf(recorded), selectedGestures = listOf("left_straight")).profile)
  }

  @Test fun legacyCompoundCoverageIsRemovedWithoutPretendingTiltsWereCalibrated() {
    val json = MotionCalibrationProfile(leftThresholdG = 0.85, sequencePauseMs = 1400).toJson()
    for (key in json.keys().asSequence().toList()) if (key.contains("Tilt") || key.contains("Return")) json.remove(key)
    json.put("calibratedGestures", org.json.JSONArray(listOf("left", "right", "left_right", "right_left")))
    val migrated = MotionCalibrationProfile.parse(json)!!
    assertEquals(setOf("left", "right"), migrated.calibratedGestures)
    assertEquals(0.85, migrated.leftThresholdG, 0.0)
    assertEquals(1400L, migrated.sequencePauseMs)
    assertEquals(25.0, migrated.leftTiltDegrees, 0.0)
  }

  @Test fun cannotFitAwayAWeakerExtraShakeOrDeliberateOppositeFlick() {
    val shakes = Capture().apply {
      rest(840); lobe(3.2, 2); sample(); lobe(-3.2, 2); sample(); rest(280)
      lobe(0.8, 2); sample(); lobe(-0.8, 2); sample()
    }.finish("single")
    val flicks = Capture().apply { rest(840); flick(1.0, 3.2, 2); rest(280); flick(-1.0, 0.8, 2) }.finish("right")
    assertNull(MotionCalibration.fit(listOf(shakes), false).profile)
    assertNull(MotionCalibration.fit(listOf(flicks), false).profile)
  }

  @Test fun rejectsRotationWithoutTranslationalMotion() {
    val c = Capture(); c.rest(840)
    for (step in 0..30) {
      val angle = step * Math.PI / 60
      c.sample(kotlin.math.sin(angle), 0.0, kotlin.math.cos(angle))
    }
    repeat(60) { c.sample(1.0, 0.0, 0.0) }
    val frames = c.frames.toList()
    for (gesture in listOf("right", "single")) assertNull(MotionCalibration.fit(listOf(CalibrationTrial(gesture, frames)), false).profile)
  }

  @Test fun fitsRecordedPhysicalFlicksThatFinishInADifferentStablePosture() {
    val trials = listOf("right", "left").flatMap { name ->
      val raw = javaClass.getResourceAsStream("/motion/$name.csv")!!.bufferedReader().useLines { lines ->
        lines.drop(1).filter { it.isNotBlank() }.map { line ->
          val row = line.split(','); CalibrationFrame(row[2].toDouble(), row[3].toDouble(), row[4].toDouble(), row[0].toDouble().toLong())
        }.toList()
      }
      listOf(0L, 20L).map { phase ->
        var next = phase
        val sampled = raw.filter { frame -> if (frame.timestampMs < next) false else { while (next <= frame.timestampMs) next += 40; true } }
        val frames = (0L until 840 step 40).map { sampled.first().copy(timestampMs = it) }.toMutableList()
        // Uniformly sample the physical values; preserve the measured posture change.
        sampled.forEachIndexed { index, f -> frames.add(f.copy(timestampMs = 840 + index * 40L)) }
        while (frames.last().timestampMs < 4800) frames.add(sampled.last().copy(timestampMs = frames.last().timestampMs + 40))
        CalibrationTrial(name, frames)
      }
    }
    for (phase in 0..1) {
      val selected = trials.filterIndexed { index, _ -> index % 2 == phase }
      val fit = MotionCalibration.fit(selected, selectedGestures = listOf("right", "left"))
      assertNotNull("phase=$phase ${fit.message}", fit.profile)
      selected.forEach { assertEquals(it.gesture, listOf(it.gesture), replay(it, fit.profile)) }
    }
  }

  @Test fun rejectsNoiseMissingMotionMovingBaselineAndUnsettledCutoff() {
    val empty = Capture().apply { rest(4840) }.finish("right")
    assertNull(MotionCalibration.fit(listOf(empty), false).profile)
    val noisy = empty.copy(frames = empty.frames.mapIndexed { index, f -> f.copy(x = if (index % 2 == 0) 0.12 else -0.12) })
    assertNull(MotionCalibration.fit(listOf(noisy), false).profile)
    val baseline = trial("right").let { t -> t.copy(frames = t.frames.map { if (it.timestampMs < 640) it.copy(x = if (it.timestampMs % 80 == 0L) 0.6 else -0.6) else it }) }
    assertNull(MotionCalibration.fit(listOf(baseline), false).profile)
    val cutoff = trial("right").let { t -> t.copy(frames = t.frames.map { if (it.timestampMs >= 4400) it.copy(x = 1.5) else it }) }
    assertNull(MotionCalibration.fit(listOf(cutoff), false).profile)
  }

  @Test fun rejectsMalformedTimingNonfiniteValuesAndUnsupportedPrompt() {
    val t = trial("left")
    for (bad in listOf(t.copy(gesture = "diagonal"), t.copy(frames = t.frames.take(15)),
      t.copy(frames = t.frames.mapIndexed { i, f -> if (i == 25) f.copy(timestampMs = 10) else f }),
      t.copy(frames = t.frames.mapIndexed { i, f -> if (i == 25) f.copy(x = Double.NaN) else f }))) {
      assertNull(MotionCalibration.fit(listOf(bad), false).profile)
    }
  }

  @Test fun profileRoundTripsAndRejectsUnboundedOrUnknownValues() {
    val profile = MotionCalibration.fit(complete()).profile!!
    assertEquals(profile, MotionCalibrationProfile.parse(profile.toJson()))
    for (bad in listOf(JSONObject(profile.toJson().toString()).put("version", 99),
      JSONObject(profile.toJson().toString()).put("leftThresholdG", 0.01),
      JSONObject(profile.toJson().toString()).put("sequencePauseMs", 10000),
      JSONObject(profile.toJson().toString()).put("compoundSettleMs", 20))) assertNull(MotionCalibrationProfile.parse(bad))
  }
}
