package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

class GestureCalibrationCaptureClockTest {
  @Test fun `150ms and 300ms startup delays keep motion prompt aligned with recorded baseline`() {
    for (delay in listOf(150L, 300L)) {
      val registeredAt = 10000L
      val firstFrameAt = registeredAt + delay
      val clock = GestureCalibrationCaptureClock(registeredAt)
      val state = GestureCalibrationState().apply { begin("test"); startCapture() }
      assertNull(clock.elapsedMs(firstFrameAt - 1))
      assertTrue(clock.acceptFrame(firstFrameAt, firstFrameAt))
      assertFalse(state.advanceCapture(clock.elapsedMs(firstFrameAt + 1199)!!))
      assertEquals("hold_still", state.phase)
      assertFalse(state.advanceCapture(clock.elapsedMs(firstFrameAt + 1200)!!))
      assertEquals("recording", state.phase)

      // Perform exactly on Move now. The fitter measures baseline/onset relative
      // to the first captured frame, so delayed sensor startup must not reject it.
      val frames = mutableListOf(CalibrationFrame(0.0, 1.0, 0.0, firstFrameAt))
      for (elapsed in 40L..7700L step 40) {
        val time = firstFrameAt + elapsed
        if (clock.acceptFrame(time, time)) {
          val x = when (elapsed) { in 1200L..1240L -> 2.8; in 1320L..1360L -> -2.38; else -> 0.0 }
          frames.add(CalibrationFrame(x, 1.0, 0.0, time))
        }
      }
      val fit = MotionCalibration.fit(listOf(CalibrationTrial("right", frames)), requireComplete = false)
      assertNotNull("startup delay=$delay: ${fit.message}", fit.profile)
      assertFalse(state.advanceCapture(clock.elapsedMs(firstFrameAt + 7699)!!))
      assertTrue(state.advanceCapture(clock.elapsedMs(firstFrameAt + 7700)!!))
    }
  }

  @Test fun `sensor startup is bounded and late first frames cannot bypass timeout`() {
    val clock = GestureCalibrationCaptureClock(1000)
    assertNull(clock.elapsedMs(3499))
    assertFalse(clock.startupTimedOut(3499))
    assertTrue(clock.startupTimedOut(3500))
    assertFalse(clock.acceptFrame(3500, 3500))
    assertFalse(clock.acceptFrame(1200, 3500))
    assertNull(clock.elapsedMs(4000))
  }

  @Test fun `stale or future sensor frames cannot set capture origin`() {
    val clock = GestureCalibrationCaptureClock(1000)
    assertFalse(clock.acceptFrame(999, 1100))
    assertFalse(clock.acceptFrame(1200, 1100))
    assertNull(clock.elapsedMs(1100))
    assertTrue(clock.acceptFrame(1150, 1151))
    assertEquals(0L, clock.elapsedMs(1150))
    assertEquals(800L, clock.elapsedMs(1950))
    assertFalse(clock.startupTimedOut(4000))
  }
}
