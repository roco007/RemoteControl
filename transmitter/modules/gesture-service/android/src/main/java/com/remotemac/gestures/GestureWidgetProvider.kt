package com.remotemac.gestures

import android.app.PendingIntent
import android.appwidget.AppWidgetManager
import android.appwidget.AppWidgetProvider
import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.view.View
import android.widget.RemoteViews
import android.widget.Toast

/** The launcher's immutable PendingIntent is the only external toggle entry point. */
class GestureWidgetProvider : AppWidgetProvider() {
  override fun onUpdate(context: Context, manager: AppWidgetManager, ids: IntArray) = update(context, manager, ids)
  override fun onAppWidgetOptionsChanged(context: Context, manager: AppWidgetManager, id: Int, options: Bundle) = update(context, manager, intArrayOf(id))
  override fun onRestored(context: Context, oldIds: IntArray, newIds: IntArray) = refresh(context)

  override fun onReceive(context: Context, intent: Intent) {
    when (intent.action) {
      TOGGLE -> {
        val manager = AppWidgetManager.getInstance(context)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        if (id !in manager.getAppWidgetIds(component(context))) return
        val enabled = GestureStore(context).state.enabled != true
        try {
          // A real widget tap is Android's foreground-service background-start
          // exemption. No Activity or React runtime is needed for a saved profile.
          if (GestureControl.setEnabled(context, enabled, fromWidget = true) == null) {
            Toast.makeText(context, R.string.gesture_widget_setup, Toast.LENGTH_SHORT).show()
            openApp(context)?.send()
          }
        } catch (_: Exception) {
          Toast.makeText(context, R.string.gesture_widget_start_failed, Toast.LENGTH_LONG).show()
        }
        refresh(context)
      }
      Intent.ACTION_MY_PACKAGE_REPLACED -> refresh(context)
      else -> super.onReceive(context, intent)
    }
  }

  companion object {
    private const val TOGGLE = "com.remotemac.gestures.WIDGET_TOGGLE"
    private const val FLAGS = PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
    private fun component(context: Context) = ComponentName(context, GestureWidgetProvider::class.java)

    fun requestPin(context: Context): Boolean {
      if (Build.VERSION.SDK_INT < 26) return false
      val manager = AppWidgetManager.getInstance(context)
      return manager.isRequestPinAppWidgetSupported && manager.requestPinAppWidget(component(context), null, null)
    }

    internal fun refresh(context: Context) {
      val manager = AppWidgetManager.getInstance(context)
      val ids = manager.getAppWidgetIds(component(context))
      if (ids.isNotEmpty()) update(context, manager, ids)
    }

    private fun openApp(context: Context): PendingIntent? = context.packageManager.getLaunchIntentForPackage(context.packageName)?.let {
      PendingIntent.getActivity(context, 7302, it.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TOP), FLAGS)
    }

    private fun update(context: Context, manager: AppWidgetManager, ids: IntArray) {
      GestureActions.attach(context)
      val snapshot = GestureStore(context).snapshot()
      val enabled = snapshot.state.enabled == true
      val needsSetup = snapshot.config?.let { it.canConnect || it.hasMobileActions } != true
      val service = MotionGestureService.instance
      val runtime = service?.status()
      val activeLabel = if (service != null) service.activeGestureLabel
        else GestureWidgetPresentation.activeLabel(null, GestureActions.pending)
      val detail = context.getString(when {
        GestureActions.pending?.state == "unknown" -> R.string.gesture_widget_action_unknown
        GestureActions.pending != null || runtime?.get("batchPending") == true -> R.string.gesture_widget_action_pending
        GestureCalibrationSession.active -> R.string.gesture_widget_calibrating
        needsSetup -> R.string.gesture_widget_setup_short
        !enabled -> R.string.gesture_widget_tap_on
        runtime?.get("listening") == true -> R.string.gesture_widget_listening
        runtime?.get("connection") == "connecting" -> R.string.gesture_widget_connecting
        runtime?.get("connection") == "error" -> R.string.gesture_widget_reconnect
        else -> R.string.gesture_widget_not_listening
      })
      for (id in ids) {
        val views = RemoteViews(context.packageName, R.layout.gesture_widget)
        views.setViewVisibility(R.id.gesture_widget_normal, if (activeLabel == null) View.VISIBLE else View.GONE)
        views.setViewVisibility(R.id.gesture_widget_active, if (activeLabel == null) View.GONE else View.VISIBLE)
        views.setTextViewText(R.id.gesture_widget_active, activeLabel ?: "")
        views.setTextViewText(R.id.gesture_widget_state, context.getString(if (enabled) R.string.gesture_widget_on else R.string.gesture_widget_off))
        views.setTextColor(R.id.gesture_widget_state, Color.parseColor(if (enabled) "#C4F58A" else "#B5C7BE"))
        views.setTextViewText(R.id.gesture_widget_detail, detail)
        views.setInt(R.id.gesture_widget_root, "setBackgroundResource", if (enabled) R.drawable.gesture_widget_background_on else R.drawable.gesture_widget_background)
        views.setImageViewResource(R.id.gesture_widget_icon, if (enabled) R.drawable.ic_gesture_widget_on else R.drawable.ic_gesture_widget_off)
        val click = if (needsSetup && !enabled) openApp(context) else PendingIntent.getBroadcast(context, id,
          Intent(context, GestureWidgetProvider::class.java).setAction(TOGGLE)
            .setData(Uri.parse("remotemac-gestures://widget/$id"))
            .putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id), FLAGS)
        if (click != null) views.setOnClickPendingIntent(R.id.gesture_widget_root, click)
        views.setContentDescription(R.id.gesture_widget_root,
          if (activeLabel != null) context.getString(R.string.gesture_widget_accessibility_active, activeLabel)
          else context.getString(if (enabled) R.string.gesture_widget_accessibility_on else R.string.gesture_widget_accessibility_off, detail))
        manager.updateAppWidget(id, views)
      }
    }
  }
}
