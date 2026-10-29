package com.remotemac.gestures

/** Sensor-data boundary only. Movement shape never decides whether a take is kept. */
internal object GestureCalibrationRecording {
  fun fromFrames(gesture: String, frames: List<CalibrationFrame>): CalibrationTrial? {
    val recorded = frames.filter { it.x.isFinite() && it.y.isFinite() && it.z.isFinite() }
    return if (recorded.isEmpty()) null else CalibrationTrial(gesture, recorded)
  }
}
