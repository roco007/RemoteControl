package com.remotemac.gestures

import android.content.Context
import android.hardware.Sensor
import android.hardware.SensorEvent
import android.hardware.SensorEventListener
import android.hardware.SensorManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import java.util.UUID

/** Foreground-only training owns its own sensor subscription so no connection,
 * action mapping, or enabled master is required. All mutations use the main thread. */
internal object GestureCalibrationSession : SensorEventListener {
  private val main = Handler(Looper.getMainLooper())
  private val state = GestureCalibrationState()
  private var context: Context? = null
  private var sensors: SensorManager? = null
  private var sensor: Sensor? = null
  private var sequence = 0L
  private var captureClock: GestureCalibrationCaptureClock? = null
  private var captureGeneration = 0L
  private var timer: Runnable? = null
  private val frames = mutableListOf<CalibrationFrame>()
  private val trials = mutableListOf<CalibrationTrial>()
  private var saved = SavedGestureCalibration()
  val active: Boolean get() = state.active

  fun status(context: Context): Map<String, Any?> {
    attach(context)
    return status()
  }

  fun readings(context: Context, gesture: String, draftSessionId: String?): Map<String, Any?> =
    GestureCalibrationReadings.read(gesture, draftSessionId, state, trials.toList(), GestureCalibrationStore(context).load())

  fun start(context: Context, gesture: String? = null): Map<String, Any?> {
    // Reject unsupported input before touching an existing capture or draft.
    GestureCalibrationState.selection(gesture)
    attach(context)
    check(GestureRuntime.active) { "Open Remote Mac to calibrate gestures" }
    check(sensor != null) { "This device does not have a motion sensor" }
    stopCapture()
    trials.clear()
    state.begin(UUID.randomUUID().toString(), gesture)
    // Hold the guard before resetting the service's detector or publishing UI.
    MotionGestureService.instance?.calibrationChanged()
    return publish()
  }

  fun capture(sessionId: String): Map<String, Any?> {
    requireSession(sessionId)
    check(GestureRuntime.active) { "Return to Remote Mac to continue calibration" }
    state.startCapture()
    frames.clear()
    captureClock = GestureCalibrationCaptureClock(SystemClock.elapsedRealtime())
    val generation = ++captureGeneration
    val registered = sensor?.let { sensors?.registerListener(this, it, 40_000, main) } == true
    if (!registered) {
      state.rejectCapture("Could not start the motion sensor. Try recording again.")
      return publish()
    }
    timer = object : Runnable {
      override fun run() {
        if (captureGeneration != generation || !state.active) return
        val clock = captureClock ?: return
        val now = SystemClock.elapsedRealtime()
        if (clock.startupTimedOut(now)) {
          stopCapture()
          state.rejectCapture("The motion sensor did not respond. Try recording again.")
          publish(); return
        }
        val elapsed = clock.elapsedMs(now)
        if (elapsed != null && state.advanceCapture(elapsed)) completeCapture()
        else { publish(); main.postDelayed(this, 200) }
      }
    }.also { main.postDelayed(it, 200) }
    return publish()
  }

  fun save(sessionId: String): Map<String, Any?> {
    requireSession(sessionId)
    check(state.canSave) { "Record ${GestureCalibrationState.REPETITIONS} takes of each selected gesture before saving" }
    check(GestureRuntime.active) { "Return to Remote Mac before saving calibration" }
    val fit = LearnedMotionCalibration.fit(trials.toList(), requireComplete = true,
      selectedGestures = state.selectedGestures, existingProfile = saved.profile)
    val profile = fit.profile
    if (profile == null) { state.message = fit.message; return publish() }
    try {
      saved = GestureCalibrationStore(context ?: error("Android context is unavailable")).save(profile, trials.toList())
    } catch (error: Exception) {
      state.message = error.message ?: "Could not save calibration. Your previous calibration is unchanged."
      return publish()
    }
    stopCapture(); trials.clear()
    state.end("Calibration saved. Your gestures now use the learned movements.")
    MotionGestureService.instance?.calibrationChanged()
    return publish()
  }

