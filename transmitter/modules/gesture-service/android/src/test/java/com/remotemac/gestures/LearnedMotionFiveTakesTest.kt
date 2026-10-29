package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

class LearnedMotionFiveTakesTest {
  private fun take(gesture: String = "right", axis: Int = 0): CalibrationTrial = CalibrationTrial(gesture,
    (0L..7720L step 40).map { time ->
      val pulse = when (time) { in 1400..1480 -> 1.2; in 1560..1640 -> -0.9; else -> 0.0 }
      CalibrationFrame(if (axis == 0) pulse else 0.0, if (axis == 1) pulse else 0.0,
        1.0 + if (axis == 2) pulse else 0.0, time)
    })
  private fun replay(trial: CalibrationTrial, profile: MotionCalibrationProfile): List<String> {
    val actions = mutableListOf<String>()
    val detector = MotionGestureDetector("directional", { _, _ -> }, { gesture, _ -> actions.add(gesture) }, profile)
    for (frame in trial.frames) detector.addSample(frame.x, frame.y, frame.z, frame.timestampMs)
    return actions
  }

  @Test fun exactlyFiveNewTakesAreRequiredWithoutMovementCorrectnessChecks() {
    val still = CalibrationTrial("right", listOf(CalibrationFrame(0.0, 0.0, 1.0, 0)))
    val takes = listOf(still) + List(4) { take(axis = 1) }
    for (count in listOf(0, 1, 4, 6, 10)) {
      assertNull("count=$count", LearnedMotionCalibration.fit(List(count) { takes[it % 5] },
        selectedGestures = listOf("right")).profile)
    }
    assertNotNull(LearnedMotionCalibration.fit(takes.take(4), requireComplete = false, selectedGestures = listOf("right")).profile)
    val fitted = LearnedMotionCalibration.fit(takes, selectedGestures = listOf("right"))
    assertNotNull(fitted.message, fitted.profile)
    assertEquals(5, fitted.profile!!.learnedModels.getValue("right").templates.size)
    assertEquals(0.0, fitted.profile!!.learnedModels.getValue("right").templates.first().amplitudeG, 0.0)
  }

  @Test fun allSevenLabelsNeedThirtyFiveTakes() {
    val takes = MotionCalibration.ALL_GESTURES.flatMap { gesture -> List(5) { take(gesture) } }
    val fitted = LearnedMotionCalibration.fit(takes)
    assertNotNull(fitted.message, fitted.profile)
    assertEquals(MotionCalibration.ALL_GESTURES.toSet(), fitted.profile!!.learnedModels.keys)
    assertEquals(35, fitted.profile!!.learnedModels.values.sumOf { it.templates.size })
  }

  @Test fun fifthDistinctExampleStillTriggersWithoutSupportFromTheOtherFour() {
    val unique = take(axis = 1)
    val fitted = LearnedMotionCalibration.fit(List(4) { take() } + unique, selectedGestures = listOf("right"))
    assertNotNull(fitted.message, fitted.profile)
    val loaded = MotionCalibrationProfile.parse(fitted.profile!!.toJson())!!
    assertEquals(listOf("right"), replay(unique, loaded))
  }

  @Test fun newFiveExampleLabelPreservesAndRecognizesAnExistingTenthExample() {
    // Explicit historical kind: current recording extraction produces v3 motion_xy.
    val ordinary = LearnedMotionFeatures.recording(take().frames)!!.copy(kind = "motion")
    val uniqueTake = take(axis = 1)
    val unique = LearnedMotionFeatures.recording(uniqueTake.frames)!!.copy(kind = "motion")
    val oldModel = LearnedMotionModel(2, List(9) { ordinary } + unique, 0.22)
    val oldProfile = MotionCalibrationProfile(leftThresholdG = 0.85, rightThresholdG = 1.6,
      calibratedGestures = setOf("right", "single"), learnedModels = mapOf("right" to oldModel))
    val persistedOld = MotionCalibrationProfile.parse(oldProfile.toJson())!!
    assertEquals(10, persistedOld.learnedModels.getValue("right").templates.size)
    assertEquals(listOf("right"), replay(uniqueTake, persistedOld))
    val left = take("left").let { trial -> trial.copy(frames = trial.frames.map { it.copy(x = -it.x) }) }
    val fitted = LearnedMotionCalibration.fit(List(5) { left }, selectedGestures = listOf("left"), existingProfile = persistedOld)
    assertNotNull(fitted.message, fitted.profile)
    val loaded = MotionCalibrationProfile.parse(fitted.profile!!.toJson())!!
    assertEquals(oldModel, loaded.learnedModels.getValue("right"))
    assertEquals(5, loaded.learnedModels.getValue("left").templates.size)
    assertEquals(3, loaded.learnedModels.getValue("left").version)
    assertEquals(0.85, loaded.leftThresholdG, 0.0)
    assertEquals(1.6, loaded.rightThresholdG, 0.0)
    assertTrue("single" in loaded.calibratedGestures)
    assertEquals(listOf("right"), replay(uniqueTake, loaded))
    assertEquals(listOf("left"), replay(left, loaded))
  }
}
