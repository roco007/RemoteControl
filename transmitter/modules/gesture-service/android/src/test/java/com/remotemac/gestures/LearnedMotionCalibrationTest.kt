package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

class LearnedMotionLegacyCompatibilityTest {
  private fun flick(gesture: String = "right", strength: Double = 1.3, width: Int = 2): CalibrationTrial {
    val frames = mutableListOf<CalibrationFrame>(); var time = 0L
    fun sample(x: Double = 0.0) { frames.add(CalibrationFrame(x, 1.0, 0.0, time)); time += 40 }
    repeat(34) { sample() }
    val sign = if (gesture == "right") 1 else -1
    repeat(width) { sample(sign * strength) }; sample(); repeat(width) { sample(-sign * strength * .8) }
    while (time <= 7720) sample()
    return CalibrationTrial(gesture, frames)
  }
  private fun shake(count:Int,strength:Double=1.3,gap:Long=400):CalibrationTrial {
    val frames=mutableListOf<CalibrationFrame>();var time=0L
    fun sample(x:Double=0.0){frames.add(CalibrationFrame(x,1.0,0.0,time));time+=40}
    repeat(34){sample()}
    repeat(count){index->repeat(2){sample(strength)};sample();repeat(2){sample(-strength)};sample();if(index<count-1)repeat((gap/40).toInt()){sample()}}
    while(time<=7720)sample()
    return CalibrationTrial(listOf("single","double","triple").getOrElse(count-1){"triple"},frames)
  }
  private fun tilt(gesture:String="right_straight",angle:Double=32.0,move:Int=400,hold:Int=800,returnHome:Boolean=true,returnMove:Int=move):CalibrationTrial {
    val frames=mutableListOf<CalibrationFrame>();var time=0L;val sign=if(gesture=="left_straight")1 else -1
    fun pose(degrees:Double){val r=Math.toRadians(degrees);frames.add(CalibrationFrame(kotlin.math.sin(r),kotlin.math.cos(r),0.0,time));time+=40}
    repeat(34){pose(0.0)}
    for(i in 1..move/40)pose(sign*angle*i/(move/40))
    repeat(hold/40){pose(sign*angle)}
    if(returnHome)for(i in 1..returnMove/40)pose(sign*angle*(1.0-i.toDouble()/(returnMove/40)))
    while(time<=7720)pose(if(returnHome)0.0 else sign*angle)
    return CalibrationTrial(gesture,frames)
  }
  private fun legacyProfile(trials:List<CalibrationTrial>):MotionCalibrationProfile {
    // Test-only construction reproduces persisted version1 models. New training
    // deliberately does not use these semantic gates or the two-example vote.
    val models=trials.groupBy{it.gesture}.mapValues{(_,takes)->
      val templates=takes.map{LearnedMotionCapture.templates(it).single()}
      val heldOut=templates.indices.map{i->templates.indices.filter{it!=i}.minOf{j->LearnedMotionMatcher.distance(templates[i],templates[j])}}
      val finite=heldOut.filter{it.isFinite()}.sorted()
      val central=if(finite.isEmpty()).18 else finite[((finite.size-1)*.7).toInt()]
      LearnedMotionModel(version=1,templates=templates,maxDistance=(central*1.7+.04).coerceIn(.16,.40))
    }
    return MotionCalibrationProfile(calibratedGestures=models.keys,learnedModels=models)
  }
  private fun replay(trial:CalibrationTrial,profile:MotionCalibrationProfile):List<String> {
    val actions=mutableListOf<String>();val detector=MotionGestureDetector(if(trial.gesture in listOf("single","double","triple"))"count" else "directional",{_,_->},{g,_->actions.add(g)},profile)
    var tick=0L
    trial.frames.forEach{frame->while(tick<=frame.timestampMs){detector.tick(tick);tick+=60};detector.addSample(frame.x,frame.y,frame.z,frame.timestampMs)}
    return actions
  }
  private fun physical(name:String,gesture:String):CalibrationTrial {
    val frames=javaClass.getResourceAsStream("/motion/$name.csv")!!.bufferedReader().readLines().drop(1).map{line->
      val r=line.split(',');CalibrationFrame(r[1].toDouble(),r[2].toDouble(),r[3].toDouble(),r[0].toLong())
    };return CalibrationTrial(gesture,frames)
  }

