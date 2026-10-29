package com.remotemac.gestures

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test
import kotlin.math.cos
import kotlin.math.sin

class MotionXYTest {
  private fun take(gesture: String = "right", axis: Int = 0): CalibrationTrial = CalibrationTrial(gesture,
    (0L..7720L step 40).map { time ->
      val n = when (time) { in 1400..1520 -> 2.4; in 1600..1720 -> -1.8; else -> 0.0 }
      CalibrationFrame(if (axis == 0) n else 0.0, 1.0 + if (axis == 1) n else 0.0, 0.0, time)
    })
  private fun depth(trial: CalibrationTrial, variant: Int) = trial.copy(frames = trial.frames.mapIndexed { index, frame ->
    frame.copy(z = when (variant) { 0 -> 0.0; 1 -> 80.0; 2 -> sin(index * 1.7) * 1000; else -> if (index % 2 == 0) Double.MAX_VALUE else Double.NaN })
  })
  private fun fit(trial: CalibrationTrial): MotionCalibrationProfile = LearnedMotionCalibration.fit(List(5) { trial },
    selectedGestures = listOf(trial.gesture)).let { assertNotNull(it.message, it.profile); it.profile!! }
  private fun replay(trial: CalibrationTrial, profile: MotionCalibrationProfile? = null): List<Pair<String, Long>> {
    val events = mutableListOf<Pair<String, Long>>(); var now = 0L
    val detector = MotionGestureDetector(if (trial.gesture in setOf("single", "double", "triple")) "count" else "directional",
      { _, _ -> }, { gesture, _ -> events.add(gesture to now) }, profile)
    for (f in trial.frames) { now = f.timestampMs; detector.addSample(f.x, f.y, f.z, now); detector.tick(now) }
    return events
  }
  private fun oldModel(takes: Int = 5): LearnedMotionModel = LearnedMotionModel(2, List(takes) {
    LearnedMotionTemplate(List(32) { i -> CalibrationVector(if (i == 15) .6 else 0.0, 0.0, if (i % 2 == 0) .8 else -.8) },
      1500, 2.0, "motion", 0, 0)
  }, .22)
  private fun archived(vararg gestures: String): SavedGestureCalibration = SavedGestureCalibration(
    MotionCalibrationProfile(calibratedAt = 1, learnedModels = gestures.associateWith { oldModel() }), 1, 4,
    gestures.associateWith { gesture -> List(5) { depth(take(gesture), 2).frames } })

  @Test fun recordingAndTimingMetadataDependOnXYOnly() {
    val trial = take()
    val expected = LearnedMotionFeatures.recording(trial.frames)!!
    assertTrue(expected.amplitudeG > 0)
    for (variant in 1..3) assertEquals(expected, LearnedMotionFeatures.recording(depth(trial, variant).frames))
    assertEquals("motion_xy", expected.kind)
    assertTrue(expected.points.all { it.z == 0.0 })
  }

  @Test fun learnedPredictionAndDispatchTimeIgnoreStaticNoisyAndInvalidDepth() {
    val profile = fit(take()); val expected = replay(take(), profile)
    assertEquals(listOf("right"), expected.map { it.first })
    for (variant in 1..3) assertEquals("variant=$variant", expected, replay(depth(take(), variant), profile))
    assertEquals(3, profile.learnedModels.getValue("right").version)
  }

  @Test fun depthOnlyTakesAreKeptButNeverTriggerLearnedOrLegacyActions() {
    val still = take().let { it.copy(frames = it.frames.map { f -> f.copy(x = 0.0) }) }
    val onlyDepth = depth(still, 2)
    val model = fit(onlyDepth)
    assertEquals(0.0, model.learnedModels.getValue("right").templates.first().amplitudeG, 0.0)
    assertEquals(5, model.learnedModels.getValue("right").templates.size)
    for (gesture in listOf("right", "single")) {
      val capture = onlyDepth.copy(gesture = gesture)
      assertTrue(replay(capture).isEmpty())
      assertTrue(replay(capture, fit(take(gesture))).isEmpty())
    }
  }

