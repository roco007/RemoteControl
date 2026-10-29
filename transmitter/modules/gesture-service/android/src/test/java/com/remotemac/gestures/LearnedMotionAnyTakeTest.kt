package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

class LearnedMotionAnyTakeTest {
  private fun take(axis:Int=0,diagonal:Boolean=false):CalibrationTrial {
    val frames=(0L..7720L step 40).map{time->
      val n=when(time){in 1400..1480->1.2;in 1560..1640->-.9;else->0.0}
      CalibrationFrame(if(axis==0)n else 0.0,if(axis==1 || diagonal)n else 0.0,1.0+if(axis==2)n else 0.0,time)
    }
    return CalibrationTrial("right",frames)
  }
  private fun learn(takes:List<CalibrationTrial>):MotionCalibrationProfile {
    val result=LearnedMotionCalibration.fit(takes,selectedGestures=takes.map{it.gesture}.distinct())
    assertNotNull(result.message,result.profile);return result.profile!!
  }
  private fun replay(trial:CalibrationTrial,profile:MotionCalibrationProfile):List<String> {
    val actions=mutableListOf<String>();val detector=MotionGestureDetector(if(trial.gesture in setOf("single","double","triple"))"count" else "directional",{_,_->},{g,_->actions.add(g)},profile)
    var tick=0L
    trial.frames.forEach{f->while(tick<=f.timestampMs){detector.tick(tick);tick+=60};detector.addSample(f.x,f.y,f.z,f.timestampMs)}
    return actions
  }
  @Test fun everyFiniteRecordingIsRetainedIncludingStillAndUnusualMotion() {
    val still=take().let{t->t.copy(frames=t.frames.map{it.copy(x=0.0)})}
    assertNotNull(LearnedMotionCalibration.fit(listOf(still),false,listOf("right")).profile)
    val profile=learn(listOf(still)+List(4){take(axis=1)})
    val model=profile.learnedModels.getValue("right")
    assertEquals(3,model.version);assertEquals(5,model.templates.size)
    assertTrue(model.templates.all{it.kind=="motion_xy" && it.points.all{point->point.z==0.0}})
    assertEquals(0.0,model.templates.first().amplitudeG,0.0)
    assertTrue(replay(still,profile).isEmpty())
  }
  @Test fun oneDistinctTakeCanTriggerEvenWhenTheOtherFourAreDifferent() {
    val unique=take(diagonal=true)
    val profile=learn(List(4){take()}+unique)
    assertEquals(listOf("right"),replay(unique,profile))
  }
  @Test fun aLabelDoesNotRequireItsNamedDirectionOrMovement() {
    val vertical=take(axis=1).copy(gesture="left_straight")
    val profile=learn(List(5){vertical})
    assertEquals(listOf("left_straight"),replay(vertical,profile))
  }
  @Test fun partialReturnsAndMultipleMotionsAreValidUnderAnyLabel() {
    val arbitrary=take().copy(frames=(0L..7720L step 40).map{time->
      val angle=when{time<1400->0.0;time<2000->(time-1400)*30.0/600;time<3200->30.0;time<3800->30-(time-3200)*15.0/600;else->15.0}
      val r=Math.toRadians(angle)
      CalibrationFrame(0.0,kotlin.math.sin(r),kotlin.math.cos(r),time)
    })
    for(label in listOf("left","right_straight","triple")){
      val trial=arbitrary.copy(gesture=label);val profile=learn(List(5){trial})
      assertEquals(label,listOf(label),replay(trial,profile))
    }
    val multiple=take(axis=1).let{t->t.copy(frames=t.frames.map{f->
      if(f.timestampMs in 3400..3480)f.copy(y=1.1)else if(f.timestampMs in 3560..3640)f.copy(y=-1.1)else f})}
    val learned=learn(List(5){multiple})
    assertEquals(listOf("right"),replay(multiple,learned))
  }
  @Test fun nearestExampleWinsAndAnExactTieUsesCanonicalOrder() {
    val same=take(axis=1)
    val profile=learn(List(5){same}+List(5){same.copy(gesture="left")})
    assertEquals(listOf("left"),replay(same,profile))
    val one=LearnedMotionFeatures.recording(same.frames)!!
    val close=one.copy(points=one.points.map{it.copy(x=it.x+.01)})
    val models=linkedMapOf("left" to LearnedMotionModel(3,List(5){close},.22),"right" to LearnedMotionModel(3,List(5){one},.22))
    assertEquals("right",LearnedMotionMatcher.match(mapOf("motion" to one),models))
  }
  @Test fun shortAndStillTakesSurvivePersistenceWithoutIdleActions() {
    val short=CalibrationTrial("right",listOf(CalibrationFrame(.1,.2,.9,0)))
    val fitted=learn(List(5){short})
    val profile=MotionCalibrationProfile.parse(fitted.toJson())!!
    assertEquals(fitted.learnedModels,profile.learnedModels)
    val rest=short.copy(frames=(0L..15000L step 40).map{short.frames.single().copy(timestampMs=it)})
    assertTrue(replay(rest,profile).isEmpty())
  }
  @Test fun isolatedRecordedPhoneTakeRecognizesAnIndependentSimilarTakeAfterReload() {
    fun physical(name:String):CalibrationTrial {
      val frames=javaClass.getResourceAsStream("/motion/$name.csv")!!.bufferedReader().readLines().drop(1).map{line->
        val r=line.split(',');CalibrationFrame(r[1].toDouble(),r[2].toDouble(),r[3].toDouble(),r[0].toLong())
      };return CalibrationTrial("right_straight",frames)
    }
    val recorded=physical("tilt-right-accepted")
    val profile=MotionCalibrationProfile.parse(learn(List(4){take().copy(gesture="right_straight")}+recorded).toJson())!!
    assertEquals(listOf("right_straight"),replay(physical("tilt-right-pitch-change"),profile))
  }
  @Test fun trainedMismatchCannotUseOldThresholdAndMissingDataCannotCreateMotion() {
    val profile=learn(List(5){take(axis=1)})
    assertTrue(replay(take(),profile).isEmpty())
    assertNull(LearnedMotionCalibration.fit(listOf(take().copy(frames=emptyList())),false,listOf("right")).profile)
  }
  @Test fun legacySupportOrMarginFailureCannotVetoAValidVersionTwoExample() {
    fun template(kind:String,distance:Double)=LearnedMotionTemplate(List(32){CalibrationVector(distance*kotlin.math.sqrt(3.0),0.0,0.0)},500,1.0,kind,if(kind=="motion")0 else 1,0)
    val features=mapOf("motion" to template("motion",0.0),"flick" to template("flick",0.0))
    val close=linkedMapOf("left" to LearnedMotionModel(1,List(10){template("flick",.10)},.22),
      "right" to LearnedMotionModel(2,List(10){template("motion",.11)},.22))
    assertEquals("right",LearnedMotionMatcher.match(features,close))
    val unsupported=close+mapOf("left" to LearnedMotionModel(1,listOf(template("flick",0.0))+List(9){template("flick",.23)},.22),
      "right" to LearnedMotionModel(2,List(10){template("motion",.132)},.22))
    assertEquals("right",LearnedMotionMatcher.match(features,unsupported))
  }
}
