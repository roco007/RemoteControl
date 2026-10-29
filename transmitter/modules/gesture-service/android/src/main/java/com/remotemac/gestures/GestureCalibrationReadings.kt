package com.remotemac.gestures

import org.json.JSONObject
import org.json.JSONArray

internal typealias CalibrationReadings = Map<String, List<List<CalibrationFrame>>>

/** Archived sensor readings are separate from the recognition profile. */
internal object GestureCalibrationReadings {
  const val MAX_FRAMES = 220
  private const val MAX_TAKES = 10
  private const val MAX_EXACT_INTEGER = 9_007_199_254_740_991L

  fun toJson(readings: CalibrationReadings, profile: MotionCalibrationProfile?): JSONObject {
    validate(readings, profile)
    return JSONObject().apply {
      for ((gesture, takes) in readings) put(gesture, JSONArray().apply {
        for (frames in takes) put(JSONArray().apply {
          for (frame in frames) put(JSONArray().put(frame.timestampMs).put(frame.x).put(frame.y).put(frame.z))
        })
      })
    }
  }

  fun parse(json: JSONObject, profile: MotionCalibrationProfile): CalibrationReadings? = try {
    require(json.length() <= GestureCalibrationState.ORDER.size)
    val readings = mutableMapOf<String, List<List<CalibrationFrame>>>()
    for (gesture in json.keys()) {
      require(gesture in GestureCalibrationState.ORDER)
      val model = profile.learnedModels[gesture] ?: error("Readings require a learned model")
      val takes = json.getJSONArray(gesture)
      require(takes.length() in 1..MAX_TAKES && takes.length() == model.templates.size)
      readings[gesture] = List(takes.length()) { take ->
        val frames = takes.getJSONArray(take)
        require(frames.length() in 1..MAX_FRAMES)
        List(frames.length()) { index ->
          val frame = frames.getJSONArray(index)
          require(frame.length() == 4)
          val number = frame.get(0) as? Number ?: error("Invalid sample time")
          val time = number.toDouble()
          require(time.isFinite() && time in 0.0..MAX_EXACT_INTEGER.toDouble() && time == number.toLong().toDouble())
          fun axis(at: Int): Double {
            val value = (frame.get(at) as? Number)?.toDouble() ?: error("Invalid sensor reading")
            require(value.isFinite())
            return value
          }
          CalibrationFrame(axis(1), axis(2), axis(3), number.toLong())
        }
      }
    }
    validate(readings, profile)
    readings.toMap()
  } catch (_: Exception) { null }

  fun merge(previous: SavedGestureCalibration, profile: MotionCalibrationProfile, trials: List<CalibrationTrial>): CalibrationReadings {
    require(trials.size <= GestureCalibrationState.ORDER.size * MAX_TAKES)
    // Only unchanged models can retain old originals. Replacing a model without
    // new captures must not display a previous model's sensor readings as its own.
    val readings = previous.readings.filterKeys { gesture ->
      profile.learnedModels[gesture] != null && profile.learnedModels[gesture] == previous.profile?.learnedModels?.get(gesture)
    }.toMutableMap()
    for ((gesture, takes) in trials.groupBy { it.gesture }) {
      require(gesture in GestureCalibrationState.ORDER && takes.size <= MAX_TAKES)
      readings[gesture] = takes.map { relativeFrames(it.frames) }
    }
    validate(readings, profile)
    return readings.toMap()
  }

  fun read(gesture: String, draftSessionId: String?, state: GestureCalibrationState,
    trials: List<CalibrationTrial>, saved: SavedGestureCalibration): Map<String, Any?> {
    require(gesture in GestureCalibrationState.ORDER) { "Choose a supported motion gesture" }
    val takes = if (draftSessionId != null) {
      check(draftSessionId.isNotEmpty() && state.active && draftSessionId == state.sessionId) {
        "This calibration session is no longer current"
      }
      trials.filter { it.gesture == gesture }.mapIndexed { index, trial ->
        mapOf("take" to index + 1, "raw" to rawView(relativeFrames(trial.frames)),
          "template" to LearnedMotionFeatures.recording(trial.frames, guided = true)?.let { templateView(it, MotionXY.VERSION, 0.22, null, "draft") })
      }
    } else {
      val storedModel = saved.profile?.learnedModels?.get(gesture)
      val model = MotionXY.effectiveProfile(saved)?.learnedModels?.get(gesture)
      model?.templates?.mapIndexed { index, template ->
        mapOf("take" to index + 1, "raw" to saved.readings[gesture]?.getOrNull(index)?.let(::rawView),
          "template" to templateView(template, model.version, model.maxDistance, storedModel?.version,
            MotionXY.effectiveTemplate(storedModel!!.templates[index], storedModel.version, saved.readings[gesture]?.getOrNull(index)).source))
      } ?: emptyList()
    }
    return mapOf("gesture" to gesture, "source" to if (draftSessionId == null) "saved" else "draft",
      "sessionId" to draftSessionId, "profileRevision" to saved.revision,
      "preparationMs" to GestureCalibrationState.HOLD_MS, "recognitionAxes" to listOf("x", "y"), "takes" to takes)
  }

  private fun validate(readings: CalibrationReadings, profile: MotionCalibrationProfile?) {
    require(readings.size <= GestureCalibrationState.ORDER.size)
    for ((gesture, takes) in readings) {
      require(gesture in GestureCalibrationState.ORDER)
      val model = profile?.learnedModels?.get(gesture) ?: error("Readings require a learned model")
      require(takes.size in 1..MAX_TAKES && takes.size == model.templates.size)
      for (frames in takes) {
        validateFrames(frames)
        require(frames.first().timestampMs == 0L)
      }
    }
  }

  private fun validateFrames(frames: List<CalibrationFrame>) {
    require(frames.size in 1..MAX_FRAMES)
    require(frames.all { it.timestampMs in 0..MAX_EXACT_INTEGER && it.x.isFinite() && it.y.isFinite() && it.z.isFinite() })
    require(frames.zipWithNext().all { (a, b) -> b.timestampMs > a.timestampMs })
  }

  private fun relativeFrames(frames: List<CalibrationFrame>): List<CalibrationFrame> {
    validateFrames(frames)
    val start = frames.first().timestampMs
    return frames.map { it.copy(timestampMs = it.timestampMs - start) }
  }

  private fun rawView(frames: List<CalibrationFrame>) = frames.map {
    mapOf("timeMs" to it.timestampMs, "x" to it.x, "y" to it.y, "z" to it.z)
  }

  private fun templateView(template: LearnedMotionTemplate, version: Int, maxDistance: Double, storedVersion: Int?, source: String) = mapOf(
    "points" to template.points.map { mapOf("x" to it.x, "y" to it.y, "z" to it.z) },
    "durationMs" to template.durationMs, "amplitudeG" to template.amplitudeG,
    "modelVersion" to version, "maxDistance" to maxDistance, "storedModelVersion" to storedVersion, "source" to source)
}
