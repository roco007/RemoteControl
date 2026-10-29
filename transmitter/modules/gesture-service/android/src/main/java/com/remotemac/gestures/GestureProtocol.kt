package com.remotemac.gestures

import org.json.JSONObject

internal data class GestureConfig(val json: JSONObject) {
  init {
    // Saved action assignments survive the replacement of the old flick
    // compounds. New explicit assignments, including "none", always win.
    json.optJSONObject("mappings")?.let { mappings ->
      for ((legacy, current) in listOf("left_right" to "left_straight", "right_left" to "right_straight")) {
        if (!mappings.has(current) && mappings.has(legacy)) mappings.put(current, mappings.opt(legacy))
        mappings.remove(legacy)
      }
    }
  }
  val enabled = json.optBoolean("enabled", false)
  val background = json.optBoolean("background", false)
  val foregroundReady = json.optBoolean("foregroundReady", false)
  val foregroundAllowed = json.optBoolean("foregroundAllowed", true)
  val mode = if (json.optString("mode") == "directional") "directional" else "count"
  val host = json.optString("host").trim().removeSurrounding("[", "]")
  val port = json.optInt("port", 9876)
  val serverId = json.optString("serverId")
  val deviceId = json.optString("deviceId")
  val deviceName = json.optString("deviceName", "Android phone").take(80)
  val token = json.optString("token")
  val canConnect: Boolean get() = host.isNotBlank() && host.length <= 253 && host.matches(Regex("[a-zA-Z0-9_.:%-]+")) && !host.contains("..") && port in 1..65535 && GestureProtocol.uuid(serverId) && GestureProtocol.uuid(deviceId) && token.matches(Regex("[a-f0-9]{64}")) && deviceName.isNotBlank()
  val url: String get() = "ws://${if (host.contains(':')) "[$host]" else host}:$port"
  fun actionsFor(gesture: String): List<GestureActionStep> {
    // Legacy names are configuration aliases only, never runnable gestures.
    if (gesture in setOf("left_right", "right_left")) return emptyList()
    return GestureActionStep.list(json.optJSONObject("mappings")?.opt(gesture))
  }
  fun actionFor(gesture: String): String = actionsFor(gesture).firstOrNull()?.action ?: "none"
  val hasMobileActions: Boolean get() = listOf("single", "double", "triple", "right", "left", "left_straight", "right_straight")
    .any { gesture -> actionsFor(gesture).any { it.mobile } }
  companion object { fun parse(raw: String): GestureConfig = GestureConfig(JSONObject(raw)) }
}

/** Bounds and validates only server messages used by the background control session. */
internal object GestureProtocol {
  fun uuid(value: String) = value.matches(Regex("[a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12}"))
  private fun integer(v: Any?) = v is Number && v.toDouble().isFinite() && v.toDouble() >= 0 && v.toDouble() <= 9007199254740991.0 && v.toDouble() == v.toLong().toDouble()
  private fun bounded(v: Any?, max: Int) = v is String && v.length in 1..max
  fun parse(raw: String): JSONObject? {
    if (raw.toByteArray(Charsets.UTF_8).size > 16384) return null
    return try {
      val j = JSONObject(raw)
      if (j.opt("v") != 1 || !integer(j.opt("seq")) || !integer(j.opt("timestamp"))) return null
      val fields = when (j.optString("type")) {
        "connection" -> {
          if (j.optString("state") !in setOf("hello", "ready", "permission_required", "busy") || !uuid(j.optString("serverId")) || !bounded(j.opt("name"), 80) || j.opt("permission") !is Boolean) return null
          val capabilities = j.optJSONArray("capabilities") ?: return null
          if (capabilities.length() > 20 || (0 until capabilities.length()).any { !bounded(capabilities.opt(it), 40) }) return null
          setOf("state", "serverId", "name", "permission", "capabilities")
        }
        "authentication_result" -> {
          if (j.opt("ok") !is Boolean || j.opt("permission") !is Boolean || !uuid(j.optString("serverId"))) return null
          if (j.has("token") && !j.optString("token").matches(Regex("[a-f0-9]{64}"))) return null
          if (j.has("error") && !bounded(j.opt("error"), 240)) return null
          setOf("ok", "serverId", "permission", "token", "error")
        }
        "pong" -> { if (!bounded(j.opt("id"), 64)) return null; setOf("id") }
        "system_action_result" -> {
          if (!bounded(j.opt("id"), 64) || j.optString("action") !in GestureActionGate.ACTIONS || j.opt("ok") !is Boolean) return null
          if (j.has("message") && !bounded(j.opt("message"), 240)) return null
          if (j.has("state") && (j.optString("state") !in setOf("running", "unknown") || j.getBoolean("ok"))) return null
          setOf("id", "action", "ok", "message", "state")
        }
        "error" -> { if (!bounded(j.opt("code"), 64) || !bounded(j.opt("message"), 240)) return null; setOf("code", "message") }
        else -> return null
      }
      val allowed = fields + setOf("v", "seq", "timestamp", "type")
      if (j.keys().asSequence().any { it !in allowed }) null else j
    } catch (_: Exception) { null }
  }
}
