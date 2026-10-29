package com.remotemac.gestures

/** Prompts and the fitter use the same first sensor frame as their time origin.
 * Registration can precede that frame by hundreds of milliseconds. */
internal class GestureCalibrationCaptureClock(private val registeredAt: Long) {
  private var firstFrameAt: Long? = null
  private var sampleClock: GestureCalibrationSampleClock? = null

  fun acceptFrame(timestampMs: Long, receivedAtMs: Long): Boolean {
    if (timestampMs < registeredAt || timestampMs > receivedAtMs) return false
    if (firstFrameAt == null) {
      if (startupTimedOut(receivedAtMs)) return false
      firstFrameAt = timestampMs
      sampleClock = GestureCalibrationSampleClock(timestampMs)
    }
    return sampleClock?.accept(timestampMs) == true
  }

  fun elapsedMs(nowMs: Long): Long? = firstFrameAt?.let { (nowMs - it).coerceAtLeast(0) }
  fun startupTimedOut(nowMs: Long): Boolean = firstFrameAt == null && nowMs - registeredAt >= 2500
}
