package com.remotemac.gestures

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class GestureTriggerPolicyTest {
  private fun config(mode: String = "count", ready: Boolean = true, allowed: Boolean = true,
    enabled: Boolean = true, background: Boolean = false, mappings: String = """{"single":"screenshot","double":"lock","triple":"photo_booth","left":"lock","right":"screenshot","left_straight":"photo_booth","right_straight":"kill_app"}""") =
    GestureConfig(JSONObject().put("enabled", enabled).put("mode", mode).put("foregroundReady", ready)
      .put("foregroundAllowed", allowed).put("background", background).put("mappings", JSONObject(mappings)))

  private val foreground = GestureTriggerState(controlEnabled = true, appActive = true,
    calibrating = false, actionPending = false, batchPending = false, listening = false, backgroundReady = false)

  // Reproduce the bridge's gestureSteps payload from the literal test fixtures.
  private fun snapshot(config: GestureConfig?, gesture: String): String {
    val mapping = config?.json?.optJSONObject("mappings")?.opt(gesture)
    val steps = when (mapping) {
      is JSONArray -> mapping
      is String -> if (mapping == "none") JSONArray() else JSONArray().put(JSONObject().put("type", "system").put("action", mapping))
      else -> JSONArray()
    }
    return JSONObject().put("mode", config?.mode ?: "count").put("steps", steps).toString()
  }

  private fun admit(config: GestureConfig?, gesture: String, state: GestureTriggerState,
    manual: Boolean, recorded: Int = 0, expected: String? = snapshot(config, gesture)) =
    GestureTriggerPolicy.admit(config, gesture, state, manual, recorded, expected)

  @Test fun `manual trigger needs no accelerometer session or learned movement`() {
    val decision = admit(config(), "double", foreground, manual = true)
    assertTrue(decision.accepted)
    assertEquals("foreground", decision.sequence!!.owner)
    assertEquals("double", decision.sequence.gesture)
    assertEquals(2, decision.sequence.count)
    assertEquals(listOf("lock"), decision.sequence.steps.map { it.action })
    assertFalse(admit(config(), "double", foreground, manual = false, recorded = 2).accepted)
  }

  @Test fun `master disabled stale enabled config and foreground restrictions block taps`() {
    assertFalse(admit(config(), "single", foreground.copy(controlEnabled = false), manual = true).accepted)
    assertFalse(admit(config(enabled = false), "single", foreground, manual = true).accepted)
    assertFalse(admit(config(allowed = false), "single", foreground, manual = true).accepted)
    assertFalse(admit(config(background = true), "single", foreground.copy(appActive = false, backgroundReady = true), manual = true).accepted)
    assertFalse(admit(null, "single", foreground, manual = true).accepted)
  }

  @Test fun `calibration pending operation and inter step batch block both input paths`() {
    for (manual in listOf(true, false)) {
      val listening = foreground.copy(listening = true)
      for (blocked in listOf(listening.copy(calibrating = true), listening.copy(actionPending = true), listening.copy(batchPending = true))) {
        val decision = admit(config(), "single", blocked, manual = manual, recorded = 1)
        assertFalse(decision.accepted)
        assertNull(decision.sequence)
        assertTrue(decision.message.isNotBlank())
      }
    }
  }

  @Test fun `only current mode canonical gesture IDs can execute`() {
    for (gesture in listOf("single", "double", "triple")) {
      assertTrue(admit(config(), gesture, foreground, manual = true).accepted)
      assertFalse(admit(config(mode = "directional"), gesture, foreground, manual = true).accepted)
    }
    for (gesture in listOf("left", "right", "left_straight", "right_straight")) {
      assertTrue(admit(config(mode = "directional"), gesture, foreground, manual = true).accepted)
      assertFalse(admit(config(), gesture, foreground, manual = true).accepted)
    }
    for (gesture in listOf("left_right", "right_left", "unknown", "", "Single")) {
      assertFalse(admit(config(), gesture, foreground, manual = true).accepted)
      assertFalse(admit(config(mode = "directional"), gesture, foreground, manual = true).accepted)
    }
  }

  @Test fun `empty and damaged mapping are safe no ops without rewriting config`() {
    for (mappings in listOf("{}", """{"single":[]}""", """{"single":"none"}""", """{"single":[{"type":"system","action":"lock"},{"type":"bad"}]}""")) {
      val saved = config(mappings = mappings)
      val before = saved.json.toString()
      val decision = admit(saved, "single", foreground, manual = true)
      assertFalse(decision.accepted)
      assertNull(decision.sequence)
      assertTrue(decision.message.isNotBlank())
      assertEquals(before, saved.json.toString())
    }
  }

  @Test fun `offline phone apps and URLs can run but Mac only mapping cannot`() {
    val phone = config(ready = false, mappings = """{"single":[{"type":"open_app","target":"mobile","appId":"com.example.notes"},{"type":"open_url","target":"mobile","url":"https://example.com/phone?q=a%20b#top"}]}""")
    val decision = admit(phone, "single", foreground, manual = true)
    assertTrue(decision.accepted)
    assertTrue(decision.sequence!!.steps.all { it.mobile })
    assertEquals("https://example.com/phone?q=a%20b#top", decision.sequence.steps[1].url)
    assertFalse(admit(config(ready = false), "single", foreground, manual = true).accepted)
  }

  @Test fun `manual and recognized inputs snapshot the same ordered mixed action sequence`() {
    val saved = config(mappings = """{"single":[{"type":"open_app","target":"mobile","appId":"com.example.notes"},{"type":"run_command","command":"echo a test fixture"},{"type":"open_url","target":"server","url":"https://example.com/mac?q=one%20two#end"},{"type":"open_url","target":"mobile","url":"https://example.com/phone"}]}""")
    for (manual in listOf(true, false)) {
      val decision = admit(saved, "single", foreground.copy(listening = true), manual = manual, recorded = 1)
      assertTrue(decision.accepted)
      val sequence = decision.sequence!!
      assertEquals(listOf("open_app", "run_command", "open_url", "open_url"), sequence.steps.map { it.action })
      assertEquals(listOf(true, false, false, true), sequence.steps.map { it.mobile })
      assertEquals("com.example.notes", sequence.steps[0].appId)
      assertEquals("echo a test fixture", sequence.steps[1].command)
      assertEquals("https://example.com/mac?q=one%20two#end", sequence.steps[2].url)
      sequence.bind("phone-app")
      assertTrue(sequence.complete("phone-app", "success"))
      assertFalse(admit(saved, "single", foreground.copy(batchPending = true), manual = true).accepted)
      assertFalse(admit(saved, "single", foreground.copy(listening = true, batchPending = true), manual = false, recorded = 1).accepted)
      sequence.bind("command")
      assertTrue(sequence.complete("command", "failed", "Known failure"))
      sequence.bind("mac-url")
      assertFalse(sequence.complete("mac-url", "unknown"))
      assertEquals(2, sequence.index)
      assertTrue(sequence.complete("mac-url", "success"))
      sequence.bind("phone-url")
      assertTrue(sequence.complete("phone-url", "needs_tap", "Tap to open"))
      assertTrue(sequence.finished)
      assertEquals(2, sequence.succeeded)
      assertEquals(1, sequence.failed)
      assertEquals(1, sequence.needsTap)
    }
  }

  @Test fun `background recognition retains native ownership and background requirement`() {
    val background = foreground.copy(appActive = false, listening = true, backgroundReady = true)
    val decision = admit(config(background = true), "triple", background, manual = false, recorded = 3)
    assertTrue(decision.accepted)
    assertEquals("background", decision.sequence!!.owner)
    assertEquals(3, decision.sequence.count)
    assertFalse(admit(config(background = false), "triple", background, manual = false, recorded = 3).accepted)
    assertFalse(admit(config(background = true), "triple", background.copy(backgroundReady = false), manual = false, recorded = 3).accepted)
  }

  @Test fun `manual snapshot must match selected mode and current action before reserving a list`() {
    val saved = config()
    for (expected in listOf(
      """{"mode":"directional","steps":[{"type":"system","action":"screenshot"}]}""",
      """{"mode":"count","steps":[{"type":"system","action":"lock"}]}""",
      """{"mode":"count","steps":[]}"""
    )) {
      val decision = admit(saved, "single", foreground, manual = true, expected = expected)
      assertFalse(decision.accepted)
      assertNull(decision.sequence)
      assertTrue(decision.message.contains("updating"))
    }
    val matching = admit(saved, "single", foreground, manual = true,
      expected = """{"mode":"count","steps":[{"type":"system","action":"screenshot"}]}""")
    assertTrue(matching.accepted)
    assertEquals(listOf("screenshot"), matching.sequence!!.steps.map { it.action })
  }

  @Test fun `manual snapshot compares ordered executable parameters and application names`() {
    val saved = config(mappings = """{"single":[{"type":"open_app","target":"mobile","appId":"com.example.notes","appName":"Notes"},{"type":"run_command","command":"fixture command"},{"type":"open_url","target":"server","url":"https://example.com/path?q=old#end"}]}""")
    val changes = listOf(
      Triple(0, "target", "server"), Triple(0, "appId", "com.example.other"), Triple(0, "appName", "Other name"),
      Triple(1, "command", "changed fixture command"), Triple(2, "target", "mobile"),
      Triple(2, "url", "https://example.com/path?q=new#end")
    )
    for ((index, key, value) in changes) {
      val expected = JSONObject(snapshot(saved, "single"))
      expected.getJSONArray("steps").getJSONObject(index).put(key, value)
      val decision = admit(saved, "single", foreground, manual = true, expected = expected.toString())
      assertFalse("Changed $key at step $index must not execute stale settings", decision.accepted)
      assertNull(decision.sequence)
    }
    val reordered = JSONObject(snapshot(saved, "single"))
    val steps = reordered.getJSONArray("steps")
    val first = steps.get(0)
    steps.put(0, steps.get(1)); steps.put(1, first)
    assertFalse(admit(saved, "single", foreground, manual = true, expected = reordered.toString()).accepted)
    assertTrue(admit(saved, "single", foreground, manual = true).accepted)
  }

  @Test fun `manual missing malformed and damaged expected snapshots cannot run`() {
    for (expected in listOf(null, "", "not JSON", "[]", "{}",
      """{"mode":"count"}""", """{"steps":[{"type":"system","action":"screenshot"}]}""",
      """{"mode":"COUNT","steps":[{"type":"system","action":"screenshot"}]}""",
      """{"mode":"count","steps":[{"type":"system","action":"screenshot"}]} trailing""",
      """{"mode":"count","steps":"screenshot"}""", """{"mode":"count","steps":[null]}""",
      """{"mode":"count","steps":[{"type":"system","action":"screenshot"},{"type":"bad"}]}""")) {
      val decision = admit(config(), "single", foreground, manual = true, expected = expected)
      assertFalse("Malformed snapshot must not execute: $expected", decision.accepted)
      assertNull(decision.sequence)
    }
    // Sensor completion is already serialized with configuration and has no JS snapshot.
    assertTrue(admit(config(), "single", foreground.copy(listening = true), manual = false, recorded = 1, expected = null).accepted)
  }

  @Test fun `maximum sized escaped command list fits the expected snapshot`() {
    val steps = JSONArray()
    repeat(20) { steps.put(JSONObject().put("type", "run_command").put("command", "\\".repeat(4096))) }
    val saved = config(mappings = JSONObject().put("single", steps).toString())
    val decision = admit(saved, "single", foreground, manual = true)
    assertTrue(decision.accepted)
    assertEquals(20, decision.sequence!!.steps.size)
  }
}
