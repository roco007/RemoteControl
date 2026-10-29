package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class TiltReturnGestureTest {
  private class Trace(profile: MotionCalibrationProfile? = null, private val sampleIntervalMs: Long = 40) {
    var time = 0L
    val actions = mutableListOf<String>()
    val detector = MotionGestureDetector("directional", { _, _ -> }, { gesture, _ -> actions.add(gesture) }, profile)
    fun sample(x: Double, y: Double, z: Double) { detector.addSample(x, y, z, time); time += sampleIntervalMs }
    fun pose(degrees: Double, duration: Int = 320, pitch: Double = 0.0) {
      val roll = Math.toRadians(degrees); val p = Math.toRadians(pitch)
      repeat(duration / 40) { sample(sin(roll) * cos(p), cos(roll) * cos(p), sin(p)) }
    }
    fun move(from: Double, to: Double, duration: Int = 400) {
      val steps = duration / 40
      for (i in 1..steps) pose(from + (to - from) * i / steps, 40)
    }
  }

  @Test fun bothRollDirectionsFireExactlyOnceOnlyAfterReturningToStartingAngle() {
    for ((sign, expected) in listOf(1.0 to "left_straight", -1.0 to "right_straight")) {
      val t = Trace(); t.pose(6.0, 800); t.move(6.0, 6.0 + sign * 35); t.pose(6.0 + sign * 35)
      assertTrue(t.actions.isEmpty())
      t.move(6.0 + sign * 35, 6.0); t.pose(6.0, 2400)
      assertEquals(listOf(expected), t.actions)
    }
  }

  @Test fun differentMovementSpeedsAndRelaxedPortraitPitchAreSupported() {
    for (duration in listOf(160, 800, 1200)) for (sign in listOf(-1.0, 1.0)) {
      val t = Trace(); t.pose(0.0, 800, 20.0)
      val steps = duration / 40
      for (i in 1..steps) t.pose(sign * 32 * i / steps, 40, 20.0)
      t.pose(sign * 32, 240, 20.0)
      for (i in 1..steps) t.pose(sign * 32 * (1.0 - i.toDouble() / steps), 40, 20.0)
      t.pose(0.0, 1000, 20.0)
      assertEquals("duration=$duration sign=$sign", listOf(if (sign > 0) "left_straight" else "right_straight"), t.actions)
    }
  }

  @Test fun holdingTiltWithoutReturnAndSmallMotionNeverDispatch() {
    for (angle in listOf(12.0, 35.0, -35.0)) {
      val t = Trace(); t.pose(0.0, 800); t.move(0.0, angle); t.pose(angle, 6200)
      assertTrue(t.actions.isEmpty())
    }
  }

  @Test fun purePitchFlatPhoneAndTranslationCannotBecomeTiltReturn() {
    val pitch = Trace(); pitch.pose(0.0, 800); pitch.pose(0.0, 400, 40.0); pitch.pose(0.0, 2000)
    assertTrue(pitch.actions.isEmpty())
    val flat = Trace(); repeat(20) { flat.sample(0.0, 0.0, 1.0) }; repeat(12) { flat.sample(0.6, 0.0, 0.8) }; repeat(50) { flat.sample(0.0, 0.0, 1.0) }
    assertTrue(flat.actions.isEmpty())
    val translation = Trace(); translation.pose(0.0, 800); repeat(12) { translation.sample(0.6, 1.0, 0.0) }; translation.pose(0.0, 2000)
    assertTrue(translation.actions.none { it.endsWith("_straight") })
  }

  @Test fun anActiveTiltSuppressesTransientAccelerationAndItsBrake() {
    val t = Trace(); t.pose(0.0, 800); t.move(0.0, 35.0); t.pose(35.0)
    t.sample(-2.5, 0.8, 0.0); t.sample(2.5, 0.8, 0.0)
    t.pose(35.0, 240); t.move(35.0, 0.0); t.pose(0.0, 2000)
    assertEquals(listOf("left_straight"), t.actions)
  }

  @Test fun prolongedNonGravityMotionStillCancelsAQualifiedTilt() {
    val t = Trace(); t.pose(0.0, 800); t.move(0.0, 35.0); t.pose(35.0)
    repeat(20) { t.sample(2.5, 0.8, 0.0) }
    t.pose(0.0, 2000)
    assertTrue(t.actions.isEmpty())
  }

  @Test fun anExistingTightReturnProfileAllowsNaturalOvershootWithoutRecalibration() {
    val saved = MotionCalibrationProfile(rightReturnDegrees = 6.0, calibratedGestures = setOf("right_straight"))
    val t = Trace(saved); t.pose(0.0, 800); t.move(0.0, -35.0); t.pose(-35.0)
    t.move(-35.0, 7.0); t.pose(7.0, 40); t.move(7.0, 0.0, 120); t.pose(0.0, 1000)
    assertEquals(listOf("right_straight"), t.actions)
    assertEquals(6.0, saved.rightReturnDegrees, 0.0)
  }

  @Test fun resetAndTimeoutCancelAnIncompleteTilt() {
    for (reset in listOf(false, true)) {
      val t = Trace(); t.pose(0.0, 800); t.move(0.0, 35.0); t.pose(35.0)
      if (reset) t.detector.reset() else t.pose(35.0, 5000)
      t.move(35.0, 0.0); t.pose(0.0, 2000)
      assertTrue(t.actions.isEmpty())
    }
  }

  @Test fun crossingTheCentreIntoTheOppositeSideWithoutHoldingDoesNotComplete() {
    val t = Trace(); t.pose(0.0, 800); t.move(0.0, 35.0); t.pose(35.0)
    t.move(35.0, -35.0, 2800); t.pose(-35.0, 1000)
    assertTrue(t.actions.isEmpty())
  }

  @Test fun cooldownPreventsADuplicateAndNextIntentionalTiltStillWorks() {
    val t = Trace(); t.pose(0.0, 800); t.move(0.0, 35.0); t.pose(35.0); t.move(35.0, 0.0); t.pose(0.0, 320)
    t.pose(35.0, 160); t.pose(0.0, 240)
    assertEquals(listOf("left_straight"), t.actions)
    t.pose(0.0, 1400); t.move(0.0, -35.0); t.pose(-35.0); t.move(-35.0, 0.0); t.pose(0.0, 1000)
    assertEquals(listOf("left_straight", "right_straight"), t.actions)
  }

  @Test fun aSlowDeliberateRollDoesNotGetAbsorbedIntoTheIdleBaseline() {
    for ((outMs, returnMs) in listOf(2720 to 1600, 5400 to 400)) {
      val t = Trace(); t.pose(0.0, 800); t.move(0.0, 27.0, outMs); t.pose(27.0, 200)
      t.move(27.0, 0.0, returnMs); t.pose(0.0, 1000)
      assertEquals("out=$outMs return=$returnMs", listOf("left_straight"), t.actions)
    }
  }

  @Test fun changingDepthBeforeTheNextRollCannotMoveItsXYBaseline() {
    for (interval in listOf(39L, 40L, 41L)) {
      for (depth in listOf(0.0, 0.5, 1000.0)) {
        val t = Trace(sampleIntervalMs = interval)
        fun pose(degrees: Double, duration: Int) { repeat(duration / 40) {
          val roll = Math.toRadians(degrees)
          t.sample(sin(roll), cos(roll), if (t.time < 800) 0.0 else depth * sin(t.time.toDouble()))
        } }
        pose(0.0, 2000)
        for (i in 1..10) pose(3.5 * i, 40)
        pose(35.0, 320)
        for (i in 1..10) pose(35.0 - 3.5 * i, 40)
        pose(0.0, 1000)
        assertEquals("sample interval=$interval depth=$depth", listOf("left_straight"), t.actions)
      }
    }
  }
}
