package com.remotemac.gestures

internal object GestureWidgetPresentation {
  private val labels = mapOf("left" to "Left", "right" to "Right",
    "left_straight" to "Left → Straight", "right_straight" to "Right → Straight")

  fun activeGesture(batch: GestureActionSequence?, operation: GestureActionOperation?): String? {
    // Unknown completion must reveal the normal status, even with remaining steps.
    if (operation != null && operation.state != "running") return null
    // The list owns the gesture between steps and during phone-only actions. A
    // cancelled list can leave one Mac action running until its result arrives.
    val gesture = batch?.takeUnless { it.finished }?.gesture ?: operation?.gesture
    return gesture?.takeIf { it in labels }
  }

  fun activeLabel(batch: GestureActionSequence?, operation: GestureActionOperation?): String? =
    labels[activeGesture(batch, operation)]
}
