package com.remotemac.gestures

data class CalibrationVector(val x: Double, val y: Double, val z: Double)
data class LearnedMotionTemplate(val points: List<CalibrationVector>, val durationMs: Long, val amplitudeG: Double,
  val kind: String, val polarity: Int, val cycles: Int)
data class LearnedMotionModel(val version: Int = 1, val templates: List<LearnedMotionTemplate>, val maxDistance: Double)

object LearnedMotionCalibration {
  const val TAKES_PER_GESTURE = 5
  fun fit(trials: List<CalibrationTrial>, requireComplete: Boolean = true,
    selectedGestures: List<String> = MotionCalibration.ALL_GESTURES, existingProfile: MotionCalibrationProfile? = null): CalibrationFit {
    fun fail(message:String)=CalibrationFit(null,message)
    if(selectedGestures.isEmpty() || selectedGestures.distinct().size!=selectedGestures.size || selectedGestures.any{it !in MotionCalibration.ALL_GESTURES} ||
      trials.isEmpty() || trials.size>selectedGestures.size*TAKES_PER_GESTURE || trials.any{it.gesture !in selectedGestures})return fail("Record the selected movements one at a time.")
    val grouped=trials.groupBy{it.gesture}
    if(grouped.values.any{it.size>TAKES_PER_GESTURE} || (requireComplete && selectedGestures.any{grouped[it]?.size!=TAKES_PER_GESTURE}))
      return fail("Record $TAKES_PER_GESTURE takes of each selected movement before saving.")
    val extracted=mutableMapOf<String,List<LearnedMotionTemplate>>()
    for((gesture,takes) in grouped) {
      val templates=mutableListOf<LearnedMotionTemplate>()
      for(take in takes) {
        val example=LearnedMotionFeatures.recording(take.frames)
          ?:return fail("No sensor recording was available. Record this take again.")
        templates.add(example)
      }
      extracted[gesture]=templates
    }
    val prior=existingProfile?:MotionCalibrationProfile(calibratedGestures=emptySet())
    val models=prior.learnedModels.toMutableMap()
    for((gesture,templates) in extracted)if(templates.size==TAKES_PER_GESTURE) {
      // Every example has equal standing. No consistency vote or label-specific
      // motion test may discard a take or change another take's acceptance bound.
      models[gesture]=LearnedMotionModel(version=MotionXY.VERSION,templates=templates.toList(),maxDistance=.22)
    }
    val learned=extracted.filterValues{it.size==TAKES_PER_GESTURE}.keys
    return CalibrationFit(prior.copy(calibratedAt=System.currentTimeMillis(),calibratedGestures=prior.calibratedGestures+learned,learnedModels=models.toMap()),
      if(requireComplete)"Your examples are learned and ready to save." else "Take recorded. Vary your next movement naturally.")
  }
}
