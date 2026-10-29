package com.remotemac.gestures

import org.json.JSONObject

/** Desired controls are independent of whether Android currently runs the service. */
internal data class GestureControlState(val enabled: Boolean? = null, val revision: Long = 0, val background: Boolean = false) {
  fun status(): Map<String, Any?> = mapOf("controlEnabled" to enabled, "controlRevision" to revision, "controlBackground" to background)
}

internal data class GestureControlSnapshot(val state: GestureControlState = GestureControlState(), val config: GestureConfig? = null)

/** Shared by React, notification and widget. A stale React render cannot undo a tap. */
internal object GestureControlPolicy {
  fun configure(current: GestureControlSnapshot, incoming: GestureConfig): GestureControlSnapshot? {
    if (incoming.json.optLong("controlRevision", 0) != current.state.revision) return null
    val initialized = current.state.enabled != null
    val background = if (!initialized && current.state.revision == 0L)
      incoming.json.optBoolean("controlBackground", incoming.background) else current.state.background
    val state = GestureControlState(
      current.state.enabled ?: incoming.enabled,
      current.state.revision + if (!initialized) 1 else 0,
      background)
    val json = JSONObject(incoming.json.toString())
    val saved = current.config
    // Foreground transport transitions may momentarily omit credentials. Retain only
    // a compatible pairing; an explicit different Mac or phone must pair again.
    if (saved?.canConnect == true && !incoming.canConnect && incoming.json.optBoolean("preservePairing", true) &&
      (incoming.host.isBlank() || incoming.host == saved.host) && incoming.port == saved.port &&
      (incoming.serverId.isBlank() || incoming.serverId == saved.serverId) &&
      (incoming.deviceId.isBlank() || incoming.deviceId == saved.deviceId)) {
      for (field in listOf("host", "port", "serverId", "deviceId", "deviceName", "token")) {
        if (!json.has(field) || json.optString(field).isBlank()) json.put(field, saved.json.opt(field))
      }
    }
    return GestureControlSnapshot(state, effective(GestureConfig(json), state))
  }

  fun setEnabled(current: GestureControlSnapshot, enabled: Boolean, fromWidget: Boolean = false): GestureControlSnapshot? {
    if (enabled && fromWidget && current.config?.let { it.canConnect || it.hasMobileActions } != true) return null
    val state = current.state.copy(enabled = enabled, revision = current.state.revision + 1,
      background = if (enabled && fromWidget) true else current.state.background)
    val config = current.config?.let {
      val updated = JSONObject(it.json.toString())
      if (enabled && fromWidget) updated.put("background", true).put("backgroundEligible", true)
      effective(GestureConfig(updated), state)
    }
    return GestureControlSnapshot(state, config)
  }

  fun setBackgroundEnabled(current: GestureControlSnapshot, enabled: Boolean): GestureControlSnapshot {
    val state = current.state.copy(background = enabled, revision = current.state.revision + 1)
    return GestureControlSnapshot(state, current.config?.let { effective(it, state) })
  }

  fun clear(current: GestureControlSnapshot): GestureControlSnapshot =
    GestureControlSnapshot(current.state.copy(enabled = false, revision = current.state.revision + 1), null)

  /** Revocation removes Mac authority, while independent phone actions remain configured. */
  fun clearPairing(current: GestureControlSnapshot): GestureControlSnapshot {
    val state = current.state.copy(revision = current.state.revision + 1)
    val config = current.config?.let {
      val json = JSONObject(it.json.toString())
      for (key in listOf("serverId", "token", "deviceId")) json.put(key, "")
      json.put("foregroundReady", false).put("preservePairing", false)
      effective(GestureConfig(json), state)
    }
    return GestureControlSnapshot(state, config)
  }

  fun effective(config: GestureConfig, state: GestureControlState): GestureConfig {
    val eligible = config.json.optBoolean("backgroundEligible", config.background)
    val json = JSONObject(config.json.toString()).put("enabled", state.enabled == true)
      .put("backgroundEligible", eligible).put("background", state.background && eligible)
    json.remove("resume"); json.remove("controlRevision"); json.remove("controlBackground")
    return GestureConfig(json)
  }
}
