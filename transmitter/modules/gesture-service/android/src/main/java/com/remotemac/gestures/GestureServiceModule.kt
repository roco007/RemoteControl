package com.remotemac.gestures

import android.Manifest
import android.app.Application
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import expo.modules.interfaces.permissions.PermissionsStatus
import expo.modules.kotlin.Promise
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class GestureServiceModule : Module() {
  private val main = Handler(Looper.getMainLooper())
  private val eventSink: (String, Map<String, Any?>) -> Unit = { name, data -> sendEvent(name, data) }
  override fun definition() = ModuleDefinition {
    Name("GestureService")
    Events("onStatus", "onGesture", "onAppState", "onCalibration")
    AsyncFunction("listInstalledApps") {
      GestureApplications(context() ?: error("Android context is unavailable")).list()
    }
    AsyncFunction("openMobileApp") { appId: String ->
      attach()
      GestureApplications(context() ?: error("Android context is unavailable")).open(appId)
    }.runOnQueue(Queues.MAIN)
    OnCreate { main.post { attach() } }
    OnStartObserving("onAppState") { main.post { attach(); sendEvent("onAppState", GestureRuntime.appStateStatus()) } }
    OnStartObserving("onStatus") { main.post { attach(); context()?.let { sendEvent("onStatus", GestureControl.status(it)) } } }
    OnStartObserving("onCalibration") { main.post { attach(); context()?.let { sendEvent("onCalibration", GestureCalibrationSession.status(it)) } } }
    AsyncFunction("getCalibrationStatus") {
      val context = context() ?: error("Android context is unavailable")
      attach(); GestureCalibrationSession.status(context)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("getCalibrationReadings") { gesture: String, draftSessionId: String? ->
      val context = context() ?: error("Android context is unavailable")
      GestureCalibrationSession.readings(context, gesture, draftSessionId)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("startCalibration") { gesture: String? ->
      val context = context() ?: error("Android context is unavailable")
      attach(); GestureCalibrationSession.start(context, gesture)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("captureCalibrationGesture") { sessionId: String -> GestureCalibrationSession.capture(sessionId) }.runOnQueue(Queues.MAIN)
    AsyncFunction("resumeCalibration") { sessionId: String -> GestureCalibrationSession.resume(sessionId) }.runOnQueue(Queues.MAIN)
    AsyncFunction("saveCalibration") { sessionId: String -> GestureCalibrationSession.save(sessionId) }.runOnQueue(Queues.MAIN)
    AsyncFunction("cancelCalibration") { sessionId: String -> GestureCalibrationSession.cancel(sessionId) }.runOnQueue(Queues.MAIN)
    AsyncFunction("configure") { raw: String ->
      val context = context() ?: error("Android context is unavailable")
      attach()
      GestureControl.configure(context, raw)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setEnabled") { enabled: Boolean ->
      val context = context() ?: error("Android context is unavailable")
      attach()
      GestureControl.setEnabled(context, enabled) ?: GestureControl.status(context)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("setBackgroundEnabled") { enabled: Boolean ->
      val context = context() ?: error("Android context is unavailable")
      attach()
      GestureControl.setBackgroundEnabled(context, enabled)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("stop") {
      val context = context() ?: error("Android context is unavailable")
      GestureControl.clear(context)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("clearPairing") {
      val context = context() ?: error("Android context is unavailable")
      GestureControl.clearPairing(context)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("getStatus") { val context = context() ?: error("Android context is unavailable"); GestureControl.status(context) }.runOnQueue(Queues.MAIN)
    AsyncFunction("triggerGesture") { gesture: String, expected: String ->
      val context = context() ?: error("Android context is unavailable")
      attach()
      MotionGestureService.instance?.triggerGesture(gesture, expected) ?: run {
        val status = GestureControl.status(context)
        mapOf("accepted" to false, "status" to status, "message" to
          if (status["controlEnabled"] == true) "Gesture controls are starting. Try again."
          else "Turn on Shake-to-Action to run saved actions.")
      }
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("completeGestureAction") { operationId: String, outcome: String, message: String? ->
      val context = context() ?: error("Android context is unavailable")
      GestureActions.completeForeground(context, operationId, outcome, message)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("resumeGestureActions") { operationId: String ->
      val context = context() ?: error("Android context is unavailable")
      GestureActions.recover(context, operationId)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("requestPinWidget") {
      val context = context() ?: error("Android context is unavailable")
      GestureWidgetProvider.requestPin(context)
    }.runOnQueue(Queues.MAIN)
    AsyncFunction("requestNotificationPermission") { promise: Promise ->
      val context = context()
      if (context == null) promise.resolve(false)
      else if (Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) promise.resolve(true)
      else appContext.permissions?.askForPermissions({ result -> promise.resolve(result[Manifest.permission.POST_NOTIFICATIONS]?.status == PermissionsStatus.GRANTED) }, Manifest.permission.POST_NOTIFICATIONS) ?: promise.resolve(false)
    }.runOnQueue(Queues.MAIN)
    OnDestroy { main.post {
      if (GestureRuntime.event === eventSink) {
        GestureRuntime.event = null
        GestureActions.foregroundDestroyed()
        GestureCalibrationSession.moduleDestroyed()
      }
    } }
  }
  private fun context(): Context? = appContext.reactContext?.applicationContext
  private fun attach() {
    context()?.let(GestureActions::attach)
    GestureRuntime.event = eventSink
    (context() as? Application)?.let { GestureRuntime.register(it, appContext.currentActivity) }
  }
}
