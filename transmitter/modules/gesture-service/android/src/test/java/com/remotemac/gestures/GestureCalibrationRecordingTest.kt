package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

class GestureCalibrationRecordingTest {
  @Test fun everyFiniteTakeIsKeptWithoutCheckingDirectionStrengthCountOrConsistency() {
    val examples = listOf(
      List(160) { CalibrationFrame(0.0, 1.0, 0.0, it * 40L) },
      List(160) { CalibrationFrame(0.0001 * (it % 2), 1.0, 0.0, it * 40L) },
      List(160) { CalibrationFrame(if (it % 3 == 0) -3.0 else 2.0, 0.1, 4.0, it * 40L) },
      List(160) { CalibrationFrame(0.0, 0.0, 1.0 + (it % 5), it * 40L) },
    )
    for (gesture in GestureCalibrationState.ORDER) for (frames in examples) {
      assertEquals(CalibrationTrial(gesture, frames), GestureCalibrationRecording.fromFrames(gesture, frames))
    }
  }

  @Test fun aSingleRealSensorFrameIsStillAKeptTake() {
    val frames = listOf(CalibrationFrame(0.0, 1.0, 0.0, 1200))
    assertEquals(CalibrationTrial("left", frames), GestureCalibrationRecording.fromFrames("left", frames))
  }

  @Test fun invalidSensorValuesCannotDiscardOtherRealSamples() {
    val valid = CalibrationFrame(0.2, 0.9, -0.1, 40)
    val frames = listOf(CalibrationFrame(Double.NaN, 1.0, 0.0, 0), valid,
      CalibrationFrame(0.0, Double.POSITIVE_INFINITY, 0.0, 80))
    assertEquals(CalibrationTrial("triple", listOf(valid)), GestureCalibrationRecording.fromFrames("triple", frames))
  }

  @Test fun absentOrUnreadableSensorDataCannotAdvanceATake() {
    assertNull(GestureCalibrationRecording.fromFrames("left", emptyList()))
    assertNull(GestureCalibrationRecording.fromFrames("left", listOf(CalibrationFrame(Double.NaN, 1.0, 0.0, 0))))
  }
}
