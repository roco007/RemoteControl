package com.remotemac.gestures

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class LearnedMotionCodecTest {
  private fun templateJson(): JSONObject = JSONObject()
    .put("points", JSONArray(List(32) { index -> JSONArray(listOf(index / 16.0 - 1.0, 0.25, -0.5)) }))
    .put("durationMs", 1200).put("amplitudeG", 1.25).put("kind", "flick").put("polarity", -1).put("cycles", 0)
  private fun modelJson(): JSONObject = JSONObject().put("version", 1).put("maxDistance", 0.25)
    .put("templates", JSONArray(List(10) { templateJson() }))
  private fun json(): JSONObject = JSONObject().put("left", modelJson())
  private fun model(json: JSONObject) = json.getJSONObject("left")
  private fun template(json: JSONObject) = model(json).getJSONArray("templates").getJSONObject(0)
  private fun models(): Map<String, LearnedMotionModel> = MotionCalibration.ALL_GESTURES.withIndex().associate { (index, gesture) ->
    val kind = when { gesture.endsWith("_straight") -> "tilt"; gesture in listOf("single", "double", "triple") -> "count"; else -> "flick" }
    val cycles = when (kind) { "count" -> listOf("single", "double", "triple").indexOf(gesture) + 1; "tilt" -> 1; else -> 0 }
    gesture to LearnedMotionModel(templates = List(10) { take -> LearnedMotionTemplate(
      points = List(32) { point -> CalibrationVector((point - 16) / 16.0, take / 10.0, -index / 10.0) },
      durationMs = 800L + index * 80 + take * 40, amplitudeG = 0.6 + take * 0.1, kind = kind,
      polarity = if (kind == "count") 0 else if (gesture.startsWith("left")) -1 else 1, cycles = cycles) }, maxDistance = 0.20 + index * 0.02)
  }
  private fun motionModels(): Map<String, LearnedMotionModel> = models().mapValues { (_, model) ->
    model.copy(version = 2, templates = model.templates.mapIndexed { index, template ->
      template.copy(kind = "motion", polarity = 0, cycles = 0,
        amplitudeG = if (index == 0) 0.0 else template.amplitudeG,
        points = if (index == 0) List(32) { CalibrationVector(0.0, 0.0, 0.0) } else template.points)
    })
  }

  @Test fun allSevenModelsRoundTripEverySignedPointAndMetadataField() {
    val original = models()
    val persisted = LearnedMotionCodec.toJson(original).toString()
    assertEquals(original, LearnedMotionCodec.parse(JSONObject(persisted)))
    assertTrue("Full learned profile stays well under the envelope cap", persisted.toByteArray(Charsets.UTF_8).size < 256 * 1024)
  }

  @Test fun allSeventyVersionTwoTakesRoundTripIncludingStillExamples() {
    val original = motionModels()
    val persisted = LearnedMotionCodec.toJson(original).toString()
    val decoded = LearnedMotionCodec.parse(JSONObject(persisted))!!
    assertEquals(original, decoded)
    assertEquals(70, decoded.values.sumOf { it.templates.size })
    assertEquals(7, decoded.values.count { it.templates.first().amplitudeG == 0.0 })
    assertTrue(persisted.toByteArray(Charsets.UTF_8).size < 256 * 1024)
  }

  @Test fun fiveExampleVersionTwoModelsRoundTripBesideSavedTenExampleModels() {
    val old = motionModels()
    val mixed = old + ("left" to old.getValue("left").copy(templates = old.getValue("left").templates.take(5)))
    val decoded = LearnedMotionCodec.parse(JSONObject(LearnedMotionCodec.toJson(mixed).toString()))!!
    assertEquals(mixed, decoded)
    assertEquals(5, decoded.getValue("left").templates.size)
    assertEquals(old.getValue("right"), decoded.getValue("right"))
    assertEquals(10, decoded.getValue("right").templates.size)
  }

  @Test fun onlyFiveOrTenGenericExamplesAreValidAndLegacyStillRequiresTen() {
    val original = motionModels().getValue("left")
    for (count in (0..12).toList() + 100) {
      val candidate = original.copy(templates = List(count) { original.templates.first() })
      val raw = LearnedMotionCodec.toJson(mapOf("left" to original))
      val firstTemplate = template(raw)
      model(raw).put("templates", JSONArray(List(count) { firstTemplate }))
      if (count in setOf(5, 10)) {
        assertEquals(mapOf("left" to candidate), LearnedMotionCodec.parse(LearnedMotionCodec.toJson(mapOf("left" to candidate))))
        assertNotNull(LearnedMotionCodec.parse(raw))
      } else {
        assertNull("v2 count=$count", LearnedMotionCodec.parse(raw))
        assertThrows(IllegalArgumentException::class.java) { LearnedMotionCodec.toJson(mapOf("left" to candidate)) }
      }
    }
    val legacy = models().getValue("left")
    assertThrows(IllegalArgumentException::class.java) {
      LearnedMotionCodec.toJson(mapOf("left" to legacy.copy(templates = legacy.templates.take(5))))
    }
    val rawLegacy = json(); model(rawLegacy).put("templates", JSONArray(List(5) { templateJson() }))
    assertNull(LearnedMotionCodec.parse(rawLegacy))
  }

  @Test fun mixedVersionProfilesPreserveUnrelatedModelsAndLegacySettings() {
    val legacy = models()
    val mixed = legacy + ("left" to motionModels().getValue("left"))
    val original = MotionCalibrationProfile(leftThresholdG = 0.85, rightThresholdG = 1.6,
      calibratedGestures = MotionCalibration.ALL_GESTURES.toSet(), learnedModels = mixed)
    val reloaded = MotionCalibrationProfile.parse(JSONObject(original.toJson().toString()))!!
    assertEquals(original, reloaded)
    assertEquals(2, reloaded.learnedModels.getValue("left").version)
    assertEquals(legacy.getValue("right"), reloaded.learnedModels.getValue("right"))
  }

  @Test fun versionTwoGenericFormatKeepsBoundsWithoutLegacyGestureMetadata() {
    val original = motionModels().getValue("left")
    for (amplitude in listOf(0.0, 0.001, 12.0)) {
      val model = original.copy(templates = original.templates.map { it.copy(amplitudeG = amplitude) })
      assertEquals(mapOf("left" to model), LearnedMotionCodec.parse(LearnedMotionCodec.toJson(mapOf("left" to model))))
    }
    val first = original.templates.first()
    val malformed = listOf(first.copy(kind = "flick"), first.copy(polarity = -1), first.copy(cycles = 1),
      first.copy(amplitudeG = -0.001), first.copy(amplitudeG = 12.001), first.copy(amplitudeG = Double.NaN))
    for (template in malformed) {
      val model = original.copy(templates = listOf(template) + original.templates.drop(1))
      assertThrows(IllegalArgumentException::class.java) { LearnedMotionCodec.toJson(mapOf("left" to model)) }
    }
    val legacy = models().getValue("left")
    assertThrows(IllegalArgumentException::class.java) {
      LearnedMotionCodec.toJson(mapOf("left" to legacy.copy(templates = legacy.templates.map { it.copy(amplitudeG = 0.0) })))
    }
  }

  @Test fun readsIndependentJsonAndAllowsNoLearnedModels() {
    val decoded = LearnedMotionCodec.parse(json())!!
    assertEquals(setOf("left"), decoded.keys)
    val first = decoded.getValue("left").templates.first()
    assertEquals(CalibrationVector(-1.0, 0.25, -0.5), first.points.first())
    assertEquals(CalibrationVector(0.9375, 0.25, -0.5), first.points.last())
    assertEquals(1200L, first.durationMs)
    assertEquals(1.25, first.amplitudeG, 0.0)
    assertEquals(-1, first.polarity)
    assertEquals(emptyMap<String, LearnedMotionModel>(), LearnedMotionCodec.parse(JSONObject()))
    assertEquals(0, LearnedMotionCodec.toJson(emptyMap()).length())
  }

  @Test fun rejectsUnknownGestureKeysAndWrongObjectShapes() {
    for (unknown in listOf("left_right", "right_left", "unknown")) assertNull(LearnedMotionCodec.parse(JSONObject().put(unknown, modelJson())))
    assertNull(LearnedMotionCodec.parse(JSONObject().put("left", JSONArray())))
    assertNull(LearnedMotionCodec.parse(JSONObject().put("left", JSONObject.NULL)))
    val tooMany = LearnedMotionCodec.toJson(models()).put("eighth", modelJson())
    assertNull(LearnedMotionCodec.parse(tooMany))
  }

  @Test fun rejectsWrongTemplateAndPointCountsWithoutTruncatingThem() {
    for (count in listOf(0, 9, 11, 100)) {
      val raw = json(); model(raw).put("templates", JSONArray(List(count) { templateJson() }))
      assertNull("templates=$count", LearnedMotionCodec.parse(raw))
    }
    for (count in listOf(0, 31, 33, 1000)) {
      val raw = json(); template(raw).put("points", JSONArray(List(count) { JSONArray(listOf(0, 0, 0)) }))
      assertNull("points=$count", LearnedMotionCodec.parse(raw))
    }
    for (point in listOf(JSONArray(listOf(0, 0)), JSONArray(listOf(0, 0, 0, 0)), JSONObject(), "0,0,0")) {
      val raw = json(); template(raw).getJSONArray("points").put(0, point)
      assertNull(LearnedMotionCodec.parse(raw))
    }
  }

  @Test fun rejectsMalformedNumericValuesInsteadOfCoercingOrClampingThem() {
    val invalidModelValues = mapOf("version" to listOf<Any>(0, 3, 1.5, "1"), "maxDistance" to listOf<Any>(0.079, 0.451, "0.25", JSONObject.NULL))
    for ((key, values) in invalidModelValues) for (value in values) {
      val raw = json(); model(raw).put(key, value)
      assertNull("$key=$value", LearnedMotionCodec.parse(raw))
    }
    val invalidTemplateValues = mapOf("durationMs" to listOf<Any>(79, 6501, 1200.5, "1200"), "amplitudeG" to listOf<Any>(0.149, 12.001, "1.25"),
      "polarity" to listOf<Any>(-2, 2, 0.5, "1"), "cycles" to listOf<Any>(-1, 4, 0.5, "0"))
    for ((key, values) in invalidTemplateValues) for (value in values) {
      val raw = json(); template(raw).put(key, value)
      assertNull("$key=$value", LearnedMotionCodec.parse(raw))
    }
    for (axis in 0..2) for (value in listOf(-4.001, 4.001, "0.2", JSONObject.NULL)) {
      val raw = json(); template(raw).getJSONArray("points").getJSONArray(0).put(axis, value)
      assertNull("axis=$axis value=$value", LearnedMotionCodec.parse(raw))
    }
  }

  @Test fun validatesKindSpecificCycleAndPolarityBounds() {
    for ((kind, polarity, cycles) in listOf(Triple("unknown", 1, 0), Triple("count", 1, 1), Triple("count", 0, 0),
      Triple("tilt", -1, 0), Triple("flick", -1, 1), Triple("tilt", 0, 1), Triple("flick", 0, 0))) {
      val raw = json(); template(raw).put("kind", kind).put("polarity", polarity).put("cycles", cycles)
      assertNull("$kind/$polarity/$cycles", LearnedMotionCodec.parse(raw))
    }
    for ((kind, polarity, cycles) in listOf(Triple("count", 0, 1), Triple("count", 0, 3), Triple("tilt", -1, 1), Triple("tilt", 1, 3), Triple("flick", -1, 0), Triple("flick", 1, 0))) {
      val raw = json(); template(raw).put("kind", kind).put("polarity", polarity).put("cycles", cycles)
      assertNotNull("$kind/$polarity/$cycles", LearnedMotionCodec.parse(raw))
    }
  }

  @Test fun acceptsNumericBoundaryValuesWithoutLosingPrecision() {
    for ((duration, amplitude, distance, coordinate) in listOf(listOf(80.0, 0.15, 0.08, -4.0), listOf(6500.0, 12.0, 0.45, 4.0))) {
      val raw = json(); model(raw).put("maxDistance", distance)
      template(raw).put("durationMs", duration).put("amplitudeG", amplitude).getJSONArray("points").getJSONArray(0).put(0, coordinate)
      val decoded = LearnedMotionCodec.parse(raw)!!
      assertEquals(duration.toLong(), decoded.getValue("left").templates.first().durationMs)
      assertEquals(coordinate, decoded.getValue("left").templates.first().points.first().x, 0.0)
    }
  }

  @Test fun invalidInMemoryModelsCannotBeSerialized() {
    val original = models().getValue("left")
    val first = original.templates.first()
    val invalid = listOf(original.copy(maxDistance = Double.NaN), original.copy(maxDistance = Double.POSITIVE_INFINITY),
      original.copy(templates = original.templates.dropLast(1)), original.copy(templates = listOf(first.copy(points = first.points.dropLast(1))) + original.templates.drop(1)),
      original.copy(templates = listOf(first.copy(amplitudeG = Double.NEGATIVE_INFINITY)) + original.templates.drop(1)),
      original.copy(templates = listOf(first.copy(points = listOf(CalibrationVector(Double.NaN, 0.0, 0.0)) + first.points.drop(1))) + original.templates.drop(1)))
    for (bad in invalid) assertThrows(IllegalArgumentException::class.java) { LearnedMotionCodec.toJson(mapOf("left" to bad)) }
    assertThrows(IllegalArgumentException::class.java) { LearnedMotionCodec.toJson(mapOf("left_right" to original)) }
  }

  @Test fun profilePreservesAllModelsAcrossCopyAndLegacyMissingFieldLoadsEmpty() {
    val original = MotionCalibrationProfile(leftThresholdG = 0.85, calibratedGestures = setOf("left", "double"), learnedModels = models())
    assertEquals(original, MotionCalibrationProfile.parse(JSONObject(original.toJson().toString())))
    assertEquals(original.learnedModels, original.copy(rightThresholdG = 1.6).learnedModels)
    val legacy = original.toJson().apply { remove("learnedModels") }
    assertEquals(original.copy(learnedModels = emptyMap()), MotionCalibrationProfile.parse(legacy))
  }

  @Test fun presentMalformedLearnedModelsInvalidatesProfileInsteadOfSilentlyDroppingLearning() {
    for (invalid in listOf(JSONArray(), JSONObject.NULL, "bad", JSONObject().put("unknown", modelJson()))) {
      val raw = MotionCalibrationProfile().toJson().put("learnedModels", invalid)
      assertNull(MotionCalibrationProfile.parse(raw))
    }
  }
}