  @Test fun aUsablePartialCaptureIsAcceptedWithoutTheOldDetectorThreshold() {
    val result = LearnedMotionCalibration.fit(listOf(flick(strength = .5)), false, listOf("right"))
    assertNotNull(result.message, result.profile)
  }

  @Test fun fiveVariedExamplesCanBeLearnedAndFourCannotBeSaved() {
    val trials = (0 until 5).map { flick(strength = .7 + it * .11, width = 2 + it % 3) }
    assertNull(LearnedMotionCalibration.fit(trials.take(4), selectedGestures = listOf("right")).profile)
    val result = LearnedMotionCalibration.fit(trials, selectedGestures = listOf("right"))
    assertNotNull(result.message, result.profile)
  }

  @Test fun legacyFeatureExtractionStillRejectsStationaryShape() {
    val still = flick().let { it.copy(frames = it.frames.map { frame -> frame.copy(x = 0.0) }) }
    assertTrue(LearnedMotionCapture.templates(still).isEmpty())
  }

  @Test fun heldOutFlicksAndTiltSpeedsAreRecognizedThroughTheProductionStream() {
    val profile=legacyProfile((0 until 10).flatMap{i->listOf(flick(strength=.8+i*.09,width=2+i%3),tilt(angle=25.0+i,move=320+i%3*160))})
    assertEquals(listOf("right"),replay(flick(strength=1.07,width=3),profile))
    assertEquals(listOf("right_straight"),replay(tilt(angle=30.5,move=800,hold=1000),profile))
    assertTrue(replay(tilt(returnHome=false),profile).isEmpty())
  }

  @Test fun learnedCountsWaitForWholeSequenceAndUntrainedCountsDispatchOnce() {
    val single=legacyProfile((0 until 10).map{shake(1,.8+it*.1)})
    for(gap in listOf(280L,700L))for(count in 2..3)
      assertEquals("gap=$gap count=$count",listOf(listOf("single","double","triple")[count-1]),replay(shake(count,3.0,gap),single))
    val double=legacyProfile((0 until 10).map{shake(2,.8+it*.1,280+it%3*160L)})
    assertEquals(listOf("triple"),replay(shake(3,3.0,700),double))
    val longGap=legacyProfile((0 until 10).map{shake(2,1.0+it*.06,1120+it%3*40L)})
    assertEquals(listOf("double"),replay(shake(2,1.17,1200),longGap))
  }

  @Test fun slowTiltAndLaterPreparationRestUseTheSameSegmentationAsRuntime() {
    val takes=(0 until 10).map{tilt(angle=26.0+it*.5,move=1200,hold=400)}
    val profile=legacyProfile(takes)
    assertEquals(listOf("right_straight"),replay(tilt(angle=27.0,move=1600,hold=400),profile))
    val jitter=takes.first().copy(frames=takes.first().frames.map{if(it.timestampMs<720)it.copy(x=if(it.timestampMs%80==0L).8 else -.8)else it})
    assertNotNull(LearnedMotionCalibration.fit(listOf(jitter),false,listOf("right_straight")).profile)
  }

  @Test fun independentPhysicalTiltRecognitionAfterPersistenceIsInvariantToDepth() {
    val training=physical("tilt-right-accepted","right_straight")
    val takes=(0 until 10).map{i->training.copy(frames=training.frames.map{f->f.copy(x=f.x*(.92+i*.017),timestampMs=(f.timestampMs*(.93+i*.015)).toLong())})}
    val profile=MotionCalibrationProfile.parse(legacyProfile(takes).toJson())!!
    val heldOut=physical("tilt-right-pitch-change","right_straight")
    assertEquals(listOf("right_straight"), replay(training, profile))
    val expected = replay(heldOut.copy(frames = heldOut.frames.map { it.copy(z = 0.0) }), profile)
    assertEquals(expected, replay(heldOut, profile))
    assertEquals(expected, replay(heldOut.copy(frames = heldOut.frames.mapIndexed { index, f -> f.copy(z = kotlin.math.sin(index.toDouble()) * 1000) }), profile))
  }

  @Test fun oneOutlierCannotWidenTheModelOrTriggerAnActionByItself() {
    val odd=flick(strength=1.1).let{it.copy(frames=it.frames.map{f->f.copy(y=1.0+f.x)})}
    val model=legacyProfile((0 until 9).map{flick(strength=.9+it*.05)}+odd)
    assertEquals(listOf("right"),replay(flick(strength=1.13),model))
    assertTrue(replay(odd,model).isEmpty())
    assertFalse(replay(flick("left",1.13),model).contains("right"))
  }

