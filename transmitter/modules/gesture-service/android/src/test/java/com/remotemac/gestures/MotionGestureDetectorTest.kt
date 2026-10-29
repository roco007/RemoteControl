package com.remotemac.gestures

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class MotionGestureDetectorTest {
  private class Trace(mode: String = "directional") {
    var now = 0L
    val actions = mutableListOf<Pair<String, Int>>()
    val progress = mutableListOf<Pair<Int, String>>()
    val detector = MotionGestureDetector(mode, { count, gesture -> progress.add(count to gesture) }, { gesture, count -> actions.add(gesture to count) })
    fun sample(x: Double = 0.0, y: Double = 1.0, z: Double = 0.0) = detector.addSample(x, y, z, now)
    fun advance(ms: Long) { now += ms; detector.tick(now) }
    // The opposite lobe decelerates the initial flick; it is not a second flick.
    fun flick(sign: Double) {
      sample(); advance(40); sample(sign * 2.5); advance(40); sample(sign * 1.8)
      advance(40); sample(); advance(40); sample(sign * -2.3)
      advance(40); sample(sign * -1.4); advance(40); sample()
    }
    fun settle() { advance(1100) }
  }

  @Test fun rightAndLeftFlicksIgnoreTheirBrakingLobes() {
    for ((sign, gesture) in listOf(1.0 to "right", -1.0 to "left")) {
      val t = Trace(); t.flick(sign)
      assertTrue(t.actions.isEmpty()); assertEquals(listOf(1 to gesture), t.progress)
      t.settle(); assertEquals(listOf(gesture to 1), t.actions)
    }
  }

  @Test fun twoOppositeFlicksAreAmbiguousAndCannotTriggerTiltReturn() {
    for (sign in listOf(-1.0, 1.0)) {
      val t = Trace(); t.flick(sign); t.advance(240); t.flick(-sign)
      assertTrue(t.actions.isEmpty())
      t.settle(); assertTrue(t.actions.isEmpty())
      assertEquals(0 to "", t.progress.last())
    }
  }

  @Test fun shortUnsettledRecoilDoesNotBecomeACompound() {
    val t = Trace(); t.flick(1.0); t.advance(60); t.sample(-2.8); t.advance(40); t.sample()
    t.settle(); assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun delayedBrakingOfOneLongFlickIsStillOnlyOneDirection() {
    val t = Trace(); t.sample(); t.advance(40); t.sample(2.5)
    t.advance(40); t.sample(); t.advance(320); t.sample(-2.4)
    t.advance(40); t.sample(); t.settle()
    assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun humanPacedSecondFlickDoesNotBecomeTiltReturn() {
    for (pause in listOf(200L, 450L, 700L)) {
      val t = Trace(); t.flick(-1.0); t.advance(pause); t.flick(1.0); t.settle()
      assertTrue("pause=$pause", t.actions.isEmpty())
    }
  }

  @Test fun aSecondFlickRampDoesNotBecomeTiltReturn() {
    val t = Trace(); t.flick(-1.0); t.advance(240)
    t.sample(0.9); t.advance(40); t.sample(1.4); t.advance(40); t.sample(2.5)
    assertTrue(t.actions.isEmpty())
  }

  @Test fun longLowAccelerationAfterRestDoesNotArmAnUnrelatedReversal() {
    val t = Trace(); t.flick(1.0); t.advance(240)
    repeat(10) { t.sample(0.9); t.advance(40) }
    t.sample(-2.8); t.advance(40); t.sample(); t.settle()
    assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun repeatedSameDirectionIsAmbiguousAndDoesNotFire() {
    val t = Trace(); t.flick(1.0); t.advance(240); t.flick(1.0); t.settle()
    assertTrue(t.actions.isEmpty())
  }

  @Test fun ignoresLowMotionOrientationChangesAndNonHorizontalShakes() {
    val t = Trace()
    for (v in listOf(Triple(0.0, 0.0, 1.0), Triple(1.0, 0.0, 0.0), Triple(-1.0, 0.0, 0.0), Triple(0.0, 1.0, 0.0), Triple(0.5, 0.4, 1.2), Triple(0.6, 3.0, 1.0), Triple(0.3, 0.0, -3.0))) {
      t.sample(v.first, v.second, v.third); t.advance(300)
    }
    t.settle(); assertTrue(t.actions.isEmpty()); assertTrue(t.progress.isEmpty())
  }

  @Test fun diagonalMovementDoesNotTriggerASide() {
    val t = Trace(); t.sample(); t.advance(40); t.sample(2.4, 3.3, 1.0); t.advance(40); t.sample()
    t.settle(); assertTrue(t.actions.isEmpty())
  }

  @Test fun progressClearsAndPendingGestureIsCanceledOnReset() {
    val t = Trace(); t.flick(-1.0); t.detector.reset(); t.settle()
    assertTrue(t.actions.isEmpty()); assertEquals(0 to "", t.progress.last())
    t.flick(1.0); t.settle(); assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun ambiguousFlickCooldownPreventsCommandsAndThenRecovers() {
    val t = Trace(); t.flick(-1.0); t.advance(240); t.flick(1.0)
    t.flick(-1.0); t.advance(300); t.flick(1.0)
    assertTrue(t.actions.isEmpty())
    t.advance(1100); t.flick(1.0); t.settle()
    assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun invalidAndBackwardsSamplesDoNotAlterAPendingGesture() {
    val t = Trace(); t.flick(1.0)
    t.detector.addSample(Double.NaN, 0.0, 1.0, t.now + 1)
    t.detector.addSample(Double.POSITIVE_INFINITY, 0.0, 1.0, t.now + 2)
    t.detector.addSample(-3.0, 0.0, 1.0, 0)
    t.detector.tick(-1); t.settle()
    assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun onlyResolvesSingleAfterTheFullPause() {
    val t = Trace(); t.sample(); t.advance(40); t.sample(2.5); t.advance(40); t.sample()
    t.advance(1059); assertTrue(t.actions.isEmpty())
    t.advance(1); assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun timestampOffsetDoesNotChangeResults() {
    val t = Trace(); t.now = 9_000_000; t.flick(-1.0); t.advance(400); t.flick(1.0)
    assertTrue(t.actions.isEmpty())
  }

  @Test fun prolongedMovementCancelsRatherThanFiringASingleMuchLater() {
    val t = Trace(); t.flick(1.0)
    repeat(35) { t.advance(80); t.sample(0.9) }
    t.advance(400); t.sample(); t.settle()
    assertTrue(t.actions.isEmpty()); assertEquals(0 to "", t.progress.last())
  }

  @Test fun aNewStationaryPostureSettlesWithoutDelayingLockIndefinitely() {
    val t = Trace(); t.flick(-1.0)
    repeat(24) { t.advance(80); t.sample(1.0, 0.0, 0.0) }
    assertEquals(listOf("left" to 1), t.actions)
    t.advance(2000); t.sample(); t.settle()
    assertEquals(listOf("left" to 1), t.actions)
  }

  @Test fun aGradualOnsetIsNotAbsorbedIntoGravityAndReversedByItsBrake() {
    val t = Trace(); t.sample(); t.advance(40); t.sample(0.3)
    t.advance(40); t.sample(0.6); t.advance(40); t.sample(1.8)
    t.advance(40); t.sample(-2.5); t.advance(40); t.sample(); t.settle()
    assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun smallUprightOrientationChangeBeforeAFlickReacquiresGravityWithoutABlackout() {
    val t = Trace(); t.sample()
    val uprightY = kotlin.math.sqrt(0.99)
    repeat(80) { t.advance(40); t.sample(0.1, uprightY, 0.8) }
    for (x in listOf(3.4, 2.8, 0.0, -3.0, -1.2, 0.0)) { t.advance(40); t.sample(0.1 + x, uprightY, 0.8) }
    repeat(8) { t.advance(40); t.sample(0.1, uprightY, 0.8) }
    t.settle(); assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun a120msRecoilGapStillDoesNotCountAsASecondFlick() {
    val t = Trace(); t.flick(1.0); t.advance(120); t.sample(-2.8)
    t.advance(40); t.sample(); t.settle()
    assertEquals(listOf("right" to 1), t.actions)
  }

  @Test fun sustainedWeakOnsetCannotBeReversedByAStrongerBrakingPeak() {
    for (sign in listOf(-1.0, 1.0)) for (samples in listOf(3, 7)) {
      val t = Trace(); t.sample()
      repeat(samples) { t.advance(40); t.sample(0.6 * sign) }
      t.advance(40); t.sample(-2.0 * sign); t.advance(40); t.sample(-1.5 * sign)
      t.advance(40); t.sample(); t.settle()
      assertTrue("A weak start is ambiguous, not the opposite action", t.actions.isEmpty())
    }
  }

  @Test fun briefSmallWindupDoesNotOverrideAClearOppositeFlick() {
    val t = Trace(); t.sample(); t.advance(40); t.sample(0.26)
    t.advance(40); t.sample(-2.5); t.advance(40); t.sample(2.4)
    t.advance(40); t.sample(); t.settle()
    assertEquals(listOf("left" to 1), t.actions)
  }

  @Test fun weakOnsetGuardSurvivesDurationBoundariesAndEvery40msSamplingPhase() {
    for (sign in listOf(-1.0, 1.0)) for (duration in listOf(100, 120, 160, 280)) for (phase in 0..39) {
      val actions = mutableListOf<String>()
      val detector = MotionGestureDetector("directional", { _, _ -> }, { gesture, _ -> actions.add(gesture) })
      var now = phase.toLong()
      while (now < 2200) {
        val x = when { now < 400 -> 0.0; now < 400 + duration -> 0.6 * sign; now < 480 + duration -> -2.5 * sign; else -> 0.0 }
        detector.addSample(x, 1.0, 0.0, now); now += 40
      }
      detector.tick(now + 1100)
      assertTrue("sign=$sign duration=$duration phase=$phase must not trigger the braking direction", actions.isEmpty())
    }
  }

  @Test fun countModeRecognizesCyclesAtDifferentSpeedsAxesAndPolarities() {
    for (interval in listOf(40L, 80L, 160L)) for (count in 1..3) for (axis in 0..1) for (sign in listOf(-1.0, 1.0)) {
      val t = Trace("count")
      repeat(count) {
        for (motion in listOf(0.0, 3.0 * sign, 0.0, -3.0 * sign)) {
          val v = doubleArrayOf(0.0, 1.0, 0.0); v[axis] += motion
          t.sample(v[0], v[1], v[2]); t.advance(interval)
        }
      }
      t.sample(); t.settle()
      assertEquals("interval=$interval count=$count axis=$axis sign=$sign", listOf(listOf("single", "double", "triple")[count - 1] to count), t.actions)
    }
  }

  @Test fun countModePreservesLowAmplitudeRawVerticalTrigger() {
    for (count in 1..3) {
      val t = Trace("count")
      repeat(count) { index ->
        for (y in listOf(1.0, 2.5, 1.0, -0.5)) { t.sample(y = y); t.advance(80) }
        t.sample(); if (index < count - 1) t.advance(580)
      }
      t.settle(); assertEquals(listOf(listOf("single", "double", "triple")[count - 1] to count), t.actions)
    }
  }

  @Test fun countModeCombinesSeparateBurstsWithShortPauses() {
    for (spacing in listOf(700L, 900L, 1000L)) for (count in 1..3) {
      val t = Trace("count")
      repeat(count) { index ->
        for (x in listOf(2.5, 1.7, 0.6, 1.7, -2.5, -1.7, -0.6, -1.7)) { t.sample(x); t.advance(40) }
        t.sample(); if (index < count - 1) t.advance(spacing - 320)
      }
      t.settle(); assertEquals("spacing=$spacing count=$count", listOf(listOf("single", "double", "triple")[count - 1] to count), t.actions)
    }
  }

  @Test fun countModeSupportsSeparateOneWayJerks() {
    val t = Trace("count"); t.sample(2.5); t.advance(50); t.sample(); t.advance(300); t.sample(2.5); t.advance(50); t.sample(); t.settle()
    assertEquals(listOf("double" to 2), t.actions)
  }

  @Test fun countModeDoesNotFinishWhileWeakerMovementContinues() {
    val t = Trace("count"); t.sample(2.5)
    repeat(40) { t.advance(40); t.sample(1.7) }
    assertTrue(t.actions.isEmpty()); t.sample(); t.settle(); assertEquals(listOf("single" to 1), t.actions)
  }

  @Test fun countModeResetCancelsAndRearms() {
    val t = Trace("count"); t.sample(2.5); t.detector.reset(); t.settle(); assertTrue(t.actions.isEmpty())
    t.sample(2.5); t.settle(); assertEquals(listOf("single" to 1), t.actions)
  }

  @Test fun countModeIgnoresQuietNoiseAndGravity() {
    val t = Trace("count")
    for (v in listOf(Triple(0.0, 0.0, 1.0), Triple(1.0, 0.0, 0.0), Triple(0.0, -1.0, 0.0), Triple(0.5, 0.4, 1.2))) {
      t.sample(v.first, v.second, v.third); t.advance(300)
    }
    t.settle(); assertTrue(t.actions.isEmpty())
  }

  @Test fun countModeSupportsImmediateMotionWithoutGravityBaseline() {
    val t = Trace("count")
    for (x in listOf(3.0, 0.0, -3.0, 0.0, 3.0, 0.0, -3.0)) { t.sample(x); t.advance(40) }
    t.sample(); t.settle(); assertEquals(listOf("double" to 2), t.actions)
  }

  @Test fun countModeHandlesBroadPeaksWithoutCountingEachSample() {
    for (cycles in 1..3) {
      val t = Trace("count")
      repeat(cycles) { for (x in listOf(0.0, 3.0, 3.0, 0.0, -3.0, -3.0)) { t.sample(x); t.advance(40) } }
      t.sample(); t.settle(); assertEquals(listOf(listOf("single", "double", "triple")[cycles - 1] to cycles), t.actions)
    }
  }

  @Test fun countModeSuppressesSustainedReboundAndQuickSameSidePeak() {
    val t = Trace("count"); t.sample(2.5)
    repeat(5) { t.advance(50); t.sample(-2.6) }
    t.advance(50); t.sample(); t.advance(50); t.sample(2.8); t.settle()
    assertEquals(listOf("single" to 1), t.actions)
  }
}
