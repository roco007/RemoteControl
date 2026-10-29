package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

class GestureCalibrationStateTest {
  @Test fun `background interruption keeps action guard until explicit cancel`() {
    val state = GestureCalibrationState()
    assertFalse(state.active)
    state.begin("first")
    state.startCapture()
    state.advanceCapture(1500)
    state.interrupt()
    assertTrue(state.active)
    assertEquals("interrupted", state.phase)
    assertEquals(0, state.accepted)
    assertFalse(state.canSave)
    state.end("Canceled")
    assertFalse(state.active)
    assertEquals("idle", state.phase)
  }

  @Test fun `five takes of each gesture are required before full calibration review`() {
    val state = GestureCalibrationState()
    state.begin("first")
    val expected = listOf("left", "right", "left_straight", "right_straight", "single", "double", "triple")
    assertEquals(35, state.total)
    for (take in 0 until 35) {
      assertEquals(take / 5, state.step)
      assertEquals(take % 5 + 1, state.repetition)
      assertEquals(expected[take / 5], state.gesture)
      assertFalse(state.canSave)
      state.startCapture()
      assertFalse(state.advanceCapture(1199))
      assertEquals("hold_still", state.phase)
      assertFalse(state.advanceCapture(1200))
      assertEquals("recording", state.phase)
      assertEquals(6500L, state.remainingMs)
      assertTrue(state.advanceCapture(7700))
      state.acceptCapture()
    }
    assertEquals(35, state.accepted)
    assertEquals(6, state.step)
    assertEquals(5, state.repetition)
    assertEquals("review", state.phase)
    assertTrue(state.canSave)
    assertTrue(state.active)
    assertNull(state.gesture)
  }

  @Test fun `each individual gesture requires five accepted recordings`() {
    for (gesture in GestureCalibrationState.ORDER) {
      val state = GestureCalibrationState()
      state.begin("target-$gesture", gesture)
      assertEquals(listOf(gesture), state.selectedGestures)
      assertEquals(5, state.total)
      assertEquals(0, state.step)
      assertEquals(gesture, state.gesture)
      repeat(5) { take ->
        assertEquals(take + 1, state.repetition)
        assertEquals(0, state.step)
        assertEquals(gesture, state.gesture)
        assertFalse(state.canSave)
        state.startCapture(); state.advanceCapture(7700); state.acceptCapture()
      }
      assertEquals(5, state.accepted)
      assertEquals("review", state.phase)
      assertTrue(state.canSave)
    }
  }

  @Test fun `rejected capture cannot advance gesture or release action guard`() {
    val state = GestureCalibrationState()
    state.begin("first")
    state.startCapture(); state.advanceCapture(7700)
    state.rejectCapture("That looked like a right flick. Try left again.")
    assertEquals("ready", state.phase)
    assertEquals("left", state.gesture)
    assertEquals(0, state.accepted)
    assertTrue(state.active)
  }

  @Test fun `starting over after interruption discards progress while keeping guard`() {
    val state = GestureCalibrationState()
    state.begin("first")
    state.startCapture(); state.advanceCapture(7700); state.acceptCapture()
    state.interrupt()
    state.begin("second")
    assertEquals("second", state.sessionId)
    assertEquals(0, state.accepted)
    assertEquals("ready", state.phase)
    assertTrue(state.active)
  }

  @Test fun `interrupted capture cannot later count as accepted`() {
    val state = GestureCalibrationState()
    state.begin("first"); state.startCapture(); state.interrupt()
    assertFalse(state.advanceCapture(7700))
    try { state.acceptCapture(); fail("Interrupted samples must not be accepted") }
    catch (_: IllegalStateException) { }
    assertEquals(0, state.accepted)
  }

  @Test fun `resume retains accepted takes and discards only unfinished capture`() {
    val state = GestureCalibrationState()
    state.begin("first")
    repeat(8) { state.startCapture(); state.advanceCapture(7700); state.acceptCapture() }
    state.startCapture(); state.advanceCapture(2400); state.interrupt()
    state.resume()
    assertTrue(state.active)
    assertEquals("ready", state.phase)
    assertEquals(8, state.accepted)
    assertEquals("right", state.gesture)
    assertEquals(4, state.repetition)
    assertFalse(state.advanceCapture(7700))
    state.startCapture(); state.advanceCapture(7700); state.acceptCapture()
    assertEquals(9, state.accepted)
  }

  @Test fun `resume from interrupted review preserves completed recording`() {
    val state = GestureCalibrationState()
    state.begin("first", "triple")
    repeat(5) { state.startCapture(); state.advanceCapture(7700); state.acceptCapture() }
    state.interrupt()
    assertFalse(state.canSave)
    state.resume()
    assertEquals("review", state.phase)
    assertEquals(5, state.accepted)
    assertTrue(state.canSave)
    assertTrue(state.active)
  }

  @Test fun `invalid selected gesture does not mutate current session or progress`() {
    val state = GestureCalibrationState()
    state.begin("first")
    state.startCapture(); state.advanceCapture(7700); state.acceptCapture()
    state.startCapture()
    try { state.begin("invalid", "pinch"); fail("Only supported motion gestures can be selected") }
    catch (_: IllegalArgumentException) { }
    assertEquals("first", state.sessionId)
    assertEquals(1, state.accepted)
    assertEquals("hold_still", state.phase)
    assertEquals(GestureCalibrationState.ORDER, state.selectedGestures)
    assertTrue(state.active)
  }

  @Test fun `cancel ends targeted session and cannot be resumed`() {
    val state = GestureCalibrationState()
    state.begin("first", "right_straight")
    state.startCapture(); state.interrupt(); state.end("Canceled")
    try { state.resume(); fail("Canceled sessions must remain ended") }
    catch (_: IllegalStateException) { }
    assertFalse(state.active)
    assertEquals("idle", state.phase)
  }

  @Test fun `obsolete compound gestures cannot be selected as tilt training`() {
    for (legacy in listOf("left_right", "right_left")) {
      val state = GestureCalibrationState()
      state.begin("current", "left_straight")
      try { state.begin("legacy", legacy); fail("Old flick sequences must not be treated as tilt calibration") }
      catch (_: IllegalArgumentException) { }
      assertEquals("current", state.sessionId)
      assertEquals("left_straight", state.gesture)
      assertTrue(state.active)
    }
  }
}
