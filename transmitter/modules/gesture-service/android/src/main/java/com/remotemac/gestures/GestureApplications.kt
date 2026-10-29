package com.remotemac.gestures

import android.Manifest
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Rect
import android.graphics.drawable.Drawable
import android.os.Build
import android.net.Uri
import android.util.Base64
import java.io.ByteArrayOutputStream
import java.security.MessageDigest
import java.util.Locale

/** Uses the same MAIN/LAUNCHER discovery as nfcport; package IDs remain executable identity. */
internal class GestureApplications(private val context: Context) {
  fun list(): List<Map<String, Any?>> {
    val manager = context.packageManager
    @Suppress("DEPRECATION")
    val launchers = manager.queryIntentActivities(Intent(Intent.ACTION_MAIN).addCategory(Intent.CATEGORY_LAUNCHER), 0)
    return launchers.filter { result ->
      result.activityInfo?.let { it.exported && it.enabled && it.applicationInfo.enabled && it.packageName != context.packageName } == true
    }.sortedBy { it.activityInfo.name }.distinctBy { it.activityInfo.packageName }.mapNotNull { result ->
      runCatching {
        val id = result.activityInfo.packageName
        mapOf<String, Any?>("id" to id, "name" to result.loadLabel(manager).toString().trim().ifEmpty { id },
          "icon" to runCatching { icon(result.loadIcon(manager)) }.getOrNull())
      }.getOrNull()
    }.sortedWith(compareBy<Map<String, Any?>> { (it["name"] as String).lowercase(Locale.ROOT) }.thenBy { it["id"] as String })
  }

  fun open(appId: String) {
    check(GestureRuntime.active) { "Open Remote Mac to launch a phone app, or tap its gesture notification." }
    context.startActivity(destination(appId))
  }

  fun openUrl(url: String) {
    check(GestureRuntime.active) { "Open Remote Mac to launch a phone URL, or tap its gesture notification." }
    val intent = urlDestination(url)
    try { context.startActivity(intent) }
    catch (_: Exception) { error("Could not open the URL on your phone. Check that a browser is installed.") }
  }

  /** A foreground service does not qualify as a visible activity under Android BAL rules. */
  fun notifyToOpen(appId: String, appName: String?): String {
    val destination = destination(appId)
    val label = appName?.takeIf { it.isNotBlank() } ?: appId
    notifyDestination(destination, "gesture-app:$appId", appId.hashCode(), "Open $label", "Tap to open the phone app requested by your gesture")
    return "Tap the notification to open $label."
  }

  fun notifyToOpenUrl(url: String): String {
    val destination = urlDestination(url)
    // Keep URL paths and query strings out of notification identifiers and status messages.
    val identity = MessageDigest.getInstance("SHA-256").digest(url.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }
    notifyDestination(destination, "gesture-url:$identity", identity.hashCode(), "Open URL on phone", "Tap to open the link requested by your gesture")
    return "Tap the notification to open the URL on your phone."
  }

  private fun notifyDestination(destination: Intent, tag: String, requestCode: Int, title: String, subtitle: String) {
    val notifications = context.getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
    check(Build.VERSION.SDK_INT < 33 || context.checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED) {
      "Allow notifications to open phone apps and URLs from a background gesture."
    }
    check(Build.VERSION.SDK_INT < 24 || notifications.areNotificationsEnabled()) { "Phone action was not opened because notifications are disabled." }
    if (Build.VERSION.SDK_INT >= 26) {
      notifications.createNotificationChannel(NotificationChannel(CHANNEL, "Open phone apps and URLs", NotificationManager.IMPORTANCE_DEFAULT))
      check(notifications.getNotificationChannel(CHANNEL)?.importance != NotificationManager.IMPORTANCE_NONE) { "Enable the Open phone apps and URLs notification channel." }
    }
    try {
      val pending = PendingIntent.getActivity(context, requestCode, destination, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      val builder = if (Build.VERSION.SDK_INT >= 26) Notification.Builder(context, CHANNEL) else Notification.Builder(context)
      notifications.notify(tag, 7302, builder.setSmallIcon(R.drawable.ic_gesture_notification)
        .setContentTitle(title).setContentText(subtitle)
        .setContentIntent(pending).setAutoCancel(true).setCategory(Notification.CATEGORY_REMINDER).build())
    } catch (_: Exception) { error("Could not post the notification for your phone action.") }
  }

  private fun urlDestination(url: String): Intent {
    require(GestureUrls.valid(url)) { "Enter a valid HTTP or HTTPS URL." }
    val destination = Intent(Intent.ACTION_VIEW, Uri.parse(url).normalizeScheme()).addCategory(Intent.CATEGORY_BROWSABLE).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
    check(destination.resolveActivity(context.packageManager) != null) { "No app is available to open URLs on your phone." }
    return destination
  }

  private fun destination(appId: String): Intent {
    require(appId.matches(Regex("[A-Za-z][A-Za-z0-9_]*(\\.[A-Za-z0-9_]+)+")) && appId.length <= 2048) { "Choose an installed phone app." }
    require(appId != context.packageName) { "Choose another phone app." }
    return (context.packageManager.getLaunchIntentForPackage(appId) ?: error("The selected phone app is no longer installed or has no launcher."))
      .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
  }

  private fun icon(drawable: Drawable): String {
    val bitmap = Bitmap.createBitmap(64, 64, Bitmap.Config.ARGB_8888)
    val bounds = Rect(drawable.bounds)
    try {
      drawable.setBounds(0, 0, bitmap.width, bitmap.height); drawable.draw(Canvas(bitmap))
      return ByteArrayOutputStream().use { output ->
        check(bitmap.compress(Bitmap.CompressFormat.PNG, 100, output))
        "data:image/png;base64," + Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
      }
    } finally { drawable.bounds = bounds; bitmap.recycle() }
  }
  private companion object { const val CHANNEL = "remote_mac_open_phone_app" }
}
