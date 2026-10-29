package com.remotemac.gestures

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

/** User-labeled Nothing A024 accelerometer captures: right once, then left once.
 * Recorded 2026-10-27; the fixtures contain acceleration and capture timing. */
class MotionGesturePhysicalTraceTest {
  private data class Frame(val time: Double, val x: Double, val y: Double, val z: Double, val wall: String)
  private fun trace(name: String): List<Frame> = javaClass.getResourceAsStream("/motion/$name.csv")!!.bufferedReader().useLines { lines ->
    lines.drop(1).filter { it.isNotBlank() }.map { line ->
      val v = line.split(','); Frame(v[0].toDouble(), v[2].toDouble(), v[3].toDouble(), v[4].toDouble(), v[1])
    }.toList()
  }
  private fun resample(frames: List<Frame>, phase: Int): List<Frame> {
    var next = frames.first().time + phase
    return frames.filter { frame -> if (frame.time < next) false else { while (next <= frame.time) next += 40; true } }
  }
  private fun replay(frames: List<Frame>): List<String> {
    val result = mutableListOf<String>()
    val detector = MotionGestureDetector("directional", { _, _ -> }, { gesture, _ -> result.add(gesture) })
    for (f in frames) detector.addSample(f.x, f.y, f.z, f.time.toLong())
    detector.tick(frames.last().time.toLong() + 1100)
    return result
  }

  @Test fun actualRightAndLeftStaySingleDespiteStrongBrakingAndPostureChanges() {
    for (name in listOf("right", "left")) {
      val frames = trace(name)
      assertEquals("$name raw", listOf(name), replay(frames))
      for (phase in 0..39) assertEquals("$name phase=$phase", listOf(name), replay(resample(frames, phase)))
    }
  }

  @Test fun actualOppositeFlicksCannotMasqueradeAsTiltReturnAtAnySamplingPhase() {
    val right = trace("right").filter { it.wall <= "17:18:01.144" }
    val left = trace("left").filter { it.wall >= "17:18:05.663" }
    for (pause in listOf(250, 500, 800)) {
      val shifted = left.map { it.copy(time = it.time - left.first().time + right.last().time + pause) }
      val rest = (40 until pause step 40).map { right.last().copy(time = right.last().time + it) }
      val compound = right + rest + shifted
      assertEquals("opposite flicks raw pause=$pause", emptyList<String>(), replay(compound))
      for (phase in 0..39) {
        val sampled = resample(compound, phase)
        for ((firstDirection, input) in listOf("right" to sampled, "left" to sampled.map { it.copy(x = -it.x) })) {
          val actions = replay(input)
          // With depth removed some phases can resolve the first single flick;
          // a two-flick trace must still never become a tilt-and-return command.
          assertTrue("pause=$pause phase=$phase actions=$actions", actions.size <= 1 && actions.none { it.endsWith("_straight") })
          assertTrue("A surviving single must be the first flick, not its brake", actions.isEmpty() || actions == listOf(firstDirection))
          if (pause == 800 && phase == 22) assertEquals(listOf(firstDirection), actions)
          assertEquals(actions, replay(input.map { it.copy(z = 0.0) }))
          assertEquals(actions, replay(input.mapIndexed { index, f -> f.copy(z = kotlin.math.sin(index.toDouble()) * 1000) }))
        }
      }
    }
  }
}
