package com.remotemac.gestures

import org.json.JSONObject

internal data class GestureActionOperation(val id: String, val action: String, val owner: String,
  val serverId: String = "", val deviceId: String = "", val state: String = "running", val gesture: String? = null) {
  fun toJson(): String = JSONObject().put("version", 1).put("id", id).put("action", action).put("owner", owner)
    .put("serverId", serverId).put("deviceId", deviceId).put("state", state)
    .apply { gesture?.let { put("gesture", it) } }.toString()
  companion object {
    fun parse(raw: String?): GestureActionOperation? = try {
      if (raw == null || raw.length > 2048) null else {
        val value = JSONObject(raw)
        val fields = setOf("version", "id", "action", "owner", "serverId", "deviceId", "state")
        require(value.opt("version") == 1 && value.keys().asSequence().all { it in fields || it == "gesture" })
        require(fields.minus("version").all { value.opt(it) is String })
        val id = value.getString("id"); val action = value.getString("action"); val owner = value.getString("owner")
        val server = value.getString("serverId"); val device = value.getString("deviceId"); val state = value.getString("state")
        require(id.length in 1..64 && action in GestureActionGate.ACTIONS && owner in setOf("foreground", "background"))
        require(server.length <= 64 && device.length <= 64 && state in setOf("running", "unknown"))
        val gesture = if (value.has("gesture")) {
          require(value.opt("gesture") is String)
          value.getString("gesture").also { require(it in GestureActionGate.GESTURES) }
        } else null
        GestureActionOperation(id, action, owner, server, device, state, gesture)
      }
    } catch (_: Exception) { null }
  }
}

/** One operation owns motion input until a correlated result or explicit recovery. */
internal class GestureActionGate {
  var pending: GestureActionOperation? = null; private set
  var revision = 0L; private set
  fun runningHeartbeat(id: String, owner: String): Boolean = pending?.let {
    it.id == id && it.owner == owner && it.state == "running"
  } == true
  fun restoreRevision(value: Long) { if (value >= 0) revision = maxOf(revision, value) }
  fun acquire(id: String, action: String, owner: String, serverId: String = "", deviceId: String = "", gesture: String? = null): GestureActionOperation? {
    if (pending != null || id.length !in 1..64 || action !in ACTIONS || owner !in OWNERS || (gesture != null && gesture !in GESTURES)) return null
    return GestureActionOperation(id, action, owner, serverId, deviceId, gesture = gesture).also { pending = it; revision += 1 }
  }
  fun update(id: String, outcome: String, owner: String? = null, action: String? = null): Boolean {
    val current = pending ?: return false
    if (current.id != id || (owner != null && current.owner != owner) || (action != null && current.action != action)) return false
    when (outcome) {
      "success", "failed", "not_sent" -> pending = null
      "running", "unknown" -> pending = current.copy(state = outcome)
      else -> return false
    }
    revision += 1
    return true
  }
  fun recover(id: String): Boolean {
    if (pending?.id != id || pending?.state != "unknown") return false
    pending = null; revision += 1; return true
  }
  fun restore(value: GestureActionOperation) {
    acquire(value.id, value.action, value.owner, value.serverId, value.deviceId, value.gesture)?.let { pending = it.copy(state = "unknown") }
  }
  fun transfer(id: String, owner: String): Boolean {
    val current = pending ?: return false
    if (current.id != id || owner !in OWNERS || current.owner == owner) return false
    pending = current.copy(owner = owner); revision += 1; return true
  }
  companion object {
    val ACTIONS = setOf("screenshot", "kill_app", "lock", "photo_booth", "open_app", "run_command", "open_url")
    val GESTURES = setOf("single", "double", "triple", "left", "right", "left_straight", "right_straight")
    private val OWNERS = setOf("foreground", "background")
  }
}

/** Bound unanswered queries, not the duration of a confirmed running action. */
internal class GestureActionPollBudget {
  private var unanswered = 0
  fun reset() { unanswered = 0 }
  fun tryQuery(): Boolean { if (unanswered >= 30) return false; unanswered += 1; return true }
}

internal class GestureActionWatchdog {
  private var operationId: String? = null
  private var expiresAt = 0L
  fun restart(id: String, nowMs: Long) { operationId = id; expiresAt = nowMs + 60_000 }
  fun clear() { operationId = null }
  fun expired(id: String, nowMs: Long): Boolean = operationId == id && nowMs >= expiresAt
}

internal class GesturePostActionPause {
  private var untilMs = 0L
  fun record(nowMs: Long, durationMs: Long) { untilMs = maxOf(untilMs, nowMs + durationMs) }
  fun remaining(nowMs: Long): Long = (untilMs - nowMs).coerceAtLeast(0)
}

/** Unregistering a listener does not remove already queued SensorEvents. */
internal class GestureSensorLease {
  var generation = 0L; private set
  private var startedAt: Long? = null
  fun start(nowNanos: Long): Long { generation += 1; startedAt = nowNanos; return generation }
  fun stop() { generation += 1; startedAt = null }
  fun accepts(timestampNanos: Long): Boolean = startedAt?.let { timestampNanos >= it } == true
  fun isCurrent(value: Long): Boolean = startedAt != null && generation == value
}