  @Test fun untrainedFlickAndCountKeepIdenticalEventsAndTimingAcrossDepthChanges() {
    for (trial in listOf(take(), take("single", 1))) {
      val expected = replay(trial)
      assertFalse("fixture must exercise an action", expected.isEmpty())
      for (variant in 1..3) assertEquals(expected, replay(depth(trial, variant)))
    }
  }

  @Test fun directTiltAndSegmentEndpointsIgnoreDepth() {
    fun tilt(z: (Long) -> Double): List<Pair<String, Long>> {
      val detector = TiltReturnDetector(null); val events = mutableListOf<Pair<String, Long>>()
      for (t in 0L..3000L step 40) {
        val angle = if (t in 800..1600) Math.toRadians(30.0) else 0.0
        detector.addSample(sin(angle), cos(angle), z(t), t, true).gesture?.let { events.add(it to t) }
      }
      return events
    }
    val expected = tilt { 0.0 }; assertEquals(listOf("left_straight"), expected.map { it.first })
    assertEquals(expected, tilt { sin(it.toDouble()) * 1000 })
    fun segments(trial: CalibrationTrial): List<Long> {
      val events = mutableListOf<Long>(); var now = 0L
      val segmenter = GenericMotionSegmenter(1100) { _, _, _ -> events.add(now); 700L }
      for (f in trial.frames) { now = f.timestampMs; segmenter.addSample(f) }
      return events
    }
    val endpoints = segments(take()); assertFalse(endpoints.isEmpty())
    assertEquals(endpoints, segments(depth(take(), 2)))
  }

  @Test fun pointDistancesAndChosenLabelCannotDependOnZ() {
    val sample = LearnedMotionFeatures.recording(take().frames)!!
    val altered = sample.copy(points = sample.points.mapIndexed { index, point -> point.copy(z = index * 100.0) })
    assertEquals(0.0, LearnedMotionMatcher.distance(sample, altered), 0.0)
    val other = sample.copy(points = sample.points.map { it.copy(x = -it.x) })
    val models = linkedMapOf("right" to LearnedMotionModel(3, List(5) { altered }, .22),
      "left" to LearnedMotionModel(3, List(5) { other }, .22))
    assertEquals("right", LearnedMotionMatcher.match(mapOf("motion" to sample), models))
  }

  @Test fun savedRawRebuildsEffectiveXYModelsWithoutChangingOriginalArchive() {
    val saved = archived("left", "right")
    val before = saved.toJson().toString()
    val effective = MotionXY.effectiveProfile(saved)!!
    val model = effective.learnedModels.getValue("right")
    assertEquals(3, model.version); assertEquals(5, model.templates.size)
    assertEquals(LearnedMotionFeatures.recording(take().frames), model.templates.first())
    assertEquals(before, saved.toJson().toString())
    assertEquals(4L, saved.revision)
    val view = JSONObject(GestureCalibrationReadings.read("right", null, GestureCalibrationState(), emptyList(), saved))
    assertEquals(listOf("x", "y"), view.getJSONArray("recognitionAxes").let { axes -> (0 until axes.length()).map(axes::getString) })
    val template = view.getJSONArray("takes").getJSONObject(0).getJSONObject("template")
    assertEquals(3, template.getInt("modelVersion")); assertEquals(2, template.getInt("storedModelVersion"))
    assertEquals("raw_rebuilt", template.getString("source"))
    assertEquals(model.templates.first().amplitudeG, template.getDouble("amplitudeG"), 0.0)
    assertNotEquals(0.0, view.getJSONArray("takes").getJSONObject(0).getJSONArray("raw").getJSONObject(1).getDouble("z"), 0.0)
  }

