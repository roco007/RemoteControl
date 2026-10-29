package com.remotemac.gestures

import android.content.Context
import org.json.JSONObject

internal data class SavedGestureCalibration(
  val profile: MotionCalibrationProfile? = null,
  val calibratedAt: Long? = null,
  val revision: Long = 0,
  val readings: CalibrationReadings = emptyMap(),
) {
  fun toJson(): JSONObject = JSONObject().put("version", 1).put("revision", revision)
    .put("calibratedAt", calibratedAt).put("profile", profile?.toJson())
    .put("readings", GestureCalibrationReadings.toJson(readings, profile))

  companion object {
    // Up to 7 × 10 × 220 original samples plus 7 × 10 × 32 template points.
    // Compact arrays retain full Double precision, including extreme finite data.
    const val MAX_RECORD_BYTES = 2 * 1024 * 1024
    fun fitsStorageLimit(raw: String): Boolean = raw.length <= MAX_RECORD_BYTES &&
      raw.toByteArray(Charsets.UTF_8).size <= MAX_RECORD_BYTES

    fun parse(raw: String?): SavedGestureCalibration {
      if (raw == null || !fitsStorageLimit(raw)) return SavedGestureCalibration()
      return try {
        val json = JSONObject(raw)
        val revision = safeInteger(json.opt("revision")) ?: return SavedGestureCalibration()
        if (json.opt("version") != 1) return SavedGestureCalibration(revision = revision)
        val profile = json.optJSONObject("profile")?.let(MotionCalibrationProfile::parse)
          ?: return SavedGestureCalibration(revision = revision)
        val readings = if (!json.has("readings")) emptyMap() else
          json.optJSONObject("readings")?.let { GestureCalibrationReadings.parse(it, profile) }
            ?: return SavedGestureCalibration(revision = revision)
        val at = safeInteger(json.opt("calibratedAt"))
        if (at == null || at == 0L) SavedGestureCalibration(revision = revision)
        else SavedGestureCalibration(profile, at, revision, readings)
      } catch (_: Exception) { SavedGestureCalibration() }
    }
    private fun safeInteger(value: Any?): Long? {
      if (value !is Number) return null
      val number = value.toDouble()
      return if (number.isFinite() && number in 0.0..9_007_199_254_740_991.0 && number == value.toLong().toDouble()) value.toLong() else null
    }
  }
}

internal interface GestureCalibrationPersistence {
  fun read(): String?
  fun write(raw: String?): Boolean
}

/** Separate from pairing storage: disconnecting a Mac never erases calibration. */
internal class GestureCalibrationStore(private val persistence: GestureCalibrationPersistence) {
  constructor(context: Context) : this(object : GestureCalibrationPersistence {
    private val preferences = context.getSharedPreferences("remote_mac_gesture_calibration", Context.MODE_PRIVATE)
    override fun read(): String? = preferences.getString("profile", null)
    override fun write(raw: String?): Boolean {
      val edit = preferences.edit()
      if (raw == null) edit.remove("profile") else edit.putString("profile", raw)
      return edit.commit()
    }
  })
  fun load(): SavedGestureCalibration = SavedGestureCalibration.parse(persistence.read())
  fun save(profile: MotionCalibrationProfile, trials: List<CalibrationTrial> = emptyList()): SavedGestureCalibration {
    val previous = persistence.read()
    val previousRecord = SavedGestureCalibration.parse(previous)
    val readings = GestureCalibrationReadings.merge(previousRecord, profile, trials)
    val record = SavedGestureCalibration(profile, System.currentTimeMillis(), previousRecord.revision + 1, readings)
    val raw = try { record.toJson().toString() } catch (_: Exception) {
      error("Could not save calibration. Your previous calibration is unchanged. Try again.")
    }
    check(SavedGestureCalibration.fitsStorageLimit(raw)) {
      "This calibration is too large to save. Your previous calibration is unchanged."
    }
    // A successful Save must also survive a new process loading it. Validate
    // public model constructors and bounded JSON before touching prior storage.
    val verified = SavedGestureCalibration.parse(raw)
    check(verified.profile != null && verified.revision == record.revision) {
      "Could not save calibration. Your previous calibration is unchanged. Try again."
    }
    val committed = try { persistence.write(raw) } catch (_: Exception) { false }
    if (!committed) {
      // SharedPreferences updates memory before its disk write finishes. Restore
      // the previous value too, so failed Save followed by Cancel cannot apply it.
      runCatching { persistence.write(previous) }
      error("Could not save calibration. Your previous calibration is unchanged. Try again.")
    }
    return verified
  }
}
