package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class GestureProtocolTest {
  @Test fun `background credentials require paired identity and bounded host`() {
    assertFalse(GestureConfig.parse("{\"enabled\":true,\"background\":true}").canConnect)
    assertFalse(GestureConfig.parse(valid.replace("mac.local", "https://evil/path")).canConnect)
    assertTrue(GestureConfig.parse(valid).canConnect)
  }
  @Test fun `unknown gesture actions are disabled`() {
    assertEquals("none", GestureConfig.parse("{\"mappings\":{\"left\":\"unlock\"}}").actionFor("left"))
    assertEquals("none", GestureConfig.parse(valid).actionFor("missing"))
  }
  @Test fun `legacy compound mappings migrate to tilt return without changing pairing`() {
    val raw = JSONObject(valid).put("mappings", JSONObject().put("left_right", "lock").put("right_left", "photo_booth").put("left", "screenshot"))
    val config = GestureConfig.parse(raw.toString())
    assertEquals("lock", config.actionFor("left_straight"))
    assertEquals("photo_booth", config.actionFor("right_straight"))
    assertEquals("screenshot", config.actionFor("left"))
    assertFalse(config.json.getJSONObject("mappings").has("left_right"))
    assertFalse(config.json.getJSONObject("mappings").has("right_left"))
    assertTrue(config.canConnect)
    assertTrue(config.enabled)
    assertTrue(config.background)
    assertEquals(uuid, config.serverId)
    assertEquals("a".repeat(64), config.token)
  }
  @Test fun `explicit new mapping wins over legacy alias including disabled action`() {
    val config = GestureConfig.parse("""{"mappings":{"left_right":"lock","left_straight":"none","right_left":"kill_app","right_straight":"screenshot"}}""")
    assertEquals("none", config.actionFor("left_straight"))
    assertEquals("screenshot", config.actionFor("right_straight"))
    assertEquals("none", config.actionFor("left_right"))
    assertEquals("none", config.actionFor("right_left"))
  }
  @Test fun `constructor and serialized reload both retain canonical mappings`() {
    val original = GestureConfig(JSONObject(valid).put("mappings", JSONObject().put("left_right", "kill_app")))
    val reloaded = GestureConfig.parse(original.json.toString())
    assertEquals("kill_app", original.actionFor("left_straight"))
    assertEquals("kill_app", reloaded.actionFor("left_straight"))
    assertFalse(reloaded.json.getJSONObject("mappings").has("left_right"))
    assertEquals(original.token, reloaded.token)
  }
  @Test fun `legacy alias does not bypass action allowlist`() {
    assertEquals("none", GestureConfig.parse("""{"mappings":{"left_right":"unlock"}}""").actionFor("left_straight"))
  }
  @Test fun `invalid or wrong direction server envelopes rejected`() {
    assertNull(GestureProtocol.parse("{\"type\":\"connection\"}"))
    assertNull(GestureProtocol.parse("{\"v\":1,\"seq\":1,\"timestamp\":1,\"type\":\"system_action\",\"action\":\"lock\"}"))
    assertNull(GestureProtocol.parse("x".repeat(16385)))
    assertNotNull(GestureProtocol.parse("{\"v\":1,\"seq\":1,\"timestamp\":1,\"type\":\"pong\",\"id\":\"1\"}"))
  }
  @Test fun `receiver identity and permission are mandatory in greetings`() {
    assertNull(GestureProtocol.parse("{\"v\":1,\"seq\":1,\"timestamp\":1,\"type\":\"connection\",\"state\":\"hello\",\"serverId\":\"bad\",\"name\":\"Mac\",\"permission\":true,\"capabilities\":[]}"))
    assertNull(GestureProtocol.parse("{\"v\":1,\"seq\":1,\"timestamp\":1,\"type\":\"authentication_result\",\"ok\":true,\"serverId\":\"$uuid\"}"))
  }
  @Test fun `action completion accepts correlated terminal and nonterminal results`() {
    val base = JSONObject().put("v", 1).put("seq", 1).put("timestamp", 1).put("type", "system_action_result")
      .put("id", "operation").put("action", "lock").put("ok", true)
    assertNotNull(GestureProtocol.parse(base.toString()))
    for (state in listOf("running", "unknown")) {
      val status = JSONObject(base.toString()).put("ok", false).put("state", state)
      assertNotNull(GestureProtocol.parse(status.toString()))
      assertNull(GestureProtocol.parse(status.put("ok", true).toString()))
    }
  }
  @Test fun `action completion bounds and action identity are strict`() {
    val base = JSONObject().put("v", 1).put("seq", 1).put("timestamp", 1).put("type", "system_action_result")
      .put("id", "operation").put("action", "screenshot").put("ok", false)
    for ((key, value) in listOf("id" to "", "id" to "a".repeat(65), "action" to "unlock", "ok" to "false",
      "message" to "", "message" to "m".repeat(241), "state" to "complete", "extra" to true)) {
      assertNull("$key=$value", GestureProtocol.parse(JSONObject(base.toString()).put(key, value).toString()))
    }
    assertNotNull(GestureProtocol.parse(base.put("id", "a".repeat(64)).put("message", "m".repeat(240)).toString()))
  }
  @Test fun `URL action results use the existing bounded result envelope without URL content`() {
    val result = JSONObject().put("v", 1).put("seq", 1).put("timestamp", 1).put("type", "system_action_result")
      .put("id", "url-operation").put("action", "open_url").put("ok", true)
    assertNotNull(GestureProtocol.parse(result.toString()))
    assertNull(GestureProtocol.parse(result.put("url", "https://example.com/private?token=secret").toString()))
  }
  companion object {
    const val uuid = "12345678-1234-1234-1234-123456789abc"
    val valid = """{"enabled":true,"background":true,"host":"mac.local","port":9876,"serverId":"$uuid","deviceId":"$uuid","deviceName":"Android phone","token":"${"a".repeat(64)}"}"""
  }
}
