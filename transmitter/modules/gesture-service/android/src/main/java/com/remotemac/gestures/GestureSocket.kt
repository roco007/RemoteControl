package com.remotemac.gestures

import android.os.Handler
import android.os.SystemClock
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** No pending action queue: a gesture is usable only on the current authenticated socket. */
internal enum class GestureActionSendResult { SENT, NOT_SENT, UNKNOWN }

internal class GestureSocket(private val main: Handler, private val onState: (String, String) -> Unit,
  private val pendingOperation: () -> GestureActionOperation?, private val onActionResult: (JSONObject) -> Boolean,
  private val onActionUnknown: (String) -> Unit) {
  private val client = OkHttpClient.Builder().connectTimeout(8, TimeUnit.SECONDS).readTimeout(0, TimeUnit.MILLISECONDS).build()
  private var socket: WebSocket? = null
  private var config: GestureConfig? = null
  private var generation = 0
  private var sequence = 0L
  private var authenticated = false
  private var awaitingAuth = false
  private var greeted = false
  private var permission = false
  private var capabilities = emptySet<String>()
  private var attempts = 0
  private var lastPong = 0L
  private var pingId = ""
  private var desired = false
  private var retry: Runnable? = null
  private var timeout: Runnable? = null
  private var heartbeat: Runnable? = null
  private var actionPoll: Runnable? = null
  private var polledActionId = ""
  private val actionPollBudget = GestureActionPollBudget()
  val ready: Boolean get() = authenticated && permission && "system_actions" in capabilities && "action_completion" in capabilities
  val hasSession: Boolean get() = authenticated
  var terminalFailure = false
    private set
  fun resetFailure() { terminalFailure = false }

  fun connect(value: GestureConfig) {
    if (terminalFailure) return
    close(); config = value; desired = true; attempts = 0
    // JS closes its foreground input session on the same lifecycle transition.
    scheduleOpen(350)
  }
  private fun scheduleOpen(delay: Long) {
    retry?.let(main::removeCallbacks)
    retry = Runnable { retry = null; if (desired) open() }.also { main.postDelayed(it, delay) }
  }
  private fun open() {
    val value = config ?: return
    val gen = ++generation
    authenticated = false; awaitingAuth = false; greeted = false; permission = false; capabilities = emptySet(); sequence = 0
    onState("connecting", "Connecting to your Mac over Wi-Fi…")
    try {
      socket = client.newWebSocket(Request.Builder().url(value.url).header("Origin", "remote-mac-control://native").build(), object : WebSocketListener() {
        override fun onMessage(webSocket: WebSocket, text: String) { main.post { if (generation == gen && desired) receive(text) } }
        override fun onClosing(webSocket: WebSocket, code: Int, reason: String) { webSocket.close(code, null); main.post { if (generation == gen && desired) fail("Mac disconnected; reconnecting…") } }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) { main.post { if (generation == gen && desired) fail("Mac unavailable; reconnecting over Wi-Fi…") } }
      })
      timeout = Runnable { if (generation == gen) fail("Mac connection timed out; reconnecting…") }.also { main.postDelayed(it, 10_000) }
    } catch (_: Exception) { fail("Invalid saved Mac address", false) }
  }
  private fun receive(raw: String) {
    val value = config ?: return
    val message = GestureProtocol.parse(raw) ?: run { fail("Invalid Mac response; open Remote Mac to reconnect", false); return }
    when (message.getString("type")) {
      "connection" -> {
        if (message.getString("state") == "busy") { fail("Mac session is busy; waiting for control…"); return }
        if (message.getString("serverId") != value.serverId) { fail("Saved Mac identity changed; reconnect in the app", false); return }
        permission = message.getBoolean("permission")
        val caps = message.getJSONArray("capabilities")
        capabilities = (0 until caps.length()).map { caps.getString(it) }.toSet()
        if (message.getString("state") == "hello") {
          if (greeted) { fail("Unexpected Mac greeting", false); return }
          greeted = true; awaitingAuth = true
          write(JSONObject().put("type", "authentication").put("deviceId", value.deviceId).put("deviceName", value.deviceName).put("token", value.token))
          startHeartbeat()
        } else if (authenticated) publishReady()
      }
      "authentication_result" -> {
        if (!greeted || !awaitingAuth || message.getString("serverId") != value.serverId) { fail("Unexpected Mac authentication response", false); return }
        awaitingAuth = false
        if (!message.getBoolean("ok")) { fail("Pairing expired; open Remote Mac to pair again", false); return }
        timeout?.let(main::removeCallbacks); timeout = null
        authenticated = true; permission = message.getBoolean("permission"); attempts = 0
        publishReady()
      }
      "pong" -> { if (pingId.isNotEmpty() && message.getString("id") == pingId) { lastPong = SystemClock.elapsedRealtime(); pingId = "" } }
      "system_action_result" -> {
        if (!authenticated) return
        val operation = pendingOperation() ?: return
        if (operation.id != message.getString("id") || operation.action != message.getString("action")) return
        val state = message.optString("state")
        if (state == "running") actionPollBudget.reset()
        if (state != "running") stopActionPolling(resetId = state != "unknown")
        if (onActionResult(message) && state == "running" && actionPoll == null) scheduleActionPoll(operation.id)
      }
      "error" -> {
        val code = message.getString("code")
        if (code == "permission_required") { permission = false; publishReady() }
        else if (code in setOf("unauthorized", "revoked", "device_revoked", "authentication_timeout", "rate_limited", "replayed_message", "malformed_message", "invalid_direction")) fail("Mac rejected control; reconnect in the app", false)
        else onState(if (ready) "connected" else "error", message.getString("message"))
      }
    }
  }
  private fun publishReady() {
    if (!permission) onState("error", "Enable Accessibility for the Mac receiver")
    else if ("system_actions" !in capabilities || "action_completion" !in capabilities) onState("error", "Update the Mac receiver to use gesture action completion")
    else onState("connected", "Listening in background over Wi-Fi")
    reconcilePending()
  }
  private fun startHeartbeat() {
    lastPong = SystemClock.elapsedRealtime()
    pingId = ""
    val gen = generation
    heartbeat = object : Runnable {
      override fun run() {
        if (generation != gen || !desired) return
        if (SystemClock.elapsedRealtime() - lastPong > 16_000) { fail("Mac stopped responding; reconnecting…"); return }
        if (pingId.isEmpty()) {
          pingId = SystemClock.elapsedRealtime().toString()
          write(JSONObject().put("type", "ping").put("id", pingId))
        }
        if (generation == gen) main.postDelayed(this, 5000)
      }
    }.also { main.postDelayed(it, 5000) }
  }
  fun sendAction(action: String, id: String, parameters: Map<String, Any> = emptyMap()): GestureActionSendResult {
    if (!ready) return GestureActionSendResult.NOT_SENT
    if (action == "photo_booth" && "photo_booth" !in capabilities) { onState("connected", "Update the Mac receiver to open Photo Booth"); return GestureActionSendResult.NOT_SENT }
    if (action in setOf("open_app", "run_command", "open_url") && action !in capabilities) {
      onState("connected", "Update the Mac receiver to use this action"); return GestureActionSendResult.NOT_SENT
    }
    if (action !in GestureActionGate.ACTIONS || pendingOperation()?.let { it.id == id && it.action == action } != true) return GestureActionSendResult.NOT_SENT
    if (action == "open_url" && (parameters["url"] as? String)?.let(GestureUrls::valid) != true) return GestureActionSendResult.NOT_SENT
    return try {
      val message = JSONObject().put("type", "system_action").put("action", action).put("id", id)
      if (action == "open_app") message.put("appId", parameters["appId"])
      if (action == "run_command") message.put("command", parameters["command"])
      if (action == "open_url") message.put("url", parameters["url"])
      if (!write(message)) GestureActionSendResult.NOT_SENT
      else {
        polledActionId = id; actionPollBudget.reset(); scheduleActionPoll(id)
        GestureActionSendResult.SENT
      }
    } catch (_: Exception) {
      onActionUnknown(id); GestureActionSendResult.UNKNOWN
    }
  }

  /** Read-only reconciliation; never replays an action after reconnect. */
  fun reconcilePending() {
    val operation = pendingOperation()
    if (operation == null) { stopActionPolling(); return }
    if (!authenticated || "action_completion" !in capabilities || polledActionId == operation.id) return
    val value = config ?: return
    if (operation.serverId != value.serverId || operation.deviceId != value.deviceId) { onActionUnknown(operation.id); return }
    polledActionId = operation.id; actionPollBudget.reset()
    queryAction(operation.id)
  }
  private fun scheduleActionPoll(id: String) {
    actionPoll?.let(main::removeCallbacks)
    actionPoll = Runnable { actionPoll = null; queryAction(id) }.also { main.postDelayed(it, 2000) }
  }
  private fun queryAction(id: String) {
    val operation = pendingOperation()?.takeIf { it.id == id } ?: run { stopActionPolling(); return }
    if (!authenticated || "action_completion" !in capabilities) return
    if (!actionPollBudget.tryQuery()) { onActionUnknown(id); return }
    val sent = runCatching { write(JSONObject().put("type", "system_action_status").put("id", id).put("action", operation.action)) }.getOrDefault(false)
    if (sent) scheduleActionPoll(id) else onActionUnknown(id)
  }
  private fun stopActionPolling(resetId: Boolean = true) {
    actionPoll?.let(main::removeCallbacks); actionPoll = null
    if (resetId) { polledActionId = ""; actionPollBudget.reset() }
  }
  private fun write(value: JSONObject): Boolean {
    val ws = socket ?: return false
    if (ws.queueSize() > 32768) { fail("Mac connection is congested; reconnecting…"); return false }
    val sent = ws.send(value.put("v", 1).put("seq", ++sequence).put("timestamp", System.currentTimeMillis()).toString())
    if (!sent) fail("Mac connection lost; reconnecting…")
    return sent
  }
  private fun fail(message: String, reconnect: Boolean = true) {
    closeSocket()
    if (!reconnect) terminalFailure = true
    onState(if (reconnect) "connecting" else "error", message)
    if (reconnect && desired) scheduleOpen(minOf(15_000L, 700L * (1L shl minOf(attempts++, 5))))
    else desired = false
  }
  private fun closeSocket() {
    ++generation
    stopActionPolling()
    retry?.let(main::removeCallbacks); timeout?.let(main::removeCallbacks); heartbeat?.let(main::removeCallbacks)
    retry = null; timeout = null; heartbeat = null
    val previous = socket; socket = null
    if (authenticated) previous?.send(JSONObject().put("v", 1).put("seq", ++sequence).put("timestamp", System.currentTimeMillis()).put("type", "release_all").toString())
    authenticated = false; permission = false
    previous?.close(1000, "Gesture session released")
    // Avoid retaining a disconnected native session while JS reconnects.
    previous?.cancel()
    pendingOperation()?.let { onActionUnknown(it.id) }
  }
  fun close() { desired = false; closeSocket() }
  fun dispose() { close(); client.dispatcher.executorService.shutdown(); client.connectionPool.evictAll() }
}
