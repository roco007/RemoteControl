package com.remotemac.gestures

/** Sensor sampling periods are hints. Keep a stable 25Hz target rather than
 * skipping everything less than 40ms after the previous (possibly late) frame. */
internal class GestureCalibrationSampleClock(startedAt: Long) {
  private var nextAt = startedAt
  private var lastAccepted: Long? = null
  fun accept(timestampMs: Long): Boolean {
    if (timestampMs < nextAt || lastAccepted?.let { timestampMs - it < 15 } == true) return false
    nextAt += ((timestampMs - nextAt) / 40 + 1) * 40
    lastAccepted = timestampMs
    return true
  }
}
