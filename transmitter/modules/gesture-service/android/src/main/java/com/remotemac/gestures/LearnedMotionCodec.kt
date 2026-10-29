package com.remotemac.gestures

import org.json.JSONArray
import org.json.JSONObject

/** Bounded learned templates. Original XYZ captures live in the separate readings archive. */
object LearnedMotionCodec {
  private const val LEGACY_TEMPLATE_COUNT = 10
  private const val POINT_COUNT = 32
  private val modelFields = setOf("version", "templates", "maxDistance")
  private val templateFields = setOf("points", "durationMs", "amplitudeG", "kind", "polarity", "cycles")

  fun toJson(models: Map<String, LearnedMotionModel>): JSONObject {
    validate(models)
    val result = JSONObject()
    for ((gesture, model) in models) {
      val templates = JSONArray()
      for (template in model.templates) {
        val points = JSONArray()
        for (point in template.points) points.put(JSONArray(listOf(point.x, point.y, point.z)))
        templates.put(JSONObject().put("points", points).put("durationMs", template.durationMs)
          .put("amplitudeG", template.amplitudeG).put("kind", template.kind)
          .put("polarity", template.polarity).put("cycles", template.cycles))
      }
      result.put(gesture, JSONObject().put("version", model.version).put("templates", templates).put("maxDistance", model.maxDistance))
    }
    return result
  }

  fun parse(json: JSONObject): Map<String, LearnedMotionModel>? = try {
    require(json.length() <= MotionCalibration.ALL_GESTURES.size)
    val result = linkedMapOf<String, LearnedMotionModel>()
    for (gesture in json.keys()) {
      require(gesture in MotionCalibration.ALL_GESTURES)
      val model = json.getJSONObject(gesture)
      requireFields(model, modelFields)
      val version = integer(model.get("version"), 1..3)
      val distance = number(model.get("maxDistance"))
      require(distance in 0.08..0.45)
      val templates = model.getJSONArray("templates")
      require(validTemplateCount(version, templates.length()))
      val decoded = List(templates.length()) { index ->
        val template = templates.getJSONObject(index)
        requireFields(template, templateFields)
        val points = template.getJSONArray("points")
        require(points.length() == POINT_COUNT)
        LearnedMotionTemplate(points = List(POINT_COUNT) { position ->
          val point = points.getJSONArray(position)
          require(point.length() == 3)
          CalibrationVector(coordinate(point.get(0)), coordinate(point.get(1)), coordinate(point.get(2)))
        }, durationMs = integer(template.get("durationMs"), 80..6500).toLong(),
          amplitudeG = number(template.get("amplitudeG")), kind = template.get("kind") as? String ?: error("Invalid template kind"),
          polarity = integer(template.get("polarity"), -1..1), cycles = integer(template.get("cycles"), 0..3))
      }
      result[gesture] = LearnedMotionModel(version, decoded, distance)
    }
    validate(result)
    result
  } catch (_: Exception) { null }

  private fun validate(models: Map<String, LearnedMotionModel>) {
    require(models.size <= MotionCalibration.ALL_GESTURES.size && models.keys.all { it in MotionCalibration.ALL_GESTURES })
    for (model in models.values) {
      require(model.version in 1..3 && model.maxDistance.isFinite() && model.maxDistance in 0.08..0.45)
      require(validTemplateCount(model.version, model.templates.size))
      for (template in model.templates) {
        require(template.points.size == POINT_COUNT && template.durationMs in 80L..6500L)
        require(template.amplitudeG.isFinite())
        if (model.version >= 2) {
          // Generic recorded examples have no gesture-shape metadata. A still
          // take is valid stored data even though runtime idle cannot act on it.
          require(template.amplitudeG in 0.0..12.0)
          require(template.kind == (if (model.version == MotionXY.VERSION) MotionXY.KIND else "motion") && template.polarity == 0 && template.cycles == 0)
          if (model.version == MotionXY.VERSION) require(template.points.all { it.z == 0.0 })
        } else {
          require(template.amplitudeG in 0.15..12.0)
          require(template.polarity in -1..1)
          when (template.kind) {
            "flick" -> require(template.cycles == 0 && template.polarity != 0)
            "tilt" -> require(template.cycles in 1..3 && template.polarity != 0)
            "count" -> require(template.cycles in 1..3 && template.polarity == 0)
            else -> throw IllegalArgumentException("Invalid template kind")
          }
        }
        require(template.points.all { point -> listOf(point.x, point.y, point.z).all { it.isFinite() && it in -4.0..4.0 } })
      }
    }
  }

  // Saved ten-example profiles are never truncated. New generic profiles contain
  // five examples; intermediate or oversized counts still indicate corruption.
  private fun validTemplateCount(version: Int, count: Int): Boolean =
    count == LEGACY_TEMPLATE_COUNT || (version >= 2 && count == LearnedMotionCalibration.TAKES_PER_GESTURE)

  private fun requireFields(json: JSONObject, fields: Set<String>) {
    require(json.length() == fields.size && json.keys().asSequence().all { it in fields })
  }
  private fun number(value: Any): Double {
    val result = (value as? Number)?.toDouble() ?: error("Invalid number")
    require(result.isFinite())
    return result
  }
  private fun integer(value: Any, range: IntRange): Int {
    val result = number(value)
    require(result >= range.first && result <= range.last && result == result.toInt().toDouble())
    return result.toInt()
  }
  private fun coordinate(value: Any): Double = number(value).also { require(it in -4.0..4.0) }
}