  @Test fun indistinguishableLabelsAndNearBoundaryCompetitorsAreRejected() {
    val takes=(0 until 10).map{flick(strength=1.0+it*.03)}
    val profile=legacyProfile(takes+takes.map{it.copy(gesture="left")})
    assertTrue(replay(flick(strength=1.12),profile).isEmpty())
    fun example(x:Double)=LearnedMotionTemplate(List(32){CalibrationVector(if(it==31)1.0 else x,0.0,0.0)},500,1.0,"flick",1,0)
    val models=mapOf("right" to LearnedMotionModel(templates=List(10){example(0.0)},maxDistance=.12),
      "left" to LearnedMotionModel(templates=List(10){example(.4)},maxDistance=.11))
    assertNull(LearnedMotionMatcher.match(mapOf("flick" to example(.2)),models))
  }

  @Test fun continuousWalkingAndMissingSensorTailDoNotProduceAPrefixAction() {
    val profile=legacyProfile((0 until 10).map{shake(1,1.1+it*.05)})
    val walking=shake(1).copy(frames=(0L..12000L step 40).map{t->CalibrationFrame(0.0,1.0+if(t in 1400..9000).45*kotlin.math.sin(t*Math.PI/300) else 0.0,0.0,t)})
    assertTrue(replay(walking,profile).isEmpty())
    assertTrue(replay(shake(4,3.0),profile).isEmpty())
    val actions=mutableListOf<String>();val detector=MotionGestureDetector("count",{_,_->},{g,_->actions.add(g)},profile)
    shake(1).frames.filter{it.timestampMs<1600}.forEach{detector.addSample(it.x,it.y,it.z,it.timestampMs)}
    detector.tick(10000);assertTrue(actions.isEmpty())
  }

  @Test fun aSideHoldOrPartialReturnCannotCompleteALearnedTilt() {
    val profile=legacyProfile((0 until 10).map{tilt(angle=30.0+it*.4,hold=700+it%3*120)})
    val partial=tilt(angle=33.0).let{t->t.copy(frames=t.frames.map{f->if(f.timestampMs>2900) f.copy(x=kotlin.math.sin(Math.toRadians(-15.0)),y=kotlin.math.cos(Math.toRadians(-15.0)))else f})}
    assertTrue(replay(partial,profile).isEmpty())
    assertTrue(replay(partial,profile.copy(learnedModels=profile.learnedModels.mapValues{it.value.copy(maxDistance=.4)})).isEmpty())
  }

  @Test fun gentleSlowRollRetainsItsTrueRestingPrefixAndLateCompleteCaptureIsUsable() {
    val takes=(0 until 10).map{tilt(angle=20.0+it*.3,move=1600,hold=400,returnMove=400)}
    val profile=legacyProfile(takes)
    assertEquals(listOf("right_straight"),replay(tilt(angle=21.3,move=2000,hold=700,returnMove=400),profile))
    val late=flick().let{t->t.copy(frames=t.frames.map{f->f.copy(timestampMs=f.timestampMs+if(f.timestampMs>=1360)5600 else 0)}
      .let{f->val rest=(1360L until 6960L step 40).map{CalibrationFrame(0.0,1.0,0.0,it)};(f+rest).sortedBy{it.timestampMs}.filter{it.timestampMs<=7720}})}
    assertNotNull(LearnedMotionCalibration.fit(listOf(late),false,listOf("right")).profile)
  }

  @Test fun allSevenLearnedLabelsRecognizeHeldOutTakesAndPreserveUnrelatedProfiles() {
    val takes=(0 until 10).flatMap{i->listOf(flick("left",.8+i*.07,2+i%2),flick("right",1.0+i*.07,2+i%2),
      tilt("left_straight",25.0+i,320+i%2*160),tilt("right_straight",25.0+i,320+i%2*160),
      shake(1,1.0+i*.08),shake(2,1.0+i*.08,280+i%2*120L),shake(3,1.0+i*.08,280+i%2*120L))}
    val learned=legacyProfile(takes)
    assertEquals(MotionCalibration.ALL_GESTURES.toSet(),learned.learnedModels.keys)
    for(t in listOf(flick("left",1.04,3),flick("right",1.24,3),tilt("left_straight",30.1,640),tilt("right_straight",30.1,640),
      shake(1,1.21),shake(2,1.21,360),shake(3,1.21,360)))assertEquals(t.gesture,listOf(t.gesture),replay(t,learned))
    val replacement=LearnedMotionCalibration.fit((0 until 5).map{flick("left",1.0+it*.03)},selectedGestures=listOf("left"),existingProfile=learned).profile!!
    assertEquals(learned.learnedModels.filterKeys{it!="left"},replacement.learnedModels.filterKeys{it!="left"})
  }

