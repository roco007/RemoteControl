package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

class LearnedMotionLatencyTest {
  private data class Event(val gesture: String, val at: Long)
  private val recordings = java.util.IdentityHashMap<MotionCalibrationProfile, CalibrationReadings>()
  private fun frames(end: Long = 11000, pose: (Long) -> Pair<Double, Double>) = (0L..end step 40).map { time ->
    val (x, y) = pose(time); CalibrationFrame(x, y, 0.0, time)
  }
  private fun pulse(time: Long, start: Long, strength: Double = 1.0): Double = when (time - start) {
    in 0..80 -> strength
    in 160..240 -> -strength * .8
    else -> 0.0
  }
  private fun flick(strength: Double = 1.0) = CalibrationTrial("right", frames { time -> pulse(time, 1400, strength) to 1.0 })
  private fun tilt(hold: Long = 1200, returnHome: Boolean = true) = CalibrationTrial(if (returnHome) "right_straight" else "left", frames { time ->
    val angle = when {
      time < 1400 -> 0.0
      time < 1800 -> (time - 1400) * .6 / 400
      !returnHome || time < 1800 + hold -> .6
      time < 2200 + hold -> .6 * (2200 + hold - time) / 400
      else -> 0.0
    }
    kotlin.math.sin(angle) to kotlin.math.cos(angle)
  })
  private fun count(number: Int, gap: Long = 1200) = CalibrationTrial(listOf("single", "double", "triple")[number - 1], frames { time ->
    (0 until number).sumOf { pulse(time, 1400 + it * (280 + gap)) } to 1.0
  })
  private fun profile(vararg trials: CalibrationTrial): MotionCalibrationProfile {
    val result = LearnedMotionCalibration.fit(trials.flatMap { trial -> List(5) { trial } }, selectedGestures = trials.map { it.gesture })
    assertNotNull(result.message, result.profile)
    recordings[result.profile!!] = trials.associate { trial -> trial.gesture to List(5) { trial.frames.takeWhile { it.timestampMs <= 7720 } } }
    return result.profile!!
  }
  private fun replay(trial: CalibrationTrial, profile: MotionCalibrationProfile, mode: String = "directional", raw: CalibrationReadings = recordings[profile].orEmpty()): List<Event> {
    val events = mutableListOf<Event>(); var now = 0L
    val detector = MotionGestureDetector(mode, { _, _ -> }, { gesture, _ -> events.add(Event(gesture, now)) }, profile, raw)
    for (frame in trial.frames) { now = frame.timestampMs; detector.addSample(frame.x, frame.y, frame.z, now); detector.tick(now) }
    return events
  }
  @Test fun completedFlickDispatchesWithinFourHundredMillisecondsOfSettling() {
    val events = replay(flick(1.13), profile(flick()))
    assertEquals(listOf("right"), events.map { it.gesture })
    assertTrue("Finished at1680; events=$events", events.single().at in 1680..2080)
  }
  @Test fun unrelatedLongPauseDoesNotDelayACompletedMovement() {
    val events = replay(flick(1.09), profile(flick(), tilt(2200)))
    assertEquals(listOf("right"), events.map { it.gesture })
    assertTrue("An unrelated tilt must not impose its pause: $events", events.single().at <= 2080)
  }
  @Test fun restingJitterDoesNotForceTheSixSecondFallbackOrRedispatchItsTail() {
    val jitter = flick(1.08).copy(frames = frames { time -> pulse(time, 1400, 1.08) to (1.0 + if (time % 120 == 0L) .035 else -.035) })
    val events = replay(jitter, profile(flick()))
    assertEquals(listOf("right"), events.map { it.gesture })
    assertTrue("Finished at1680; jitter should settle promptly: $events", events.single().at <= 2160)
  }
  @Test fun aMatchingOutwardPrefixWaitsForTheRecordedTiltContinuation() {
    val events = replay(tilt(1400), profile(tilt(1200), tilt(returnHome = false)))
    assertEquals(listOf("right_straight"), events.map { it.gesture })
    assertTrue("The outward hold ends3200 and return ends3600: $events", events.single().at in 3600..4100)
  }
  @Test fun learnedDoubleAndTripleWithLongPausesDoNotDispatchTheirSinglePrefix() {
    val learned = profile(count(1), count(2), count(3))
    for (number in 2..3) {
      val events = replay(count(number, 1320), learned, "count")
      assertEquals("count=$number events=$events", listOf(listOf("single", "double", "triple")[number - 1]), events.map { it.gesture })
      val end = 1680 + (number - 1) * 1600
      assertTrue("count=$number must finish before dispatch: $events", events.single().at >= end)
    }
  }
  @Test fun mixedLegacyCountsRetainTheExistingSequenceSilence() {
    val events = replay(count(3, 700), profile(count(1)), "count")
    // Any-take matching may assign this full trace to the taught label. The
    // latency change must not turn its first pulse into an early action.
    assertEquals(1, events.size)
    assertTrue(events.single().at >= 1680 + 2 * 980 + 1100)
  }
  @Test fun anUntrainedFlickCannotReplaceThePrefixOfATaughtTwoPartMovement() {
    val sequence = count(2, 1200).copy(gesture = "left_straight")
    val events = replay(sequence, profile(sequence))
    assertEquals(listOf("left_straight"), events.map { it.gesture })
    assertTrue("The second movement must be complete: $events", events.single().at >= 3160)
  }
  @Test fun fastActionResetAndResumeCannotTurnItsOngoingTailIntoAnotherAction() {
    val trial = flick().copy(frames = frames { time ->
      val tail = if (time in 1800..5000) .15 * kotlin.math.sin((time - 1800) * Math.PI / 400) else 0.0
      (pulse(time, 1400) + tail) to 1.0
    })
    val events = mutableListOf<Event>(); var now = 0L; var blockedUntil = 0L; var resuming = false
    lateinit var detector: MotionGestureDetector
    detector = MotionGestureDetector("directional", { _, _ -> }, { gesture, _ ->
      events.add(Event(gesture, now)); detector.reset(); blockedUntil = now + detector.postActionPauseMs; resuming = true
    }, profile(flick()))
    for (frame in trial.frames) {
      now = frame.timestampMs
      if (now < blockedUntil) continue
      if (resuming) { detector.reset(); resuming = false }
      detector.addSample(frame.x, frame.y, frame.z, now); detector.tick(now)
    }
    assertEquals("One movement despite a fast completed action and sensor restart: $events", listOf("right"), events.map { it.gesture })
  }
  @Test fun quietResidualDriftAfterCompletedTiltDoesNotBecomeAnotherTaughtTilt() {
    val original = tilt(400)
    val trial = original.copy(frames = original.frames.map { frame ->
      if (frame.timestampMs in 3000..8000) {
        val angle = .06 * kotlin.math.sin((frame.timestampMs - 3000) * Math.PI / 1000)
        frame.copy(x = kotlin.math.sin(angle), y = kotlin.math.cos(angle))
      } else frame
    })
    val events = replay(trial, profile(original))
    assertEquals("Residual movement belongs to the completed take: $events", listOf("right_straight"), events.map { it.gesture })
  }
  @Test fun freshRestAfterSensorRestartRearmsForASecondSlowMovement() {
    fun slow(time: Long, start: Long): Pair<Double, Double> {
      val elapsed = time - start
      val angle = when { elapsed < 0 -> 0.0; elapsed < 4000 -> elapsed * .35 / 4000; elapsed < 4400 -> .35; elapsed < 5200 -> (5200 - elapsed) * .35 / 800; else -> 0.0 }
      return kotlin.math.sin(angle) to kotlin.math.cos(angle)
    }
    val learned = profile(flick(), CalibrationTrial("right_straight", frames { slow(it, 1400) }))
    val events = mutableListOf<Event>(); var now = 0L; var blockedUntil = 0L; var resuming = false
    lateinit var detector: MotionGestureDetector
    detector = MotionGestureDetector("directional", { _, _ -> }, { gesture, _ ->
      events.add(Event(gesture, now)); detector.reset(); blockedUntil = now + detector.postActionPauseMs; resuming = true
    }, learned, recordings[learned].orEmpty())
    for (frame in frames(14000) { time -> if (time < 4000) pulse(time,1400) to 1.0 else slow(time,5000) }) {
      now = frame.timestampMs
      if (now < blockedUntil) continue
      if (resuming) { detector.reset(); resuming = false }
      detector.addSample(frame.x,frame.y,frame.z,now);detector.tick(now)
    }
    assertEquals("Fresh motion after rest must remain available: $events", listOf("right","right_straight"), events.map { it.gesture })
    assertTrue("Slow movement ends10200: $events", events.last().at in 10200..10700)
  }
  @Test fun longTemplatesWithoutOriginalsKeepTheConservativeEndpointForAllLabels() {
    val learned = profile(flick(),tilt(2200))
    val saved = learned.toJson().toString()
    val fast = replay(flick(1.09), learned)
    val old = replay(flick(1.09), learned, raw = emptyMap())
    assertEquals(fast.map { it.gesture }, old.map { it.gesture })
    assertTrue(fast.single().at <= 2080)
    assertTrue("A competing coarse old template must retain its old pause: $old", old.single().at > 2080)
    assertEquals(saved,learned.toJson().toString())
  }
  @Test fun originalDepthCannotChangePrefixProtectionOrDispatchTiming() {
    val sequence = count(2,1200).copy(gesture="left_straight")
    val learned = profile(flick(),sequence)
    val original = recordings.getValue(learned)
    val changed = original.mapValues { (_, takes) -> takes.map { take -> take.mapIndexed { index, frame -> frame.copy(z=if(index%2==0)1000.0 else -1000.0) } } }
    val motion = sequence.copy(frames=sequence.frames.map { it.copy(x=it.x*1.07,z=Double.NaN) })
    val expected = replay(motion,learned,raw=original)
    assertEquals(listOf("left_straight"),expected.map { it.gesture })
    assertEquals(expected,replay(motion,learned,raw=changed))
    assertTrue(original.values.flatten().flatten().all { it.z==0.0 })
    assertTrue(changed.values.flatten().flatten().all { kotlin.math.abs(it.z)==1000.0 })
  }
  @Test fun freshHandJitterAfterAQuietFirstActionStillAllowsTheNextGesture() {
    val learned=profile(flick());val events=mutableListOf<Event>();var now=0L;var blockedUntil=0L;var resuming=false
    lateinit var detector:MotionGestureDetector
    detector=MotionGestureDetector("directional",{_,_->},{gesture,_->
      events.add(Event(gesture,now));detector.reset();blockedUntil=now+detector.postActionPauseMs;resuming=true
    },learned,recordings[learned].orEmpty())
    for(frame in frames { time->(pulse(time,1400)+pulse(time,5000)) to
      (1.0+if(time>=2400){if(time%80==0L).02 else -.02}else 0.0) }) {
      now=frame.timestampMs;if(now<blockedUntil)continue
      if(resuming){detector.reset();resuming=false}
      detector.addSample(frame.x,frame.y,frame.z,now);detector.tick(now)
    }
    assertEquals("Ordinary hand jitter after the first action must not lock recognition: $events",listOf("right","right"),events.map{it.gesture})
  }
}
