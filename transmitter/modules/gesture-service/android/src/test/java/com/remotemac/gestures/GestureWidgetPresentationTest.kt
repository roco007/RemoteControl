package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

class GestureWidgetPresentationTest {
  private fun sequence(gesture: String, steps: List<GestureActionStep> = listOf(GestureActionStep("lock"))) =
    GestureActionSequence(steps, "background", gesture, 1)

  @Test fun `each directional gesture fills the widget during its admitted sequence`() {
    for ((gesture, label) in listOf("left" to "Left", "right" to "Right",
      "left_straight" to "Left → Straight", "right_straight" to "Right → Straight")) {
      val batch = sequence(gesture)
      val gate = GestureActionGate()
      assertEquals(gesture, GestureWidgetPresentation.activeGesture(batch, null))
      assertEquals(label, GestureWidgetPresentation.activeLabel(batch, null))
      batch.bind("operation")
      gate.acquire("operation", "lock", "background", gesture = gesture)
      assertEquals(label, GestureWidgetPresentation.activeLabel(batch, gate.pending))
      assertTrue(gate.update("operation", "success"))
      assertTrue(batch.complete("operation", "success"))
      assertNull(GestureWidgetPresentation.activeGesture(batch, gate.pending))
      assertNull(GestureWidgetPresentation.activeLabel(batch, gate.pending))
    }
  }

  @Test fun `mixed phone and Mac lists retain one gesture through known failures and step gaps`() {
    val batch = sequence("left_straight", listOf(
      GestureActionStep("open_url", mobile = true, url = "https://example.com"),
      GestureActionStep("lock"),
      GestureActionStep("open_app", mobile = true, appId = "com.example.phone"),
      GestureActionStep("run_command", command = "true")))
    val gate = GestureActionGate()
    assertEquals("Left → Straight", GestureWidgetPresentation.activeLabel(batch, null))

    batch.bind("phone-url")
    assertEquals("Left → Straight", GestureWidgetPresentation.activeLabel(batch, null))
    assertTrue(batch.complete("phone-url", "success"))
    assertEquals("Left → Straight", GestureWidgetPresentation.activeLabel(batch, null))

    batch.bind("mac-lock")
    gate.acquire("mac-lock", "lock", "background", gesture = batch.gesture)
    assertEquals("Left → Straight", GestureWidgetPresentation.activeLabel(batch, gate.pending))
    assertTrue(gate.update("mac-lock", "failed"))
    assertTrue(batch.complete("mac-lock", "failed", "Mac unavailable"))
    assertEquals("Left → Straight", GestureWidgetPresentation.activeLabel(batch, gate.pending))

    batch.bind("phone-app")
    assertTrue(batch.complete("phone-app", "needs_tap"))
    assertEquals("Left → Straight", GestureWidgetPresentation.activeLabel(batch, null))

    batch.bind("mac-command")
    gate.acquire("mac-command", "run_command", "background", gesture = batch.gesture)
    assertEquals("Left → Straight", GestureWidgetPresentation.activeLabel(batch, gate.pending))
    assertTrue(gate.update("mac-command", "success"))
    assertTrue(batch.complete("mac-command", "success"))
    assertTrue(batch.finished)
    assertNull(GestureWidgetPresentation.activeLabel(batch, gate.pending))
  }

  @Test fun `uncertain completion restores the normal display until confirmed running again`() {
    val batch = sequence("right_straight")
    val gate = GestureActionGate()
    batch.bind("operation")
    gate.acquire("operation", "lock", "background", gesture = batch.gesture)
    assertTrue(gate.update("operation", "unknown"))
    assertFalse(batch.complete("operation", "unknown"))
    assertNull(GestureWidgetPresentation.activeGesture(batch, gate.pending))
    assertNull(GestureWidgetPresentation.activeLabel(batch, gate.pending))
    assertTrue(gate.update("operation", "running"))
    assertEquals("right_straight", GestureWidgetPresentation.activeGesture(batch, gate.pending))
    assertEquals("Right → Straight", GestureWidgetPresentation.activeLabel(batch, gate.pending))
  }

  @Test fun `explicit recovery and cancellation leave the normal widget visible`() {
    val gate = GestureActionGate()
    gate.acquire("operation", "lock", "background", gesture = "left")
    assertTrue(gate.update("operation", "unknown"))
    assertNull(GestureWidgetPresentation.activeLabel(null, gate.pending))
    assertTrue(gate.recover("operation"))
    assertNull(GestureWidgetPresentation.activeLabel(null, gate.pending))
  }

  @Test fun `cancelling remaining steps keeps the label until the running Mac action settles`() {
    val gate = GestureActionGate()
    gate.acquire("operation", "lock", "background", gesture = "right")
    assertEquals("right", GestureWidgetPresentation.activeGesture(null, gate.pending))
    assertEquals("Right", GestureWidgetPresentation.activeLabel(null, gate.pending))
    assertTrue(gate.update("operation", "success"))
    assertNull(GestureWidgetPresentation.activeLabel(null, gate.pending))
  }

  @Test fun `a finished list cannot hide a still running correlated operation`() {
    val finished = sequence("left")
    finished.bind("finished")
    assertTrue(finished.complete("finished", "success"))
    assertNull(GestureWidgetPresentation.activeLabel(finished, null))
    val operation = GestureActionOperation("running", "lock", "background", gesture = "right_straight")
    assertEquals("Right → Straight", GestureWidgetPresentation.activeLabel(finished, operation))
  }

  @Test fun `count gestures and idle state retain the normal widget`() {
    assertNull(GestureWidgetPresentation.activeLabel(null, null))
    for (gesture in listOf("single", "double", "triple", "left_right", "right_left", "")) {
      assertNull(gesture, GestureWidgetPresentation.activeGesture(sequence(gesture), null))
      assertNull(gesture, GestureWidgetPresentation.activeLabel(sequence(gesture), null))
      assertNull(gesture, GestureWidgetPresentation.activeLabel(null,
        GestureActionOperation("operation", "lock", "background", gesture = gesture)))
    }
    assertNull(GestureWidgetPresentation.activeLabel(null, GestureActionOperation("old", "lock", "background")))
  }

  @Test fun `restored direction is displayed only after the running action is confirmed`() {
    val saved = GestureActionOperation("operation", "open_url", "background", gesture = "left_straight")
    val gate = GestureActionGate()
    gate.restore(GestureActionOperation.parse(saved.toJson())!!)
    assertNull(GestureWidgetPresentation.activeLabel(null, gate.pending))
    assertTrue(gate.transfer("operation", "foreground"))
    assertNull(GestureWidgetPresentation.activeLabel(null, gate.pending))
    assertTrue(gate.update("operation", "running", "foreground"))
    assertEquals("Left → Straight", GestureWidgetPresentation.activeLabel(null, gate.pending))
    assertTrue(gate.update("operation", "failed", "foreground"))
    assertNull(GestureWidgetPresentation.activeLabel(null, gate.pending))
  }
}
