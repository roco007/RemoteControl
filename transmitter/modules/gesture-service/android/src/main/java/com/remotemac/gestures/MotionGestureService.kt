package com.remotemac.gestures

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.os.SystemClock
import android.util.Log
import java.util.UUID

/** The sensor and background socket run without a mounted React view or JS timer. */
class MotionGestureService : Service(), SensorEventListener {
  private val main = Handler(Looper.getMainLooper())
  private lateinit var sensors: SensorManager
  private lateinit var store: GestureStore
  private lateinit var socket: GestureSocket
  private var config: GestureConfig? = null
  private var detector: MotionGestureDetector? = null
  private var calibrationRevision = -1L
  private var listening = false
  private val sensorLease = GestureSensorLease()
  private var resumeSensors: Runnable? = null
  private var actionDebounceMs = 1000L
  private var stopAfterAction = false
  private var promoted = false
  private var connection = "disconnected"
  private var message = "Gesture listening is off"
  private var count = 0
  private var lastCount = 0
  private var lastGesture = ""
  private var lastAction = ""
  private var batch: GestureActionSequence? = null
  private var batchSummary = ""
  private var nextAction: Runnable? = null
  private var wakeLock: PowerManager.WakeLock? = null
  private var wasActive: Boolean? = null
  private val ticker = object : Runnable {
    override fun run() {
      val generation = sensorLease.generation
      if (listening) detector?.tick(SystemClock.elapsedRealtime())
      if (listening && sensorLease.isCurrent(generation)) main.postDelayed(this, 60)
    }
  }

