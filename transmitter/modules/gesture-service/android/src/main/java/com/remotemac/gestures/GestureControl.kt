package com.remotemac.gestures

import android.app.Application
import android.content.Context
import android.content.Intent
import android.os.Build

/** All callers run on Android's main thread, including widget and service callbacks. */
internal object GestureControl {
  fun configure(context: Context, raw: String): Map<String, Any?> {
    val store = GestureStore(context)
    val next = GestureControlPolicy.configure(store.snapshot(), GestureConfig.parse(raw)) ?: return status(context)
    store.save(next)
    apply(context, next)
    return publish(context)
  }

  fun setEnabled(context: Context, enabled: Boolean, fromWidget: Boolean = false): Map<String, Any?>? {
    val store = GestureStore(context)
    val next = GestureControlPolicy.setEnabled(store.snapshot(), enabled, fromWidget) ?: return null
    store.save(next)
    try { apply(context, next, fromWidget) }
    catch (error: RuntimeException) {
      // A rejected foreground-service start must not leave the widget claiming ON.
      if (fromWidget) {
        store.save(GestureControlPolicy.setEnabled(next, false)!!)
        stopService(context)
      }
      publish(context)
      throw error
    }
    return publish(context)
  }

  fun clear(context: Context): Map<String, Any?> {
    val store = GestureStore(context)
    store.save(GestureControlPolicy.clear(store.snapshot()))
    stopService(context)
    return publish(context)
  }

  fun clearPairing(context: Context): Map<String, Any?> {
    val store = GestureStore(context)
    val next = GestureControlPolicy.clearPairing(store.snapshot())
    store.save(next)
    apply(context, next)
    return publish(context)
  }

  fun setBackgroundEnabled(context: Context, enabled: Boolean): Map<String, Any?> {
    val store = GestureStore(context)
    val next = GestureControlPolicy.setBackgroundEnabled(store.snapshot(), enabled)
    store.save(next)
    apply(context, next)
    return publish(context)
  }

  private fun apply(context: Context, next: GestureControlSnapshot, widgetInteraction: Boolean = false) {
    val config = next.config
    if (next.state.enabled != true || config == null) { stopService(context); return }
    MotionGestureService.instance?.let { it.configure(config); return }
    if (!GestureRuntime.active && !widgetInteraction) return
    (context.applicationContext as? Application)?.let { GestureRuntime.register(it, null) }
    val intent = Intent(context, MotionGestureService::class.java)
    if (config.background && Build.VERSION.SDK_INT >= 26) context.startForegroundService(intent) else context.startService(intent)
  }

  private fun stopService(context: Context) {
    if (MotionGestureService.instance?.stopListening(false) == true) return
    context.stopService(Intent(context, MotionGestureService::class.java))
  }

  fun status(context: Context): Map<String, Any?> {
    GestureActions.attach(context)
    val state = GestureStore(context).state
    val service = MotionGestureService.instance
    val activeGesture = if (service != null) service.activeGesture else GestureWidgetPresentation.activeGesture(null, GestureActions.pending)
    val runtime = service?.status() ?: mapOf(
      "enabled" to false, "listening" to false, "background" to false, "appActive" to GestureRuntime.active,
      "connection" to "disconnected", "count" to 0, "lastCount" to 0, "lastGesture" to "", "lastAction" to "",
      "message" to if (state.enabled == true) "Gestures enabled; open Remote Mac to start" else "Gesture listening is off")
    return runtime + state.status() + mapOf("stoppedByUser" to (state.enabled == false), "activeGesture" to activeGesture) + GestureActions.status() +
      (if (GestureActions.pending != null) mapOf("listening" to false, "message" to GestureActions.message()) else emptyMap())
  }

  fun publish(context: Context): Map<String, Any?> = status(context).also {
    GestureRuntime.emit("onStatus", it)
    GestureWidgetProvider.refresh(context)
  }
}
