package com.remotemac.gestures

import android.app.Activity
import android.app.Application
import android.os.Bundle
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import java.lang.ref.WeakReference

/** Process-level lifecycle survives destruction of the React instance after task dismissal. */
internal object GestureRuntime {
  var active = false
    private set
  var event: ((String, Map<String, Any?>) -> Unit)? = null
  private var application: Application? = null
  private var activity: WeakReference<Activity>? = null
  fun register(app: Application, current: Activity?) {
    if (application == null) {
      application = app; app.registerActivityLifecycleCallbacks(lifecycle)
    }
    if (activity?.get() == null && current != null) {
      activity = WeakReference(current)
      val visible = (current as? LifecycleOwner)?.lifecycle?.currentState?.isAtLeast(Lifecycle.State.STARTED) ?: current.hasWindowFocus()
      if (visible) setActive(true)
    }
  }
  fun emit(name: String, data: Map<String, Any?>) {
    if (name == "onGesture" && GestureCalibrationSession.active) return
    event?.invoke(name, data)
  }
  fun appStateStatus(): Map<String, Any?> {
    val service = MotionGestureService.instance
    val activeGesture = if (service != null) service.activeGesture else GestureWidgetPresentation.activeGesture(null, GestureActions.pending)
    return mapOf("active" to active, "activeGesture" to activeGesture) + GestureActions.status() +
      (service?.batchStatus() ?: mapOf("batchPending" to false, "batchOwner" to null))
  }
  private fun setActive(value: Boolean) {
    active = value
    GestureActions.lifecycleChanged()
    if (!value) GestureCalibrationSession.interrupt()
    // Close the native socket before notifying JS that its transport may reconnect.
    MotionGestureService.instance?.appStateChanged()
    emit("onAppState", appStateStatus())
  }
  private val lifecycle = object : Application.ActivityLifecycleCallbacks {
    override fun onActivityResumed(a: Activity) { activity = WeakReference(a); setActive(true) }
    override fun onActivityStopped(a: Activity) {
      if (a === activity?.get() && !a.isChangingConfigurations) setActive(false)
    }
    override fun onActivityCreated(a: Activity, state: Bundle?) = Unit
    override fun onActivityStarted(a: Activity) = Unit
    override fun onActivityPaused(a: Activity) = Unit
    override fun onActivitySaveInstanceState(a: Activity, state: Bundle) = Unit
    override fun onActivityDestroyed(a: Activity) = Unit
  }
}