  @Test fun templateOnlyCompatibilityPreservesTenExamplesAndRescalesXYAmplitude() {
    val prior = MotionCalibrationProfile(learnedModels = mapOf("right" to oldModel(10)))
    val before = prior.toJson().toString()
    val model = MotionXY.effectiveProfile(SavedGestureCalibration(profile = prior))!!.learnedModels.getValue("right")
    assertEquals(3, model.version); assertEquals(10, model.templates.size)
    assertEquals(1.2, model.templates.first().amplitudeG, 1e-12)
    assertEquals(1.0, model.templates.first().points[15].x, 0.0)
    assertTrue(model.templates.all { t -> t.points.all { it.z == 0.0 } })
    assertEquals(before, prior.toJson().toString())
    val zOnly = oldModel(10).copy(templates = oldModel(10).templates.map { t -> t.copy(points = t.points.map { it.copy(x = 0.0) }) })
    val projected = MotionXY.effectiveProfile(SavedGestureCalibration(profile = prior.copy(learnedModels = mapOf("right" to zOnly))))!!
    assertEquals(0.0, projected.learnedModels.getValue("right").templates.first().amplitudeG, 0.0)
    assertEquals(projected, MotionXY.effectiveProfile(SavedGestureCalibration(profile = projected)))
  }

  @Test fun olderTemplateDepthNormalizationCancelsWithoutChangingXYStrengthOrShape() {
    val original = oldModel().templates.first()
    val deeper = original.copy(amplitudeG = 10.0,
      points = original.points.map { it.copy(x = it.x / 5, y = it.y / 5, z = if (it.z > 0) 1.0 else -1.0) })
    val a = MotionXY.template(original); val b = MotionXY.template(deeper)
    assertEquals(a.points, b.points)
    assertEquals(a.amplitudeG, b.amplitudeG, 1e-12)
    assertEquals(0.0, LearnedMotionMatcher.distance(a, b), 1e-12)
  }

  @Test fun historicalThresholdFittingAlsoUsesOnlyXYWithoutChangingTimingRules() {
    val expected = MotionCalibration.fit(listOf(take()), selectedGestures = listOf("right"))
    assertNotNull(expected.message, expected.profile)
    for (variant in 1..3) {
      val result = MotionCalibration.fit(listOf(depth(take(), variant)), selectedGestures = listOf("right"))
      assertEquals(expected.profile!!.copy(calibratedAt = 0), result.profile?.copy(calibratedAt = 0))
    }
  }

  @Test fun newXYCodecPreservesFiveAndTenExamplesAndRejectsNonzeroDepth() {
    val base = fit(take())
    for (count in listOf(5, 10)) {
      val model = base.learnedModels.getValue("right").copy(templates = List(count) { base.learnedModels.getValue("right").templates.first() })
      val profile = base.copy(learnedModels = mapOf("right" to model))
      assertEquals(profile, MotionCalibrationProfile.parse(profile.toJson()))
      assertEquals(3, profile.learnedModels.getValue("right").version)
      val invalid = profile.toJson()
      invalid.getJSONObject("learnedModels").getJSONObject("right").getJSONArray("templates").getJSONObject(0).getJSONArray("points").getJSONArray(0).put(2, .2)
      assertNull(MotionCalibrationProfile.parse(invalid))
    }
  }

  @Test fun targetedRetrainKeepsUnrelatedOriginalModelsAndXYZReadings() {
    var persisted: String? = archived("left", "right").toJson().toString()
    val store = GestureCalibrationStore(object : GestureCalibrationPersistence {
      override fun read() = persisted
      override fun write(raw: String?): Boolean { persisted = raw; return true }
    })
    val prior = store.load()
    MotionXY.effectiveProfile(prior)
    GestureCalibrationReadings.read("right", null, GestureCalibrationState(), emptyList(), prior)
    val newTakes = List(5) { take("left") }
    val replacement = LearnedMotionCalibration.fit(newTakes, selectedGestures = listOf("left"), existingProfile = prior.profile).profile!!
    val saved = store.save(replacement, newTakes)
    assertEquals(3, saved.profile!!.learnedModels.getValue("left").version)
    assertEquals(prior.profile!!.learnedModels.getValue("right"), saved.profile!!.learnedModels.getValue("right"))
    assertEquals(prior.readings.getValue("right"), saved.readings.getValue("right"))
  }
}