  @Test fun untrainedPhysicalFlicksRemainAvailableBesideALearnedTiltWithoutDoubleDispatch() {
    val profile=legacyProfile((0 until 10).map{tilt(angle=26.0+it*.6)})
    for(name in listOf("right","left")) {
      val raw=javaClass.getResourceAsStream("/motion/$name.csv")!!.bufferedReader().readLines().drop(1).filter{it.isNotBlank()}.map{line->
        val r=line.split(',');CalibrationFrame(r[2].toDouble(),r[3].toDouble(),r[4].toDouble(),r[0].toDouble().toLong())}
      var next=raw.first().timestampMs
      val sampled=raw.filter{f->if(f.timestampMs<next)false else{while(next<=f.timestampMs)next+=40;true}}
      val frames=(0L until 1360 step 40).map{sampled.first().copy(timestampMs=it)}.toMutableList()
      sampled.forEachIndexed{i,f->frames.add(f.copy(timestampMs=1360+i*40L))}
      while(frames.last().timestampMs<7720)frames.add(sampled.last().copy(timestampMs=frames.last().timestampMs+40))
      assertEquals(name,listOf(name),replay(CalibrationTrial(name,frames),profile))
    }
  }

  @Test fun fasterSensorDeliveryUsesTheSameBoundedSamplingAsCapture() {
    val profile=legacyProfile((0 until 10).map{tilt(angle=28.0+it*.4,move=1200,hold=900)})
    val original=tilt(angle=30.1,move=1400,hold=1000)
    val dense=(0L..original.frames.last().timestampMs step 10).map{time->
      val i=original.frames.indexOfFirst{it.timestampMs>=time};val b=original.frames[i];val a=original.frames[(i-1).coerceAtLeast(0)]
      val ratio=if(a.timestampMs==b.timestampMs)0.0 else (time-a.timestampMs).toDouble()/(b.timestampMs-a.timestampMs)
      CalibrationFrame(a.x+(b.x-a.x)*ratio,a.y+(b.y-a.y)*ratio,a.z+(b.z-a.z)*ratio,time)
    }
    assertEquals(listOf("right_straight"),replay(original,profile))
    assertEquals(listOf("right_straight"),replay(original.copy(frames=dense),profile))
  }

  @Test fun aLearnedMismatchCannotFallBackToItsOldThresholdAction() {
    val profile=legacyProfile((0 until 10).map{flick(strength=.8+it*.04)})
    val different=flick(strength=3.8,width=8)
    assertEquals(listOf("right"),replay(different,profile.copy(learnedModels=emptyMap())))
    assertTrue(replay(different,profile).isEmpty())
  }

  @Test fun resetDiscardsAnInterruptedTakeAndFreshRestRearmsRecognition() {
    val profile=legacyProfile((0 until 10).map{flick(strength=.9+it*.04)})
    val actions=mutableListOf<String>();val detector=MotionGestureDetector("directional",{_,_->},{g,_->actions.add(g)},profile)
    val original=flick()
    original.frames.filter{it.timestampMs<1500}.forEach{detector.addSample(it.x,it.y,it.z,it.timestampMs)}
    detector.reset()
    original.frames.filter{it.timestampMs>=1500}.forEach{detector.addSample(it.x,it.y,it.z,it.timestampMs)}
    assertTrue(actions.isEmpty())
    original.frames.forEach{detector.addSample(it.x,it.y,it.z,it.timestampMs+8000)}
    assertEquals(listOf("right"),actions)
  }

  @Test fun horizontalAccelerationAndPitchOnlyMotionCannotImpersonateLearnedRoll() {
    val profile=legacyProfile((0 until 10).map{tilt(angle=25.0+it*.8)})
    val original=tilt(angle=30.0)
    val translation=original.copy(frames=original.frames.map{it.copy(y=1.0)})
    val pitch=original.copy(frames=original.frames.map{it.copy(x=0.0,z=it.x)})
    assertTrue(replay(translation,profile).isEmpty())
    assertTrue(replay(pitch,profile).isEmpty())
  }
}
