package com.remotemac.gestures

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import java.io.File

class GestureActionSequenceTest {
  @Test fun `URL validation agrees with shared cross platform fixtures`() {
    val fixture = generateSequence(File(System.getProperty("user.dir"))) { it.parentFile }
      .map { File(it, "shared/open-url-fixtures.json") }.firstOrNull { it.isFile }
    assertNotNull("Run tests from within the RemoteControl checkout", fixture)
    val vectors = JSONObject(fixture!!.readText())
    for ((group, expected) in listOf("valid" to true, "invalid" to false)) {
      val urls = vectors.getJSONArray(group)
      for (index in 0 until urls.length()) {
        val url = urls.getString(index)
        assertEquals("$group URL fixture $index", expected, GestureUrls.valid(url))
      }
    }
    assertTrue(GestureUrls.valid("https://example.com:" + "0".repeat(40) + "443/path"))
    assertFalse(GestureUrls.valid("https://example.com:" + "9".repeat(40) + "/path"))
  }

  @Test fun `URL steps preserve target and exact path query and fragment`() {
    val url = "https://example.com/path?q=one%20two&n=2#details"
    for (target in listOf("mobile", "server")) {
      val step = GestureActionStep.parse(JSONObject().put("type", "open_url").put("target", target).put("url", url))
      assertNotNull(step)
      assertEquals("open_url", step!!.action)
      assertEquals(target == "mobile", step.mobile)
      assertEquals(mapOf("url" to url), step.parameters())
    }
  }

  @Test fun `URL steps reject unsafe and malformed destinations as a whole list`() {
    val invalid = listOf("", "example.com", "ftp://example.com", "javascript:alert(1)", "file:///tmp/a",
      "https://", "https:///path", "https://user:password@example.com/", "https://user@example.com/",
      "https://example.com/a b", "https://example.com/\npath", "https://example.com/\\path",
      " https://example.com/", "https://example.com/ ", "https://example.com/" + "x".repeat(4096))
    for (url in invalid) {
      val steps = org.json.JSONArray().put(JSONObject().put("type", "system").put("action", "screenshot"))
        .put(JSONObject().put("type", "open_url").put("target", "mobile").put("url", url))
      assertTrue("Rejected URL: $url", GestureActionStep.list(steps).isEmpty())
    }
    assertNull(GestureActionStep.parse(JSONObject().put("type", "open_url").put("target", "other").put("url", "https://example.com")))
  }

  @Test fun `deferred phone URL advances before a correlated Mac URL result`() {
    val steps = GestureActionStep.list(org.json.JSONArray()
      .put(JSONObject().put("type", "open_url").put("target", "mobile").put("url", "https://example.com/phone"))
      .put(JSONObject().put("type", "open_url").put("target", "server").put("url", "https://example.com/mac")))
    assertEquals(2, steps.size)
    val sequence = GestureActionSequence(steps, "background", "single", 1)
    sequence.bind("phone")
    assertTrue(sequence.complete("phone", "needs_tap", "Tap the notification to open the URL."))
    assertEquals(1, sequence.index)
    assertFalse(sequence.current!!.mobile)
    sequence.bind("mac")
    assertFalse(sequence.complete("mac", "unknown"))
    assertEquals(1, sequence.index)
    assertTrue(sequence.complete("mac", "success"))
    assertTrue(sequence.finished)
    assertEquals(1, sequence.needsTap)
    assertEquals(1, sequence.succeeded)
  }

  @Test fun `wake lock keeps offline phone detection active but releases unknown actions`() {
    assertTrue(GestureExecutionPolicy.needsWakeLock(false, false, null, false, true))
    assertTrue(GestureExecutionPolicy.needsWakeLock(false, true, "running", false, false))
    assertTrue(GestureExecutionPolicy.needsWakeLock(false, true, null, false, false))
    assertFalse(GestureExecutionPolicy.needsWakeLock(false, true, "unknown", true, true))
    assertFalse(GestureExecutionPolicy.needsWakeLock(true, true, "running", true, true))
    assertFalse(GestureExecutionPolicy.needsWakeLock(false, false, null, false, false))
  }
  @Test fun `legacy action and ordered steps both load without changing identities`() {
    assertEquals(listOf("lock"), GestureConfig.parse("""{"mappings":{"left":"lock"}}""").actionsFor("left").map { it.action })
    val config = GestureConfig.parse("""{"mappings":{"left":[{"type":"open_app","target":"mobile","appId":"com.example.phone","appName":"Phone"},{"type":"run_command","command":"printf hello"},{"type":"open_app","target":"server","appId":"com.apple.Notes"}]}}""")
    val steps = config.actionsFor("left")
    assertEquals(listOf("open_app", "run_command", "open_app"), steps.map { it.action })
    assertTrue(steps[0].mobile)
    assertEquals("com.example.phone", steps[0].appId)
    assertEquals("printf hello", steps[1].command)
    assertFalse(steps[2].mobile)
  }

  @Test fun `disabled malformed and oversized lists cannot execute`() {
    for (mapping in listOf("[]", "\"none\"", "[{\"type\":\"run_command\",\"command\":\" \"}]", "[{\"type\":\"open_app\",\"target\":\"unknown\",\"appId\":\"x\"}]")) {
      assertTrue(GestureConfig.parse("{\"mappings\":{\"single\":$mapping}}").actionsFor("single").isEmpty())
    }
    val oversized = org.json.JSONArray().also { a -> repeat(21) { a.put(JSONObject().put("type", "system").put("action", "lock")) } }
    assertTrue(GestureConfig.parse(JSONObject().put("mappings", JSONObject().put("single", oversized)).toString()).actionsFor("single").isEmpty())
  }

  @Test fun `known failure advances once but unknown result keeps the same step`() {
    val steps = GestureConfig.parse("""{"mappings":{"single":[{"type":"system","action":"screenshot"},{"type":"run_command","command":"true"}]}}""").actionsFor("single")
    val sequence = GestureActionSequence(steps, "foreground", "single", 1)
    sequence.bind("first")
    assertFalse(sequence.complete("stale", "success"))
    assertFalse(sequence.complete("first", "unknown"))
    assertEquals(0, sequence.index)
    assertTrue(sequence.complete("first", "failed", "Application unavailable"))
    assertEquals(1, sequence.index)
    assertFalse(sequence.complete("first", "success"))
    sequence.bind("second")
    assertTrue(sequence.complete("second", "success"))
    assertTrue(sequence.finished)
    assertEquals(1, sequence.failed)
    assertEquals(1, sequence.succeeded)
    assertTrue(sequence.summary().contains("1 failed"))
  }

  @Test fun `parameterized actions retain exact correlation through durable gate`() {
    val gate = GestureActionGate()
    for (action in listOf("open_app", "run_command", "open_url")) {
      val operation = gate.acquire("operation-$action", action, "background")!!
      assertEquals(action, GestureActionOperation.parse(operation.toJson())!!.action)
      assertFalse(gate.update(operation.id, "success", action = "lock"))
      assertTrue(gate.update(operation.id, "success", action = action))
    }
  }
}
