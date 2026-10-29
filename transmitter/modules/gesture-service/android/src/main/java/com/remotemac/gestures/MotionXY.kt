package com.remotemac.gestures

internal object MotionXY {
  const val VERSION = 3
  const val KIND = "motion_xy"
  data class EffectiveTemplate(val template: LearnedMotionTemplate, val source: String)

  fun frame(value: CalibrationFrame): CalibrationFrame = if (value.z == 0.0) value else value.copy(z = 0.0)

  /** Older normalized points are the only available evidence when originals were
   * not retained. Restore their XY scale without inventing or dropping examples. */
  fun template(value: LearnedMotionTemplate): LearnedMotionTemplate {
    if (value.kind == KIND) return value.copy(points = value.points.map { it.copy(z = 0.0) })
    val peak = value.points.maxOfOrNull { kotlin.math.sqrt(it.x * it.x + it.y * it.y) } ?: 0.0
    val scale = if (kotlin.math.abs(peak - 1.0) < 1e-12) 1.0 else peak
    val points = value.points.map {
      if (scale <= 0.0) CalibrationVector(0.0, 0.0, 0.0) else CalibrationVector(it.x / scale, it.y / scale, 0.0)
    }
    return value.copy(points = points, amplitudeG = (value.amplitudeG * scale).coerceIn(0.0, 12.0),
      kind = if (value.kind == "motion") KIND else value.kind)
  }

  fun effectiveTemplate(value: LearnedMotionTemplate, version: Int, raw: List<CalibrationFrame>?): EffectiveTemplate {
    if (version == VERSION) return EffectiveTemplate(template(value), "stored")
    if (raw != null) {
      val rebuilt = if (version >= 2) LearnedMotionFeatures.recording(raw)
        else LearnedMotionFeatures.extract(raw.dropWhile { it.timestampMs - raw.first().timestampMs < 800 }, value.kind)
      if (rebuilt != null) return EffectiveTemplate(template(rebuilt), "raw_rebuilt")
    }
    return EffectiveTemplate(template(value), "projected")
  }

  /** Recognition and inspection share this view. Never use it as the old profile
   * when saving a selected label: the stored models and XYZ originals stay intact. */
  fun effectiveProfile(saved: SavedGestureCalibration): MotionCalibrationProfile? = saved.profile?.let { profile ->
    profile.copy(learnedModels = profile.learnedModels.mapValues { (gesture, model) ->
      model.copy(version = if (model.version >= 2) VERSION else 1,
        templates = model.templates.mapIndexed { index, value ->
          effectiveTemplate(value, model.version, saved.readings[gesture]?.getOrNull(index)).template
        })
    })
  }
}
