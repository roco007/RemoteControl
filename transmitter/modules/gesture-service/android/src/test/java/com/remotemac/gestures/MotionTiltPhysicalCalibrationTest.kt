package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

/** Physical portrait tilt-and-return captures. Fixtures contain only relative
 * sensor time and acceleration in g; preparation and return are unmodified. */
class MotionTiltPhysicalCalibrationTest {
  private fun trial(name: String, gesture: String): CalibrationTrial {
    val frames = javaClass.getResourceAsStream("/motion/$name.csv")!!.bufferedReader().useLines { lines ->
      lines.drop(1).map { line -> val r = line.split(','); CalibrationFrame(r[1].toDouble(), r[2].toDouble(), r[3].toDouble(), r[0].toLong()) }.toList()
    }
    return CalibrationTrial(gesture, frames)
  }
  private fun fit(trial: CalibrationTrial) = MotionCalibration.fit(listOf(trial), selectedGestures = listOf(trial.gesture))

  @Test fun physicalRightRollCalibrationIgnoresDepthEvenWhenXYPostureChanges() {
    val recorded = trial("tilt-right-pitch-change", "right_straight")
    val xy = fit(recorded.copy(frames = recorded.frames.map { it.copy(z = 0.0) }))
    for (altered in listOf(recorded, recorded.copy(frames = recorded.frames.mapIndexed { index, f -> f.copy(z = kotlin.math.sin(index.toDouble()) * 1000) }))) {
      val result = fit(altered)
      assertEquals(xy.profile?.copy(calibratedAt = 0), result.profile?.copy(calibratedAt = 0))
      assertEquals(xy.message, result.message)
    }
  }

  @Test fun acceptsALeftRollWithNaturalWristPitchChange() {
    val recorded = trial("tilt-left-pitch-change", "left_straight")
    val result = fit(recorded)
    assertNotNull(result.message, result.profile)
  }

  @Test fun preservesTheAlreadyAcceptedRightRecording() {
    val result = fit(trial("tilt-right-accepted", "right_straight"))
    assertNotNull(result.message, result.profile)
  }

  @Test fun mirroredPhysicalRollCannotTrainTheWrongSide() {
    val left = trial("tilt-left-pitch-change", "left_straight")
    assertNull(fit(left.copy(frames = left.frames.map { it.copy(x = -it.x) })).profile)
  }

  @Test fun realTiltsFitWithExistingGentleFlickCalibrationAndPreserveIt() {
    val saved=MotionCalibrationProfile(leftThresholdG=.65,rightThresholdG=.9,calibratedGestures=setOf("left","right"))
    for(name in listOf("tilt-right-pitch-change","tilt-right-accepted","tilt-left-pitch-change")) {
      val recorded=trial(name,if(name.contains("left"))"left_straight" else "right_straight")
      val fit=MotionCalibration.fit(listOf(recorded),selectedGestures=listOf(recorded.gesture),existingProfile=saved)
      assertNotNull("$name ${fit.message}",fit.profile)
      assertEquals(saved.leftThresholdG,fit.profile!!.leftThresholdG,0.0)
      assertEquals(saved.rightThresholdG,fit.profile!!.rightThresholdG,0.0)
    }
  }
}
