package com.remotemac.gestures

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Pairing credentials are encrypted with a non-exportable app-owned Keystore key. */
internal class GestureStore(context: Context) {
  private val preferences = context.getSharedPreferences("remote_mac_gestures", Context.MODE_PRIVATE)
  val state: GestureControlState get() = state(loadLegacy = true)
  private fun state(loadLegacy: Boolean, saved: GestureConfig? = null): GestureControlState {
    if (preferences.contains("control_revision")) return GestureControlState(
      if (preferences.contains("control_enabled")) preferences.getBoolean("control_enabled", false) else null,
      preferences.getLong("control_revision", 0), preferences.getBoolean("control_background", false))
    val legacy = saved ?: if (loadLegacy) load() else null
    return GestureControlState(if (preferences.getBoolean("stopped_by_user", false)) false else legacy?.enabled, 0, legacy?.background == true)
  }
  fun snapshot(): GestureControlSnapshot {
    val saved = load()
    val state = state(loadLegacy = false, saved)
    return GestureControlSnapshot(state, saved?.let { GestureControlPolicy.effective(it, state) })
  }
  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(ALIAS, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }
  fun save(snapshot: GestureControlSnapshot) {
    val edit = preferences.edit().putLong("control_revision", snapshot.state.revision)
      .putBoolean("control_background", snapshot.state.background).remove("stopped_by_user")
    snapshot.state.enabled?.let { edit.putBoolean("control_enabled", it) } ?: edit.remove("control_enabled")
    val config = snapshot.config
    if (config == null) edit.remove("configuration")
    else {
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
      val bytes = cipher.doFinal(config.json.toString().toByteArray(Charsets.UTF_8))
      edit.putString("configuration", Base64.encodeToString(cipher.iv + bytes, Base64.NO_WRAP))
    }
    // One atomic commit keeps the revision and encrypted configuration consistent
    // when a widget starts the process immediately after it was killed.
    check(edit.commit()) { "Could not save background gesture configuration" }
  }
  fun load(): GestureConfig? = try {
    preferences.getString("configuration", null)?.let {
      val bytes = Base64.decode(it, Base64.NO_WRAP)
      val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, bytes.copyOfRange(0, 12))) }
      GestureConfig.parse(String(cipher.doFinal(bytes.copyOfRange(12, bytes.size)), Charsets.UTF_8))
    }
  } catch (_: Exception) { null }
  companion object { private const val ALIAS = "remote-mac-background-gestures-v1" }
}
