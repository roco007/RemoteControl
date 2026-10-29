package com.remotemac.gestures

import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import org.json.JSONObject
import java.util.UUID

/** Process-level ownership survives Service/React replacement. Stored metadata
 * contains correlation only, never pairing credentials or an action queue. */
internal object GestureActions {
  private val main = Handler(Looper.getMainLooper())
  private val gate = GestureActionGate()
  private val watchdog = GestureActionWatchdog()
  private val postActionPause = GesturePostActionPause()
  private var context: Context? = null
  private var timeout: Runnable? = null
  private var notificationQueued = false
  val pending: GestureActionOperation? get() = gate.pending

  fun attach(value: Context) {
    if (context == null) {
      context = value.applicationContext
      gate.restoreRevision(preferences().getLong("revision", 0))
      GestureActionOperation.parse(preferences().getString("operation", null))?.let(gate::restore)
      persist()
    }
    val operation = pending
    if (GestureRuntime.active && MotionGestureService.instance == null && operation?.owner == "background") {
      gate.update(operation.id, "unknown"); gate.transfer(operation.id, "foreground"); persist()
    }
  }
  fun lifecycleChanged() { context?.let(::attach) }
  fun adoptForNative(config: GestureConfig) {
    val operation = pending ?: return
    if (operation.owner == "foreground" && !GestureRuntime.active && GestureRuntime.event == null && config.background && config.canConnect) {
      gate.update(operation.id, "unknown"); gate.transfer(operation.id, "background"); changed()
    }
  }
  fun foregroundDestroyed() {
    val value = context ?: return
    attach(value)
    val operation = pending ?: return
    if (operation.owner == "foreground") {
      gate.update(operation.id, "unknown")
      if (MotionGestureService.instance?.canReconcileBackground == true) gate.transfer(operation.id, "background")
      changed()
    }
  }

  fun acquire(value: Context, action: String, owner: String, config: GestureConfig, debounceMs: Long, gesture: String? = null): GestureActionOperation? {
    attach(value)
    val operation = gate.acquire(UUID.randomUUID().toString(), action, owner, config.serverId, config.deviceId, gesture) ?: return null
    if (!persist()) { gate.update(operation.id, "not_sent"); persist(); return null }
    postActionPause.record(SystemClock.elapsedRealtime(), debounceMs)
    armTimeout(operation.id)
    return operation
  }

  fun completeForeground(value: Context, id: String, outcome: String, message: String? = null): Map<String, Any?> {
    attach(value)
    if (outcome == "running" && gate.runningHeartbeat(id, "foreground")) {
      // A confirmed receiver reply refreshes liveness without creating another
      // status revision/event that could cause a reconciliation loop in JS.
      armTimeout(id)
      return GestureControl.status(value)
    }
    if (gate.update(id, outcome, owner = "foreground")) {
      MotionGestureService.instance?.actionCompleted(id, outcome, message)
      changed()
    }
    return GestureControl.status(value)
  }

  fun backgroundResult(result: JSONObject): Boolean {
    val outcome = if (result.has("state")) result.getString("state") else if (result.getBoolean("ok")) "success" else "failed"
    if (!gate.update(result.getString("id"), outcome, "background", result.getString("action"))) return false
    MotionGestureService.instance?.actionCompleted(result.getString("id"), outcome, result.optString("message").takeIf { it.isNotBlank() })
    changed(); return true
  }

  fun notSent(id: String, message: String = "Action was not sent to the Mac.") {
    if (gate.update(id, "not_sent")) {
      MotionGestureService.instance?.actionCompleted(id, "not_sent", message)
      changed()
    }
  }
  fun unknown(id: String) {
    if (pending?.id == id && pending?.state != "unknown" && gate.update(id, "unknown")) changed()
  }
  fun recover(value: Context, id: String): Map<String, Any?> {
    attach(value)
    if (gate.recover(id)) {
      MotionGestureService.instance?.abortBatch("Remaining actions cancelled after unknown completion.")
      changed()
    }
    return GestureControl.status(value)
  }
  fun nativeUnavailable(value: Context) {
    val wasBackground = pending?.owner == "background"
    attach(value)
    val operation = pending ?: return
    if (wasBackground || operation.owner == "background") {
      gate.update(operation.id, "unknown"); gate.transfer(operation.id, "foreground"); changed()
    }
  }

  fun status(): Map<String, Any?> {
    val operation = pending
    return mapOf("actionRevision" to gate.revision, "actionPending" to (operation != null), "actionOperationId" to operation?.id,
      "actionOwner" to operation?.owner, "actionState" to (operation?.state ?: "idle"),
      "actionName" to operation?.action, "actionServerId" to operation?.serverId, "actionDeviceId" to operation?.deviceId)
  }
  fun message(): String = if (pending?.state == "unknown") "Action status unknown · Resume gestures to continue" else "Action in progress…"
  fun resumeDelayMs(): Long = postActionPause.remaining(SystemClock.elapsedRealtime())
  fun pauseAfterSequence(durationMs: Long) { postActionPause.record(SystemClock.elapsedRealtime(), durationMs) }

  private fun preferences() = context!!.getSharedPreferences("remote_mac_gesture_action", Context.MODE_PRIVATE)
  private fun persist(): Boolean = runCatching {
    val edit = preferences().edit().putLong("revision", gate.revision)
    pending?.let { edit.putString("operation", it.toJson()) } ?: edit.remove("operation")
    edit.commit()
  }.getOrDefault(false)
  private fun armTimeout(id: String) {
    timeout?.let(main::removeCallbacks)
    watchdog.restart(id, SystemClock.elapsedRealtime())
    timeout = Runnable {
      if (watchdog.expired(id, SystemClock.elapsedRealtime())) { timeout = null; unknown(id) }
    }.also { main.postDelayed(it, 60_000) }
  }
  private fun changed() {
    persist()
    val operation = pending
    if (operation?.state == "running") armTimeout(operation.id)
    else { timeout?.let(main::removeCallbacks); timeout = null; watchdog.clear() }
    if (notificationQueued) return
    notificationQueued = true
    main.post {
      notificationQueued = false
      MotionGestureService.instance?.actionStateChanged()
      context?.let(GestureControl::publish)
      GestureRuntime.emit("onAppState", GestureRuntime.appStateStatus())
    }
  }
}
