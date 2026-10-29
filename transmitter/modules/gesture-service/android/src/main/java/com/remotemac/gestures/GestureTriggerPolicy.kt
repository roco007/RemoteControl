package com.remotemac.gestures

import org.json.JSONObject
import org.json.JSONTokener

internal data class GestureTriggerState(val controlEnabled: Boolean, val appActive: Boolean,
  val calibrating: Boolean, val actionPending: Boolean, val batchPending: Boolean,
  val listening: Boolean, val backgroundReady: Boolean)

internal data class GestureTriggerDecision(val sequence: GestureActionSequence? = null, val message: String) {
  val accepted: Boolean get() = sequence != null
}

/** Admission is shared by sensor completion and taps; execution stays in the native sequence runner. */
internal object GestureTriggerPolicy {
  fun admit(config: GestureConfig?, gesture: String, state: GestureTriggerState, manual: Boolean,
    recorded: Int = 0, expected: String? = null): GestureTriggerDecision {
    if (!state.controlEnabled || config?.enabled == false) return reject("Turn on Shake-to-Action to run saved actions.")
    if (config == null) return reject("Gesture controls are starting. Try again.")
    if (manual && !state.appActive) return reject("Open Remote Mac to run a gesture from its card.")
    if (state.appActive && !config.foregroundAllowed) return reject("Gesture actions are paused.")
    if (state.calibrating) return reject("Finish or cancel gesture learning before running actions.")
    if (state.actionPending || state.batchPending) return reject("A gesture action list is already in progress.")
    val steps = config.actionsFor(gesture)
    if (manual && !matchesExpected(config.mode, steps, expected)) {
      return reject("Gesture settings are updating. Try again in a moment.")
    }
    val valid = if (config.mode == "directional") setOf("left", "right", "left_straight", "right_straight")
      else setOf("single", "double", "triple")
    if (gesture !in valid) return reject("This gesture is not in the selected mode.")
    if (!manual && !state.listening) return reject("Gesture listening is paused.")
    if (!state.appActive && !config.background) return reject("Background gestures are off.")
    if (steps.isEmpty()) return reject("No saved actions for this gesture.")
    val ready = if (state.appActive) config.foregroundReady else state.backgroundReady
    if (!ready && steps.none { it.mobile }) return reject("Connect to your Mac before running this gesture.")
    val count = if (!manual) recorded else when (gesture) { "double" -> 2; "triple" -> 3; else -> 1 }
    return GestureTriggerDecision(GestureActionSequence(steps, if (state.appActive) "foreground" else "background", gesture, count),
      "Running ${steps.size} saved ${if (steps.size == 1) "action" else "actions"}.")
  }

  /** Compare the visible card's snapshot before any action; configuration runs on the same queue. */
  private fun matchesExpected(mode: String, steps: List<GestureActionStep>, raw: String?): Boolean {
    if (raw == null || raw.length > 1_000_000) return false
    return try {
      val input = JSONTokener(raw)
      val expected = input.nextValue() as? JSONObject ?: return false
      if (input.nextClean() != '\u0000') return false
      if (expected.opt("mode") != mode) return false
      val values = expected.optJSONArray("steps") ?: return false
      if (values.length() > 20) return false
      val parsed = (0 until values.length()).map { index ->
        val value = values.optJSONObject(index) ?: return false
        GestureActionStep.parse(value) ?: return false
      }
      parsed == steps
    } catch (_: Exception) { false }
  }

  private fun reject(message: String) = GestureTriggerDecision(message = message)
}