  override fun onCreate() {
    super.onCreate(); instance = this; store = GestureStore(this); GestureActions.attach(this)
    sensors = getSystemService(Context.SENSOR_SERVICE) as SensorManager
    socket = GestureSocket(main, { state, detail ->
      if (socket.terminalFailure) {
        // Revoke only Mac authority; offline phone app mappings remain available.
        val local = GestureControlPolicy.clearPairing(store.snapshot())
        store.save(local)
        local.config?.let(::configure) ?: stopListening(false)
      } else {
        connection = state; message = detail; updateWakeLock(); updateSensors(); publish()
      }
    }, { GestureActions.pending?.takeIf { it.owner == "background" } }, GestureActions::backgroundResult, GestureActions::unknown)
    if (Build.VERSION.SDK_INT >= 26) {
      (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).createNotificationChannel(
        NotificationChannel(CHANNEL, "Background gestures", NotificationManager.IMPORTANCE_LOW).apply { description = "Shows when Remote Mac listens for enabled motion gestures" })
    }
  }
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    if (intent?.action == STOP) { stopListening(true); return START_NOT_STICKY }
    val saved = store.snapshot().config
    if (saved == null) { GestureActions.nativeUnavailable(this); stopListening(false); return START_NOT_STICKY }
    val reconciling = GestureActions.pending?.owner == "background" && saved.canConnect
    if (!reconciling && (!saved.enabled || store.state.enabled != true || (!GestureRuntime.active && !saved.background))) { stopListening(false); return START_NOT_STICKY }
    configure(saved)
    return if (saved.background || reconciling) START_STICKY else START_NOT_STICKY
  }
  internal fun configure(value: GestureConfig) {
    val previous = config
    val calibration = GestureCalibrationStore(this).load()
    val recognitionProfile = MotionXY.effectiveProfile(calibration)
    val changedSession = previous == null || calibrationRevision != calibration.revision || previous.mode != value.mode || previous.serverId != value.serverId || previous.host != value.host || previous.port != value.port || previous.token != value.token || previous.json.optJSONObject("mappings")?.toString() != value.json.optJSONObject("mappings")?.toString()
    val changedConnection = previous == null || previous.serverId != value.serverId || previous.deviceId != value.deviceId || previous.host != value.host || previous.port != value.port || previous.token != value.token
    if (previous != null && changedConnection) abortBatch("Remaining actions cancelled because the selected Mac or pairing changed.")
    config = value
    GestureActions.adoptForNative(value)
    if (!value.enabled || store.state.enabled != true) {
      abortBatch("Remaining actions cancelled because gestures were turned off.")
      if (GestureActions.pending?.owner == "background") { stopAfterAction = true; appStateChanged() }
      else stopListening(false)
      return
    }
    stopAfterAction = false
    // Android can deliver a rapid OFF -> ON start to the same Service object
    // before its pending destruction; restore the runtime handle in that case.
    instance = this
    // Terminal auth/protocol failures stay stopped until the foreground client
    // authenticates again, or the selected Mac/credential actually changes.
    if ((GestureRuntime.active && value.foregroundReady) || (previous != null &&
        (previous.serverId != value.serverId || previous.token != value.token || previous.host != value.host || previous.port != value.port))) socket.resetFailure()
    if (changedSession) {
      stopSensors()
      calibrationRevision = calibration.revision
      detector = MotionGestureDetector(value.mode, { progress, gesture ->
        count = progress
        if (progress > 0) { lastGesture = gesture; Log.i(TAG, "detected $gesture ($progress)") }
        publish()
      }, ::onGesture, recognitionProfile, calibration.readings)
      // The exact pending-action token still blocks every sensor sample. Once
      // complete, adaptive recognition observes fresh rest immediately; older
      // count/legacy paths retain their dispatch-anchored debounce.
      actionDebounceMs = detector!!.postActionPauseMs
    }
    if (changedConnection) { socket.close(); connection = "disconnected"; wasActive = null }
    if (value.background || GestureActions.pending?.owner == "background") promote() else demote()
    appStateChanged()
  }
  internal fun calibrationChanged() {
    // Reset before entering or leaving training so an unfinished gesture can
    // never become a command when calibration releases its action guard.
    stopSensors()
    config?.let(::configure)
  }
  internal fun appStateChanged() {
    val value = config ?: return
    val active = GestureRuntime.active
    socket.reconcilePending()
    val operation = GestureActions.pending
    if (batch?.finished == false && !active && !promoted) {
      try { promote() }
      catch (_: RuntimeException) { abortBatch("Android could not keep the action list active in background. Open Remote Mac and try again.") }
    }
    if (operation != null) {
      stopSensors(); message = GestureActions.message(); wasActive = active
      if (operation.owner == "background") {
        if (!promoted) promote()
        if (!socket.hasSession && connection != "connecting" && !socket.terminalFailure && value.canConnect) {
          connection = "connecting"; socket.connect(value)
        }
        socket.reconcilePending()
      } else { socket.close(); connection = "foreground" }
      updateWakeLock(); publish(); return
    }
    if (batch != null) {
      stopSensors()
      // A phone app may hide Remote Mac; the admitted list keeps its original transport.
      message = "Running action ${(batch?.index ?: 0) + 1} of ${batch?.steps?.size}"
      scheduleNextAction()
      updateWakeLock(); publish(); return
    }
    if (stopAfterAction || !value.enabled || store.state.enabled != true) { stopListening(false); return }
    if (wasActive != active) { stopSensors(); socket.close(); connection = "disconnected"; wasActive = active }
    if (GestureCalibrationSession.active) {
      stopSensors(); socket.close(); connection = "disconnected"
      message = if (active) "Calibrating gestures · actions paused" else "Calibration paused · open Remote Mac"
      updateWakeLock(); publish(); return
    }
    if (active) {
      socket.close()
      connection = "foreground"
      message = if (value.foregroundReady || (value.hasMobileActions && value.foregroundAllowed)) {
        if (value.background) "Listening · Background enabled" else "Listening while this app is open"
      } else "Open the controls and connect to your Mac"
    } else if (!value.background) {
      socket.close()
      connection = "disconnected"; message = "Background gestures are off"
    } else if (!value.canConnect) {
      socket.close()
      connection = if (value.hasMobileActions) "disconnected" else "error"
      message = if (value.hasMobileActions) "Listening for phone app actions · Mac disconnected" else "Connect and pair over Wi-Fi before using background gestures"
    } else if (socket.terminalFailure) {
      connection = "error"; message = "Open Remote Mac and reconnect before using background gestures"
    } else if (!socket.hasSession && connection != "connecting") {
      // Repeated foregroundReady configuration updates must not reset a healthy socket.
      connection = "connecting"; socket.connect(value)
    }
    updateWakeLock(); updateSensors(); publish()
  }
  private fun updateSensors() {
    val value = config
    val shouldListen = value?.enabled == true && store.state.enabled == true && !GestureCalibrationSession.active && GestureActions.pending == null && batch == null &&
      (if (GestureRuntime.active) value.foregroundAllowed && (value.foregroundReady || value.hasMobileActions) else value.background && (socket.ready || value.hasMobileActions))
    if (!shouldListen) { stopSensors(); return }
    if (listening) return
    val pause = GestureActions.resumeDelayMs()
    if (pause > 0) {
      stopSensors(); message = "Getting ready for the next gesture"
      resumeSensors = Runnable { resumeSensors = null; appStateChanged() }.also { main.postDelayed(it, pause) }
      return
    }
    val sensor = sensors.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    if (sensor == null) { message = "Motion sensor unavailable"; return }
    detector?.reset()
    sensorLease.start(SystemClock.elapsedRealtimeNanos())
    listening = sensors.registerListener(this, sensor, 40_000, main)
    if (listening) main.post(ticker) else { sensorLease.stop(); message = "Could not start the motion sensor" }
  }
  private fun stopSensors() {
    resumeSensors?.let(main::removeCallbacks); resumeSensors = null
    sensorLease.stop()
    sensors.unregisterListener(this); listening = false; main.removeCallbacks(ticker)
    detector?.reset(); count = 0
  }
  override fun onSensorChanged(event: SensorEvent) {
    if (!listening || GestureCalibrationSession.active || GestureActions.pending != null || batch != null || !sensorLease.accepts(event.timestamp)) return
    detector?.addSample(event.values[0] / SensorManager.GRAVITY_EARTH.toDouble(), event.values[1] / SensorManager.GRAVITY_EARTH.toDouble(), event.values[2] / SensorManager.GRAVITY_EARTH.toDouble(), event.timestamp / 1_000_000)
  }
  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit
  private fun onGesture(gesture: String, recorded: Int) {
    startGesture(gesture, recorded, manual = false)
  }

  /** Called on the same main queue as sensor callbacks; no sensor or learned profile is required. */
  internal fun triggerGesture(gesture: String, expected: String): Map<String, Any?> {
    val decision = startGesture(gesture, 0, manual = true, expected = expected)
    return mapOf("accepted" to decision.accepted, "message" to decision.message, "status" to GestureControl.status(this))
  }

  private fun startGesture(gesture: String, recorded: Int, manual: Boolean, expected: String? = null): GestureTriggerDecision {
    val decision = GestureTriggerPolicy.admit(config, gesture, GestureTriggerState(
      controlEnabled = store.state.enabled == true, appActive = GestureRuntime.active,
      calibrating = GestureCalibrationSession.active, actionPending = GestureActions.pending != null,
      batchPending = batch != null, listening = listening, backgroundReady = socket.ready), manual, recorded, expected)
    val sequence = decision.sequence ?: return decision
    // Reserve the whole list before publishing events or launching a phone app.
    // Both a second tap and a sensor callback see this lock, including between steps.
    batch = sequence
    lastCount = sequence.count; lastGesture = gesture; lastAction = ""
    Log.i(TAG, "${if (manual) "tapped" else "completed"} $gesture (${sequence.count}), ${sequence.steps.size} actions, background ${!GestureRuntime.active}")
    GestureActions.pauseAfterSequence(actionDebounceMs)
    batchSummary = ""
    stopSensors(); publish(); runNextAction()
    return decision
  }

  private fun scheduleNextAction() {
    if (batch == null || GestureActions.pending != null || nextAction != null) return
    // Let the prior bridge promise close its JS operation before the next event.
    nextAction = Runnable { nextAction = null; runNextAction() }.also { main.postDelayed(it, 100) }
  }

  private fun runNextAction() {
    val sequence = batch ?: return
    if (GestureActions.pending != null) return
    if (sequence.finished) {
      batchSummary = sequence.summary(); batch = null
      if (config?.background != true) demote()
      GestureRuntime.emit("onAppState", GestureRuntime.appStateStatus())
      appStateChanged(); return
    }
    val value = config ?: run { abortBatch("Remaining actions cancelled because controls stopped."); return }
    val step = sequence.current ?: return
    if (GestureCalibrationSession.active) { abortBatch("Remaining actions cancelled for gesture calibration."); return }
    if (step.mobile) {
      val id = UUID.randomUUID().toString()
      sequence.bind(id)
      try {
        val applications = GestureApplications(this)
        if (GestureRuntime.active) {
          // Establish the foreground service while our Activity is still visible,
          // before another phone app can background the remainder of this list.
          if (sequence.index + 1 < sequence.steps.size && !promoted) {
            try { promote() }
            catch (_: RuntimeException) { error("Could not keep the remaining actions active; the phone action was not opened.") }
          }
          if (step.action == "open_url") applications.openUrl(step.url!!) else applications.open(step.appId!!)
          sequence.complete(id, "success")
        } else sequence.complete(id, "needs_tap", if (step.action == "open_url") applications.notifyToOpenUrl(step.url!!) else applications.notifyToOpen(step.appId!!, step.appName))
      } catch (error: Exception) { sequence.complete(id, "failed", error.message ?: "Could not open the phone action.") }
      lastAction = step.action; batchSummary = sequence.summary()
      publish(); scheduleNextAction(); return
    }
    val operation = GestureActions.acquire(this, step.action, sequence.owner, value, actionDebounceMs, sequence.gesture) ?: run {
      abortBatch("Could not reserve the next gesture action."); return
    }
    sequence.bind(operation.id)
    message = "Running action ${sequence.index + 1} of ${sequence.steps.size}"
    // Native ownership must reach JS before its corresponding gesture event.
    publish()
    GestureRuntime.emit("onAppState", GestureRuntime.appStateStatus())
    if (sequence.owner == "foreground") {
      if (GestureRuntime.event == null) {
        abortBatch("Remaining actions cancelled because Remote Mac closed.")
        GestureActions.notSent(operation.id)
      } else GestureRuntime.emit("onGesture", mapOf("gesture" to sequence.gesture, "count" to sequence.count,
        "action" to step.action, "operationId" to operation.id, "batchIndex" to sequence.index,
        "batchTotal" to sequence.steps.size) + step.parameters())
    } else when (socket.sendAction(step.action, operation.id, step.parameters())) {
      GestureActionSendResult.SENT -> lastAction = step.action
      GestureActionSendResult.NOT_SENT -> GestureActions.notSent(operation.id, "Mac action unavailable on the current connection.")
      GestureActionSendResult.UNKNOWN -> GestureActions.unknown(operation.id)
    }
    publish()
  }

  internal fun actionCompleted(id: String, outcome: String, detail: String?) {
    val sequence = batch ?: return
    if (!sequence.complete(id, outcome, detail)) return
    batchSummary = sequence.summary()
    scheduleNextAction()
  }

  internal fun abortBatch(detail: String) {
    val sequence = batch ?: return
    batchSummary = "${sequence.summary()}. $detail"
    batch = null
    nextAction?.let(main::removeCallbacks); nextAction = null
    GestureRuntime.emit("onAppState", GestureRuntime.appStateStatus())
  }

  internal fun batchStatus(): Map<String, Any?> = mapOf("batchPending" to (batch != null), "batchOwner" to batch?.owner,
    "batchIndex" to (batch?.index ?: 0), "batchTotal" to (batch?.steps?.size ?: 0), "batchSummary" to batchSummary)

  internal val activeGestureLabel: String?
    get() = GestureWidgetPresentation.activeLabel(batch, GestureActions.pending)

  internal val activeGesture: String?
    get() = GestureWidgetPresentation.activeGesture(batch, GestureActions.pending)

  private fun updateWakeLock() {
    val operation = GestureActions.pending
    val backgroundListening = config?.let { it.enabled && it.background &&
      (it.hasMobileActions || (it.canConnect && connection in setOf("connecting", "connected"))) } == true &&
      store.state.enabled == true && !GestureCalibrationSession.active
    val needed = GestureExecutionPolicy.needsWakeLock(GestureRuntime.active, batch != null,
      operation?.state, operation?.owner == "background", backgroundListening)
    if (needed && wakeLock?.isHeld != true) {
      wakeLock = (getSystemService(Context.POWER_SERVICE) as PowerManager).newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "$packageName:BackgroundGestures").apply { setReferenceCounted(false); acquire() }
    } else if (!needed) { if (wakeLock?.isHeld == true) wakeLock?.release(); wakeLock = null }
  }
  internal fun status(): Map<String, Any?> = mapOf("enabled" to (config?.enabled == true && store.state.enabled == true), "listening" to listening,
    "background" to (config?.background == true), "appActive" to GestureRuntime.active, "connection" to connection,
    "count" to count, "lastCount" to lastCount, "lastGesture" to lastGesture, "lastAction" to lastAction,
    "message" to if (GestureActions.pending != null) GestureActions.message() else message) + batchStatus()
  private fun publish() {
    GestureControl.publish(this)
    if (promoted) (getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager).notify(NOTIFICATION, notification())
  }
  private fun notification(): Notification {
    val open = packageManager.getLaunchIntentForPackage(packageName)
    val pendingOpen = open?.let { PendingIntent.getActivity(this, 0, it, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT) }
    val stop = PendingIntent.getService(this, 1, Intent(this, MotionGestureService::class.java).setAction(STOP), PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
    val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(this, CHANNEL) else Notification.Builder(this)
    return builder.setSmallIcon(R.drawable.ic_gesture_notification).setContentTitle("Remote Mac gestures")
      .setContentText(if (GestureActions.pending != null) GestureActions.message() else message).setContentIntent(pendingOpen).setOngoing(true).setOnlyAlertOnce(true)
      .addAction(Notification.Action.Builder(null, "Stop gestures", stop).build()).setCategory(Notification.CATEGORY_SERVICE).build()
  }
  private fun promote() {
    if (Build.VERSION.SDK_INT >= 29) startForeground(NOTIFICATION, notification(), ServiceInfo.FOREGROUND_SERVICE_TYPE_CONNECTED_DEVICE)
    else startForeground(NOTIFICATION, notification())
    promoted = true
  }
  private fun demote() { if (promoted) { stopForeground(STOP_FOREGROUND_REMOVE); promoted = false } }
  internal fun actionStateChanged() { appStateChanged() }
  internal val canReconcileBackground: Boolean get() = config?.let { it.background && it.canConnect } == true
  internal fun stopListening(userInitiated: Boolean): Boolean {
    if (userInitiated) store.save(GestureControlPolicy.setEnabled(store.snapshot(), false)!!)
    abortBatch("Remaining actions cancelled because gestures stopped.")
    if (GestureActions.pending?.owner == "background") {
      stopAfterAction = true; stopSensors(); message = GestureActions.message()
      if (!promoted) promote()
      updateWakeLock(); publish(); return true
    }
    config = null; stopSensors(); socket.close(); updateWakeLock(); demote()
    connection = "disconnected"; message = if (userInitiated) "Stopped from notification" else "Gesture listening is off"
    if (instance === this) instance = null
    publish(); stopSelf(); return false
  }
  override fun onDestroy() {
    abortBatch("Remaining actions cancelled because the gesture service stopped.")
    stopSensors(); socket.dispose(); if (wakeLock?.isHeld == true) wakeLock?.release(); wakeLock = null; demote()
    if (instance === this) instance = null
    GestureActions.nativeUnavailable(this)
    GestureControl.publish(this)
    super.onDestroy()
  }
  override fun onBind(intent: Intent?): IBinder? = null
  companion object {
    internal var instance: MotionGestureService? = null
    private const val TAG = "RemoteMacGestures"
    private const val CHANNEL = "remote_mac_background_gestures"
    private const val NOTIFICATION = 7301
    private const val STOP = "com.remotemac.gestures.STOP"
  }
}
