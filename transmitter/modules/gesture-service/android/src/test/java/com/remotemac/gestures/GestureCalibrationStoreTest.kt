package com.remotemac.gestures

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class GestureCalibrationStoreTest {
  private class MemoryPersistence : GestureCalibrationPersistence {
    var value: String? = null
    var failWrites = false
    var writes = 0
    override fun read() = value
    override fun write(raw: String?): Boolean {
      writes += 1
      // SharedPreferences may update memory even when the disk commit fails.
      value = raw
      return !failWrites
    }
  }

  private fun profile(left: Double = 1.4): MotionCalibrationProfile = MotionCalibrationProfile.parse(JSONObject("""
    {"version":1,"calibratedAt":1700000000000,"leftThresholdG":$left,"rightThresholdG":1.4,"shakeThresholdG":2.0,
     "sequencePauseMs":1100,"compoundSettleMs":160,"compoundWindowMs":240,"minFlickSpacingMs":280}
  """))!!

  /** Synthetic persistence fixtures only; these are never installed as user training. */
  private fun learnedProfile(version: Int = 1, takes: Int = 10): MotionCalibrationProfile = profile().copy(
    calibratedGestures = GestureCalibrationState.ORDER.toSet(),
    learnedModels = GestureCalibrationState.ORDER.associateWith { gesture ->
      val kind = if (version == 2) "motion" else when (gesture) { "left", "right" -> "flick"; "left_straight", "right_straight" -> "tilt"; else -> "count" }
      val polarity = if (version == 2) 0 else when (gesture) { "left", "right_straight" -> -1; "right", "left_straight" -> 1; else -> 0 }
      val cycles = if (version == 2) 0 else when (gesture) { "left", "right" -> 0; "double" -> 2; "triple" -> 3; else -> 1 }
      LearnedMotionModel(version = version, templates = List(takes) { take ->
        LearnedMotionTemplate(points = List(32) { point ->
          if (version == 2 && take == 0) CalibrationVector(0.0, 0.0, 0.0)
          else CalibrationVector((take + 1) / 16.0 + point / 64.0, point / 128.0, -point / 64.0)
        }, durationMs = 1200L + take * 40, amplitudeG = if (version == 2 && take == 0) 0.0 else 1.0 + take / 16.0,
          kind = kind, polarity = polarity, cycles = cycles)
      }, maxDistance = 0.25)
    })

  @Test fun `saved profile and metadata survive a new store instance`() {
    val persistence = MemoryPersistence()
    val first = GestureCalibrationStore(persistence).save(profile(1.1))
    val loaded = GestureCalibrationStore(persistence).load()
    assertEquals(1L, loaded.revision)
    assertEquals(first.calibratedAt, loaded.calibratedAt)
    assertEquals(1.1, loaded.profile!!.leftThresholdG, 0.00001)
    val replaced = GestureCalibrationStore(persistence).save(profile(1.5))
    assertEquals(2L, replaced.revision)
    assertEquals(1.5, GestureCalibrationStore(persistence).load().profile!!.leftThresholdG, 0.00001)
  }

  @Test fun `failed save restores previous profile even when failed write mutated memory`() {
    val persistence = MemoryPersistence()
    val store = GestureCalibrationStore(persistence)
    store.save(profile(1.1))
    val previous = persistence.value
    persistence.failWrites = true
    try { store.save(profile(1.8)); fail("Save failure must be reported") }
    catch (_: IllegalStateException) { }
    assertEquals(previous, persistence.value)
    assertEquals(1L, store.load().revision)
    assertEquals(1.1, store.load().profile!!.leftThresholdG, 0.00001)
  }

  @Test fun `first failed save leaves no calibration`() {
    val persistence = MemoryPersistence().apply { failWrites = true }
    val store = GestureCalibrationStore(persistence)
    try { store.save(profile()); fail("Save failure must be reported") }
    catch (_: IllegalStateException) { }
    assertNull(persistence.value)
    assertNull(store.load().profile)
    assertNull(store.load().calibratedAt)
  }

  @Test fun `all seventy learned templates survive a new store instance`() {
    val persistence = MemoryPersistence()
    val expected = learnedProfile()
    val first = GestureCalibrationStore(persistence).save(expected)
    val raw = persistence.value!!
    assertTrue("This exercises the old 16 KiB limit", raw.toByteArray(Charsets.UTF_8).size > 16384)
    assertTrue(raw.toByteArray(Charsets.UTF_8).size <= 524288)
    val loaded = GestureCalibrationStore(persistence).load()
    assertEquals(first.calibratedAt, loaded.calibratedAt)
    assertEquals(1L, loaded.revision)
    assertEquals(expected.learnedModels, loaded.profile!!.learnedModels)
    assertEquals(70, loaded.profile!!.learnedModels.values.sumOf { it.templates.size })
  }

  @Test fun `all seventy generic version two takes including still survive reload`() {
    val persistence = MemoryPersistence()
    val expected = learnedProfile(version = 2)
    GestureCalibrationStore(persistence).save(expected)
    val loaded = GestureCalibrationStore(persistence).load().profile!!
    assertEquals(expected, loaded)
    assertEquals(70, loaded.learnedModels.values.sumOf { it.templates.size })
    assertEquals(7, loaded.learnedModels.values.count { it.templates.first().amplitudeG == 0.0 })
    assertTrue(persistence.value!!.toByteArray(Charsets.UTF_8).size < 512 * 1024)
  }

  @Test fun `new thirty five example profile and old ten example model both survive storage`() {
    val persistence = MemoryPersistence(); val store = GestureCalibrationStore(persistence)
    val five = learnedProfile(version = 2, takes = 5)
    store.save(five)
    assertEquals(35, store.load().profile!!.learnedModels.values.sumOf { it.templates.size })
    val oldRight = learnedProfile(version = 2).learnedModels.getValue("right")
    val mixed = five.copy(learnedModels = five.learnedModels + ("right" to oldRight))
    store.save(mixed)
    assertEquals(mixed, GestureCalibrationStore(persistence).load().profile)
    assertEquals(10, store.load().profile!!.learnedModels.getValue("right").templates.size)
  }

  @Test fun `version two retrain commits only after save while preserving unrelated version one models`() {
    val persistence = MemoryPersistence()
    val store = GestureCalibrationStore(persistence)
    val original = learnedProfile().copy(leftThresholdG = 0.85, rightThresholdG = 1.6)
    store.save(original)
    val replacement = original.copy(learnedModels = original.learnedModels +
      ("left" to learnedProfile(version = 2, takes = 5).learnedModels.getValue("left")))
    persistence.failWrites = true
    try { store.save(replacement); fail("Failed save must keep the previous profile") }
    catch (_: IllegalStateException) { }
    assertEquals(original, store.load().profile)
    assertEquals(1L, store.load().revision)
    persistence.failWrites = false
    store.save(replacement)
    val loaded = GestureCalibrationStore(persistence).load()
    assertEquals(2L, loaded.revision)
    assertEquals(replacement, loaded.profile)
    assertEquals(original.learnedModels.getValue("right"), loaded.profile!!.learnedModels.getValue("right"))
  }

  @Test fun `failed learned replacement restores every saved model and revision`() {
    val persistence = MemoryPersistence()
    val store = GestureCalibrationStore(persistence)
    val expected = learnedProfile()
    store.save(expected)
    val previous = persistence.value
    persistence.failWrites = true
    try { store.save(expected.copy(learnedModels = expected.learnedModels - "left")); fail("Save failure must be reported") }
    catch (_: IllegalStateException) { }
    assertEquals(previous, persistence.value)
    val loaded = GestureCalibrationStore(persistence).load()
    assertEquals(1L, loaded.revision)
    assertEquals(expected.learnedModels, loaded.profile!!.learnedModels)
  }

  @Test fun `malformed learned models invalidate a saved record without partial loading`() {
    val valid = SavedGestureCalibration(learnedProfile(), 1700000000000, 7).toJson()
    for (malformed in listOf<Any>("bad", 3, JSONObject().put("unknown", JSONObject()))) {
      val invalid = JSONObject(valid.toString())
      invalid.getJSONObject("profile").put("learnedModels", malformed)
      val loaded = SavedGestureCalibration.parse(invalid.toString())
      assertNull(loaded.profile)
      assertNull(loaded.calibratedAt)
      assertEquals(7L, loaded.revision)
    }
  }

  @Test fun `oversized learned model cannot overwrite a saved profile`() {
    val persistence = MemoryPersistence()
    val store = GestureCalibrationStore(persistence)
    val expected = learnedProfile()
    store.save(expected)
    val previous = persistence.value
    val writes = persistence.writes
    val left = expected.learnedModels.getValue("left")
    val oversized = expected.copy(learnedModels = mapOf("left" to left.copy(templates = List(1000) { left.templates.first() })))
    try { store.save(oversized); fail("Oversized models must be rejected before persistence") }
    catch (_: Exception) { }
    assertEquals(previous, persistence.value)
    assertEquals(writes, persistence.writes)
    assertEquals(expected.learnedModels, store.load().profile!!.learnedModels)
    assertEquals(1L, store.load().revision)
  }

  @Test fun `corrupted or unsupported records use defaults instead of a partial profile`() {
    for (raw in listOf<String?>(null, "not json", "x".repeat(2097153), "{}")) assertNull(SavedGestureCalibration.parse(raw).profile)
    val valid = SavedGestureCalibration(profile(), 1700000000000, 7).toJson()
    for ((key, value) in listOf("version" to 2, "version" to 1.5, "calibratedAt" to -1, "calibratedAt" to "NaN", "revision" to 1.5, "revision" to "Infinity")) {
      val invalid = JSONObject(valid.toString()).put(key, value)
      assertNull(SavedGestureCalibration.parse(invalid.toString()).profile)
    }
    for ((key, value) in listOf("leftThresholdG" to 99, "rightThresholdG" to "NaN", "shakeThresholdG" to "Infinity", "sequencePauseMs" to 1)) {
      val invalid = JSONObject(valid.toString())
      invalid.getJSONObject("profile").put(key, value)
      val loaded = SavedGestureCalibration.parse(invalid.toString())
      assertNull("$key=$value", loaded.profile)
      assertNull(loaded.calibratedAt)
      assertEquals(7L, loaded.revision)
    }
  }

  @Test fun `bounded larger records remain readable and limit uses utf8 bytes`() {
    val valid = SavedGestureCalibration(profile(), 1700000000000, 7).toJson()
    val larger = JSONObject(valid.toString()).put("padding", "x".repeat(20000)).toString()
    assertNotNull(SavedGestureCalibration.parse(larger).profile)
    // Build valid raw JSON directly: JSONObject's writer escapes this character,
    // which would otherwise test the character limit instead of UTF-8 bytes.
    val tooManyBytes = valid.toString().dropLast(1) + ",\"padding\":\"" + "\u20ac".repeat(700000) + "\"}"
    assertTrue(tooManyBytes.length < 2097152)
    assertTrue(tooManyBytes.toByteArray(Charsets.UTF_8).size > 2097152)
    assertNull(SavedGestureCalibration.parse(tooManyBytes).profile)
  }

  @Test fun `profile that cannot reload cannot replace a previously saved profile`() {
    val persistence = MemoryPersistence()
    val store = GestureCalibrationStore(persistence)
    store.save(profile(1.1))
    val previous = persistence.value
    val writes = persistence.writes
    // The public profile constructor accepts this Long, but the versioned JSON
    // decoder correctly rejects it outside the exact integer range.
    val unroundtrippable = profile(1.1).copy(calibratedAt = Long.MAX_VALUE)
    try { store.save(unroundtrippable); fail("Unreloadable data must not be persisted") }
    catch (_: IllegalStateException) { }
    assertEquals(previous, persistence.value)
    assertEquals(writes, persistence.writes)
    assertEquals(1L, store.load().revision)
  }
}