  fun cancel(sessionId: String): Map<String, Any?> {
    requireSession(sessionId)
    if (!state.active) return status()
    return cancelCurrent("Calibration canceled. Your previous calibration is unchanged.")
  }

  fun resume(sessionId: String): Map<String, Any?> {
    requireSession(sessionId)
    check(GestureRuntime.active) { "Return to Remote Mac to continue calibration" }
    state.resume()
    stopCapture()
    MotionGestureService.instance?.calibrationChanged()
    return publish()
  }

  fun interrupt() {
    if (!state.active) return
    stopCapture()
    state.interrupt()
    MotionGestureService.instance?.calibrationChanged()
    publish()
  }

  fun moduleDestroyed() {
    if (state.active) cancelCurrent("Calibration ended when Remote Mac closed. Your previous calibration is unchanged.")
  }

  private fun cancelCurrent(message: String): Map<String, Any?> {
    stopCapture(); trials.clear()
    state.end(message)
    MotionGestureService.instance?.calibrationChanged()
    return publish()
  }

  private fun attach(value: Context) {
    if (context == null) {
      context = value.applicationContext
      sensors = value.getSystemService(Context.SENSOR_SERVICE) as? SensorManager
      sensor = sensors?.getDefaultSensor(Sensor.TYPE_ACCELEROMETER)
    }
    saved = GestureCalibrationStore(value).load()
  }

  private fun requireSession(sessionId: String) {
    check(sessionId.isNotEmpty() && sessionId == state.sessionId) { "This calibration session is no longer current" }
  }

  private fun completeCapture() {
    val gesture = state.gesture ?: return
    val captured = frames.toList()
    stopCapture()
    val trial = GestureCalibrationRecording.fromFrames(gesture, captured)
    if (trial == null) state.rejectCapture("No readable sensor samples were received. Try recording again.")
    else { trials.add(trial); state.acceptCapture() }
    publish()
  }

  private fun stopCapture() {
    captureGeneration += 1
    timer?.let(main::removeCallbacks); timer = null
    sensors?.unregisterListener(this)
    captureClock = null
    frames.clear()
  }

  override fun onSensorChanged(event: SensorEvent) {
    if (!state.active || state.phase !in setOf("hold_still", "recording")) return
    val time = event.timestamp / 1_000_000
    if (frames.size >= GestureCalibrationReadings.MAX_FRAMES) return
    val x = event.values[0] / SensorManager.GRAVITY_EARTH.toDouble()
    val y = event.values[1] / SensorManager.GRAVITY_EARTH.toDouble()
    val z = event.values[2] / SensorManager.GRAVITY_EARTH.toDouble()
    if (x.isFinite() && y.isFinite() && z.isFinite() && captureClock?.acceptFrame(time, SystemClock.elapsedRealtime()) == true)
      frames.add(CalibrationFrame(x = x, y = y, z = z, timestampMs = time))
  }

  override fun onAccuracyChanged(sensor: Sensor?, accuracy: Int) = Unit

  private fun status(): Map<String, Any?> = mapOf(
    "sessionId" to state.sessionId, "sequence" to sequence, "active" to state.active, "phase" to state.phase,
    "gesture" to if (state.active) state.gesture else null, "step" to state.step,
    "gestures" to state.selectedGestures, "totalSteps" to state.selectedGestures.size, "repetition" to state.repetition,
    "repetitions" to GestureCalibrationState.REPETITIONS, "accepted" to state.accepted,
    "total" to state.total, "remainingMs" to state.remainingMs, "message" to state.message,
    "canSave" to state.canSave, "calibratedAt" to saved.calibratedAt, "profileRevision" to saved.revision,
    "calibratedGestures" to GestureCalibrationState.ORDER.filter { saved.profile?.calibratedGestures?.contains(it) == true },
    "learnedGestures" to GestureCalibrationState.ORDER.filter { saved.profile?.learnedModels?.containsKey(it) == true },
    "sensorAvailable" to (sensor != null))

  private fun publish(): Map<String, Any?> {
    sequence += 1
    return status().also {
      GestureRuntime.emit("onCalibration", it)
      context?.let { value -> GestureWidgetProvider.refresh(value) }
    }
  }
}
