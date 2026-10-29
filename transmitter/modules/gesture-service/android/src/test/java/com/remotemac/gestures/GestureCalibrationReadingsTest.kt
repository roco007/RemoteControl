package com.remotemac.gestures

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class GestureCalibrationReadingsTest {
  private class MemoryPersistence : GestureCalibrationPersistence {
    var value: String? = null
    var failWrites = false
    var writes = 0
    override fun read() = value
    override fun write(raw: String?): Boolean { writes++; value = raw; return !failWrites }
  }

  private fun model(takes: Int = 5, version: Int = 2) = LearnedMotionModel(version,
    List(takes) { take -> LearnedMotionTemplate(List(32) { CalibrationVector(take / 10.0, 0.0, -0.25) },
      400 + take * 40L, 0.5 + take / 10.0, if (version == 2) "motion" else "flick", if (version == 2) 0 else 1, 0) }, 0.22)
  private fun profile(vararg gestures: String) = MotionCalibrationProfile(calibratedAt = 1700000000000,
    calibratedGestures = gestures.toSet(), learnedModels = gestures.associateWith { model() })
  private fun frames(offset: Long = 10000, x: Double = 0.12345678901234568) = listOf(
    CalibrationFrame(x, 1.0, -0.05, offset), CalibrationFrame(-x, 0.95, 0.05, offset + 40),
    CalibrationFrame(30.123456789012344, 0.9, 0.07, offset + 1200), CalibrationFrame(x, 1.0, -0.05, offset + 7800))
  private fun trials(gesture: String, takes: Int = 5, x: Double = 0.12345678901234568) =
    List(takes) { CalibrationTrial(gesture, frames(10000 + it * 20000L, x)) }
  private fun json(value: Map<String, Any?>) = JSONObject(value)
  private fun savedRead(gesture: String, saved: SavedGestureCalibration) =
    json(GestureCalibrationReadings.read(gesture, null, GestureCalibrationState(), emptyList(), saved))

  @Test fun `new saved takes retain exact full capture including preparation and late timer tail`() {
    val persistence = MemoryPersistence()
    GestureCalibrationStore(persistence).save(profile("left"), trials("left"))
    val loaded = GestureCalibrationStore(persistence).load()
    assertEquals(5, loaded.readings.getValue("left").size)
    val take = loaded.readings.getValue("left").first()
    assertEquals(listOf(0L, 40L, 1200L, 7800L), take.map { it.timestampMs })
    assertEquals(0.12345678901234568, take.first().x, 0.0)
    assertEquals(30.123456789012344, take[2].x, 0.0)
    assertEquals(frames().map { it.copy(timestampMs = it.timestampMs - 10000) }, take)
    val result = savedRead("left", loaded)
    assertEquals("saved", result.getString("source"))
    assertTrue(result.isNull("sessionId"))
    assertEquals(1L, result.getLong("profileRevision"))
    assertEquals(1200, result.getInt("preparationMs"))
    assertEquals(listOf("x", "y"), (0..1).map { result.getJSONArray("recognitionAxes").getString(it) })
    val first = result.getJSONArray("takes").getJSONObject(0)
    assertEquals(1, first.getInt("take"))
    assertEquals(1.0, first.getJSONArray("raw").getJSONObject(0).getDouble("y"), 0.0)
    assertEquals(-0.05, first.getJSONArray("raw").getJSONObject(0).getDouble("z"), 0.0)
    assertEquals(0.07, first.getJSONArray("raw").getJSONObject(2).getDouble("z"), 0.0)
    assertEquals(7800L, first.getJSONArray("raw").getJSONObject(3).getLong("timeMs"))
    assertEquals(32, first.getJSONObject("template").getJSONArray("points").length())
    assertEquals(3, first.getJSONObject("template").getInt("modelVersion"))
    assertEquals(2, first.getJSONObject("template").getInt("storedModelVersion"))
    assertEquals("raw_rebuilt", first.getJSONObject("template").getString("source"))
    assertTrue((0 until 32).all { first.getJSONObject("template").getJSONArray("points").getJSONObject(it).getDouble("z") == 0.0 })
    assertEquals(0.22, first.getJSONObject("template").getDouble("maxDistance"), 0.0)
    // Only the 1200ms frame is in this fixture's existing guided capture window.
    // Its effective shape is still; the archived model and full timer tail remain intact.
    assertEquals(80L, first.getJSONObject("template").getLong("durationMs"))
    assertEquals(2, loaded.profile!!.learnedModels.getValue("left").version)
    assertEquals(400L, loaded.profile!!.learnedModels.getValue("left").templates.first().durationMs)
    assertEquals(-0.25, loaded.profile!!.learnedModels.getValue("left").templates.first().points.first().z, 0.0)
  }

  @Test fun `older ten example models expose only templates without invented raw samples`() {
    for (version in listOf(1, 2)) {
      val oldProfile = profile("right").copy(learnedModels = mapOf("right" to model(10, version)))
      val oldJson = SavedGestureCalibration(oldProfile, 1700000000000, 3).toJson().apply { remove("readings") }
      val old = SavedGestureCalibration.parse(oldJson.toString())
      val takes = savedRead("right", old).getJSONArray("takes")
      assertEquals(10, takes.length())
      assertEquals(10, takes.getJSONObject(9).getInt("take"))
      assertTrue(takes.getJSONObject(9).isNull("raw"))
      val template = takes.getJSONObject(9).getJSONObject("template")
      assertEquals(if (version == 1) 1 else 3, template.getInt("modelVersion"))
      assertEquals(version, template.getInt("storedModelVersion"))
      assertEquals("projected", template.getString("source"))
      assertTrue((0 until 32).all { template.getJSONArray("points").getJSONObject(it).getDouble("z") == 0.0 })
      assertEquals(version, old.profile!!.learnedModels.getValue("right").version)
    }
    assertEquals(0, savedRead("left", SavedGestureCalibration()).getJSONArray("takes").length())
  }

  @Test fun `draft read returns only requested accepted takes without changing active capture`() {
    val state = GestureCalibrationState().apply { begin("current"); startCapture(); advanceCapture(1500) }
    val recorded = (trials("left").take(2) + trials("right").take(1)).toMutableList()
    val before = listOf(state.sessionId, state.active, state.phase, state.accepted, state.remainingMs, state.message)
    val result = json(GestureCalibrationReadings.read("left", "current", state, recorded, SavedGestureCalibration(revision = 9)))
    assertEquals("draft", result.getString("source"))
    assertEquals("current", result.getString("sessionId"))
    assertEquals(2, result.getJSONArray("takes").length())
    assertEquals(9L, result.getLong("profileRevision"))
    assertEquals(0L, result.getJSONArray("takes").getJSONObject(0).getJSONArray("raw").getJSONObject(0).getLong("timeMs"))
    val template = result.getJSONArray("takes").getJSONObject(0).getJSONObject("template")
    assertEquals(3, template.getInt("modelVersion"))
    assertEquals("draft", template.getString("source"))
    assertTrue(template.isNull("storedModelVersion"))
    assertTrue((0 until 32).all { template.getJSONArray("points").getJSONObject(it).getDouble("z") == 0.0 })
    assertEquals(before, listOf(state.sessionId, state.active, state.phase, state.accepted, state.remainingMs, state.message))
    assertEquals(3, recorded.size)
    assertEquals(0, json(GestureCalibrationReadings.read("triple", "current", state, recorded, SavedGestureCalibration())).getJSONArray("takes").length())
  }

  @Test fun `draft session fence rejects stale canceled and invalid requests without exposing saved data`() {
    val state = GestureCalibrationState().apply { begin("current", "left") }
    val saved = SavedGestureCalibration(profile("left"), 1700000000000, 1)
    for ((gesture, id) in listOf("left" to "old", "left" to "", "obsolete" to "current")) {
      assertThrows(Exception::class.java) { GestureCalibrationReadings.read(gesture, id, state, trials("left"), saved) }
    }
    state.interrupt()
    assertEquals(5, json(GestureCalibrationReadings.read("left", "current", state, trials("left"), saved)).getJSONArray("takes").length())
    state.end("Canceled")
    assertThrows(Exception::class.java) { GestureCalibrationReadings.read("left", "current", state, trials("left"), saved) }
  }

  @Test fun `targeted save replaces readings wholesale and preserves unrelated models and originals`() {
    val persistence = MemoryPersistence(); val store = GestureCalibrationStore(persistence)
    val original = profile("left", "right").copy(leftThresholdG = 0.85)
    val first = store.save(original, trials("left") + trials("right"))
    val nextProfile = original.copy(learnedModels = original.learnedModels + ("left" to model().copy(maxDistance = 0.23)))
    val next = store.save(nextProfile, trials("left", x = -3.987654321098765))
    assertEquals(first.readings.getValue("right"), next.readings.getValue("right"))
    assertEquals(-3.987654321098765, next.readings.getValue("left").first().first().x, 0.0)
    assertEquals(5, next.readings.getValue("left").size)
    assertEquals(original.learnedModels.getValue("right"), next.profile!!.learnedModels.getValue("right"))
    assertEquals(0.85, next.profile!!.leftThresholdG, 0.0)
    assertEquals(2L, next.revision)
    val changed = nextProfile.copy(learnedModels = nextProfile.learnedModels + ("left" to model().copy(maxDistance = 0.24)))
    val templateOnly = store.save(changed)
    assertFalse(templateOnly.readings.containsKey("left"))
    assertEquals(first.readings.getValue("right"), templateOnly.readings.getValue("right"))
  }

  @Test fun `failed save restores profile and readings together`() {
    val persistence = MemoryPersistence(); val store = GestureCalibrationStore(persistence)
    val original = store.save(profile("left"), trials("left"))
    val bytes = persistence.value
    persistence.failWrites = true
    assertThrows(IllegalStateException::class.java) { store.save(profile("left"), trials("left", x = -2.5)) }
    assertEquals(bytes, persistence.value)
    assertEquals(original, GestureCalibrationStore(persistence).load())
    assertTrue(store.load().readings.isNotEmpty())
  }

  @Test fun `compact archive rejects malformed sample counts times values labels and model mismatch`() {
    val persistence = MemoryPersistence(); val store = GestureCalibrationStore(persistence)
    store.save(profile("left"), trials("left"))
    val original = JSONObject(persistence.value!!)
    val readings = original.getJSONObject("readings")
    assertEquals(4, readings.getJSONArray("left").getJSONArray(0).getJSONArray(0).length())
    val mutations: List<(JSONObject) -> Unit> = listOf(
      { it.put("unknown", it.getJSONArray("left")) },
      { it.put("right", it.getJSONArray("left")) },
      { it.put("left", JSONArray().put(it.getJSONArray("left").getJSONArray(0))) },
      { it.getJSONArray("left").put(0, JSONArray()) },
      { it.getJSONArray("left").put(0, JSONArray(List(221) { n -> listOf(n, 0, 1, 0) })) },
      { it.getJSONArray("left").getJSONArray(0).getJSONArray(0).put(0, 1) },
      { it.getJSONArray("left").getJSONArray(0).getJSONArray(1).put(0, 0) },
      { it.getJSONArray("left").getJSONArray(0).getJSONArray(1).put(0, 0.5) },
      { it.getJSONArray("left").getJSONArray(0).getJSONArray(1).put(1, "NaN") },
      { it.getJSONArray("left").getJSONArray(0).getJSONArray(1).put(2, "1.0") },
    )
    for (mutate in mutations) {
      val invalid = JSONObject(original.toString())
      mutate(invalid.getJSONObject("readings"))
      val parsed = SavedGestureCalibration.parse(invalid.toString())
      assertNull(parsed.profile)
      assertTrue(parsed.readings.isEmpty())
      assertEquals(1L, parsed.revision)
    }
    for (malformed in listOf(JSONObject.NULL, JSONArray(), "bad", 7)) {
      val invalid = JSONObject(original.toString()).put("readings", malformed)
      assertNull(SavedGestureCalibration.parse(invalid.toString()).profile)
    }
  }

  @Test fun `invalid archive cannot overwrite prior originals`() {
    val persistence = MemoryPersistence(); val store = GestureCalibrationStore(persistence)
    store.save(profile("left"), trials("left"))
    val before = persistence.value; val writes = persistence.writes
    val invalid = listOf(
      trials("left").take(4), trials("unknown"),
      List(5) { CalibrationTrial("left", List(221) { n -> CalibrationFrame(0.0, 1.0, 0.0, n.toLong()) }) },
      List(5) { CalibrationTrial("left", listOf(CalibrationFrame(Double.NaN, 1.0, 0.0, 0))) },
    )
    for (takes in invalid) assertThrows(Exception::class.java) { store.save(profile("left"), takes) }
    assertEquals(before, persistence.value)
    assertEquals(writes, persistence.writes)
  }

  @Test fun `maximum archive preserves all seventy full precision takes without truncation`() {
    val persistence = MemoryPersistence(); val store = GestureCalibrationStore(persistence)
    val largestModel = model(10).copy(templates = List(10) {
      LearnedMotionTemplate(List(32) { CalibrationVector(-3.9999999999999996, -3.9999999999999996, -3.9999999999999996) },
        6500, 11.999999999999998, "motion", 0, 0)
    }, maxDistance = 0.21999999999999997)
    val maximumProfile = profile(*GestureCalibrationState.ORDER.toTypedArray()).copy(
      learnedModels = GestureCalibrationState.ORDER.associateWith { largestModel })
    val extremeFrames = List(220) { n -> CalibrationFrame(-Double.MAX_VALUE, Double.MAX_VALUE,
      -Double.MAX_VALUE, if (n == 0) 0 else 9_007_199_254_740_771L + n) }
    val all = GestureCalibrationState.ORDER.flatMap { gesture -> List(10) { CalibrationTrial(gesture, extremeFrames) } }
    store.save(maximumProfile, all)
    val bytes = persistence.value!!.toByteArray(Charsets.UTF_8).size
    assertTrue("Fixture must exceed the old limit: $bytes", bytes > 512 * 1024)
    assertTrue("Bounded maximum must fit: $bytes", bytes <= 2 * 1024 * 1024)
    val loaded = GestureCalibrationStore(persistence).load()
    assertEquals(70, loaded.readings.values.sumOf { it.size })
    assertEquals(15400, loaded.readings.values.sumOf { takes -> takes.sumOf { it.size } })
    assertEquals(extremeFrames, loaded.readings.getValue("triple").last())
    assertEquals(maximumProfile, loaded.profile)
    println("Maximum bounded calibration archive: $bytes bytes, 70 takes and 15400 original samples")
  }
}
