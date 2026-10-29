package com.remotemac.gestures

import org.json.JSONArray
import org.json.JSONObject

/** Matches shared/openUrl.ts without depending on differences between platform URL parsers. */
internal object GestureUrls {
  private fun ipv4(host: String): Boolean {
    val parts = host.split('.')
    return parts.size == 4 && parts.all { it.matches(Regex("(0|[1-9][0-9]{0,2})")) && it.toInt() <= 255 }
  }
  private fun ipv6(host: String): Boolean {
    val halves = host.split("::")
    if (halves.size > 2) return false
    val groups = halves.flatMap { if (it.isEmpty()) emptyList() else it.split(':') }
    var count = 0
    for ((index, group) in groups.withIndex()) {
      if (group.contains('.')) {
        if (index != groups.lastIndex || !host.endsWith(group) || !ipv4(group)) return false
        count += 2
      } else {
        if (!group.matches(Regex("[a-fA-F0-9]{1,4}"))) return false
        count += 1
      }
    }
    return if (halves.size == 2) count < 8 else count == 8
  }
  private fun hostname(host: String): Boolean {
    if (host.isEmpty() || host.length > 253 || host.any { it.code > 127 }) return false
    if (host.matches(Regex("[0-9.]+")) && host.contains('.')) return ipv4(host)
    return host.removeSuffix(".").split('.').all { it.matches(Regex("[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?")) }
  }
  fun valid(value: String): Boolean {
    if (value.length !in 1..4096 || value.any { it.isWhitespace() || Character.isSpaceChar(it) || Character.isISOControl(it) || it == '\\' || it == '\uFEFF' || it in "<>\"{}|^`" } ||
      Regex("%(?![a-fA-F0-9]{2})").containsMatchIn(value)) return false
    val match = Regex("^[Hh][Tt][Tt][Pp][Ss]?://([^/?#]+)").find(value) ?: return false
    val authority = match.groupValues[1]
    if (value.substring(match.range.last + 1).any { it == '[' || it == ']' }) return false
    val parsed = if (authority.startsWith('[')) {
      val parts = Regex("\\[([^\\]]+)\\](?::([0-9]+))?").matchEntire(authority) ?: return false
      if (!ipv6(parts.groupValues[1])) return false
      parts
    } else {
      val parts = Regex("([^:]+)(?::([0-9]+))?").matchEntire(authority) ?: return false
      if (!hostname(parts.groupValues[1])) return false
      parts
    }
    val port = parsed.groups[2]?.value ?: return true
    return port.trimStart('0').ifEmpty { "0" }.toLongOrNull()?.let { it <= 65535 } == true
  }
}

internal data class GestureActionStep(val action: String, val mobile: Boolean = false,
  val appId: String? = null, val appName: String? = null, val command: String? = null, val url: String? = null) {
  fun parameters(): Map<String, Any> = buildMap {
    appId?.let { put("appId", it) }
    command?.let { put("command", it) }
    url?.let { put("url", it) }
  }
  companion object {
    private val builtins = setOf("screenshot", "kill_app", "lock", "photo_booth")
    private fun text(value: Any?, max: Int): String? = (value as? String)?.takeIf {
      it.isNotBlank() && it.length <= max && !it.contains('\u0000')
    }
    fun parse(value: Any?): GestureActionStep? {
      if (value is String) return value.takeIf { it in builtins }?.let { GestureActionStep(it) }
      val j = value as? JSONObject ?: return null
      return when (j.optString("type")) {
        "system" -> j.optString("action").takeIf { it in builtins }?.let { GestureActionStep(it) }
        "open_app" -> {
          val target = j.optString("target")
          if (target !in setOf("mobile", "server")) return null
          val id = text(j.opt("appId"), 2048) ?: return null
          if (target == "mobile" && !id.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+"))) return null
          GestureActionStep("open_app", target == "mobile", id, text(j.opt("appName"), 160))
        }
        "run_command" -> text(j.opt("command"), 4096)?.let { GestureActionStep("run_command", command = it) }
        "open_url" -> {
          val target = j.optString("target")
          val url = j.opt("url") as? String ?: return null
          if (target !in setOf("mobile", "server") || !GestureUrls.valid(url)) return null
          GestureActionStep("open_url", target == "mobile", url = url)
        }
        else -> null
      }
    }
    fun list(value: Any?): List<GestureActionStep> {
      if (value is String) return listOfNotNull(parse(value))
      val array = value as? JSONArray ?: return emptyList()
      if (array.length() > 20) return emptyList()
      // Reject a damaged list as a unit, instead of silently running a different sequence.
      return (0 until array.length()).map { parse(array.opt(it)) ?: return emptyList() }
    }
  }
}

/** A snapshot of one recognized gesture. Never persisted or replayed after process loss. */
internal class GestureActionSequence(steps: List<GestureActionStep>, val owner: String, val gesture: String, val count: Int) {
  val steps = steps.toList()
  var index = 0; private set
  var succeeded = 0; private set
  var failed = 0; private set
  var needsTap = 0; private set
  var operationId: String? = null; private set
  private val failures = mutableListOf<String>()
  val finished: Boolean get() = index >= steps.size
  val current: GestureActionStep? get() = steps.getOrNull(index)
  fun bind(id: String) { check(operationId == null && !finished); operationId = id }
  fun complete(id: String, outcome: String, message: String? = null): Boolean {
    if (operationId != id || outcome !in setOf("success", "failed", "not_sent", "needs_tap")) return false
    when (outcome) {
      "success" -> succeeded += 1
      "needs_tap" -> needsTap += 1
      else -> failed += 1
    }
    if (outcome != "success" && !message.isNullOrBlank()) failures.add("${index + 1}: ${message.take(240)}")
    operationId = null; index += 1
    return true
  }
  fun summary(): String = buildString {
    append("$succeeded of ${steps.size} actions completed")
    if (failed > 0) append(" · $failed failed")
    if (needsTap > 0) append(" · $needsTap need a notification tap")
    if (failures.isNotEmpty()) append(". ${failures.joinToString("; ")}")
  }
}

internal object GestureExecutionPolicy {
  fun needsWakeLock(appActive: Boolean, batchPending: Boolean, operationState: String?, backgroundOperation: Boolean, backgroundListening: Boolean): Boolean {
    if (appActive) return false
    if (operationState != null) return operationState == "running" && (batchPending || backgroundOperation)
    return batchPending || backgroundListening
  }
}
