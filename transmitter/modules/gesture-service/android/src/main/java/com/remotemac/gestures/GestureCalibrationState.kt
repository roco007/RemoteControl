package com.remotemac.gestures

/** Pure calibration progression. active also owns the action-dispatch guard;
 * interruption intentionally does not release it. */
internal class GestureCalibrationState {
  var sessionId = ""; private set
  var active = false; private set
  var phase = "idle"; private set
  var accepted = 0; private set
  var remainingMs = 0L; private set
  var selectedGestures: List<String> = ORDER; private set
  var message = "Calibrate motion gestures to your movements."
  val total: Int get() = selectedGestures.size * REPETITIONS
  val gesture: String? get() = selectedGestures.getOrNull(accepted / REPETITIONS)
  val step: Int get() = (accepted / REPETITIONS).coerceAtMost(selectedGestures.lastIndex)
  val repetition: Int get() = accepted.coerceAtMost(total - 1) % REPETITIONS + 1
  val canSave: Boolean get() = active && phase == "review" && accepted == total

  fun begin(id: String, gesture: String? = null) {
    val selected = selection(gesture)
    selectedGestures = selected
    sessionId = id; active = true; phase = "ready"; accepted = 0; remainingMs = 0
    message = "Get ready. Each take will be kept."
  }

  fun startCapture() {
    check(active && phase == "ready") { "This calibration step is not ready to record" }
    phase = "hold_still"; remainingMs = HOLD_MS
    message = "Get ready."
  }

  fun advanceCapture(elapsedMs: Long): Boolean {
    if (!active || phase !in setOf("hold_still", "recording")) return false
    if (elapsedMs < HOLD_MS) {
      remainingMs = (HOLD_MS - elapsedMs).coerceAtLeast(0)
    } else {
      phase = "recording"; remainingMs = (HOLD_MS + RECORD_MS - elapsedMs).coerceAtLeast(0)
      message = "Perform your movement naturally; this take will be kept."
    }
    return elapsedMs >= HOLD_MS + RECORD_MS
  }

  fun acceptCapture() {
    check(active && phase == "recording" && remainingMs == 0L) { "Only a completed active recording can be accepted" }
    accepted += 1; remainingMs = 0
    phase = if (accepted == total) "review" else "ready"
    message = if (canSave) "All takes kept. Save to use your examples."
      else if (accepted % REPETITIONS == 0) "$REPETITIONS takes kept. Get ready for the next gesture."
      else "Take kept. Get ready for the next take."
  }

  fun rejectCapture(reason: String) {
    check(active && phase in setOf("hold_still", "recording")) { "There is no active capture" }
    phase = "ready"; remainingMs = 0; message = reason
  }

  fun interrupt() {
    if (!active) return
    phase = "interrupted"; remainingMs = 0
    message = "Calibration paused. Your accepted recordings are kept. Continue when ready, or cancel."
  }

  fun resume() {
    check(active && phase == "interrupted") { "Only an interrupted calibration can be continued" }
    phase = if (accepted == total) "review" else "ready"
    remainingMs = 0
    message = if (canSave) "Your recordings are ready to save."
      else "Your accepted recordings are kept. Continue with the next take."
  }

  fun end(reason: String) {
    active = false; phase = "idle"; remainingMs = 0; message = reason
  }

  companion object {
    val ORDER = listOf("left", "right", "left_straight", "right_straight", "single", "double", "triple")
    const val REPETITIONS = LearnedMotionCalibration.TAKES_PER_GESTURE
    const val HOLD_MS = 1200L
    const val RECORD_MS = 6500L
    fun selection(gesture: String?): List<String> {
      require(gesture == null || gesture in ORDER) { "Choose a supported motion gesture" }
      return if (gesture == null) ORDER else listOf(gesture)
    }
  }
}
