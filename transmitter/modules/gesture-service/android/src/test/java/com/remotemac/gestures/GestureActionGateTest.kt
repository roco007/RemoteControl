package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test
import org.json.JSONObject

class GestureActionGateTest {
  @Test fun `one action blocks all subsequent gestures and disabled mappings acquire nothing`() {
    val gate = GestureActionGate()
    assertNull(gate.acquire("disabled", "none", "foreground"))
    assertNotNull(gate.acquire("first", "lock", "foreground"))
    assertNull(gate.acquire("second", "screenshot", "background"))
    assertEquals("first", gate.pending!!.id)
  }

  @Test fun `only a matching owner id and action can finish the operation`() {
    val gate = GestureActionGate(); gate.acquire("first", "lock", "background")
    assertFalse(gate.update("stale", "success", "background", "lock"))
    assertFalse(gate.update("first", "success", "foreground", "lock"))
    assertFalse(gate.update("first", "success", "background", "screenshot"))
    assertNotNull(gate.pending)
    assertTrue(gate.update("first", "failed", "background", "lock"))
    assertNull(gate.pending)
    assertFalse(gate.update("first", "success", "background", "lock"))
  }

  @Test fun `disconnect or timeout remains blocked until a matching terminal result`() {
    val gate = GestureActionGate(); gate.acquire("first", "photo_booth", "foreground")
    assertTrue(gate.update("first", "unknown"))
    assertEquals("unknown", gate.pending!!.state)
    assertNull(gate.acquire("second", "lock", "foreground"))
    assertTrue(gate.update("first", "running", "foreground"))
    assertEquals("running", gate.pending!!.state)
    assertFalse(gate.recover("first"))
    assertTrue(gate.update("first", "success", "foreground"))
    assertNotNull(gate.acquire("second", "lock", "foreground"))
  }

  @Test fun `only explicit recovery of the current unknown token releases it`() {
    val gate = GestureActionGate(); gate.acquire("first", "screenshot", "foreground")
    gate.update("first", "unknown")
    assertFalse(gate.recover("old"))
    assertTrue(gate.recover("first"))
    gate.acquire("second", "lock", "background")
    assertFalse(gate.recover("first"))
    assertEquals("second", gate.pending!!.id)
  }

  @Test fun `not sent safely releases but invalid outcomes cannot unlock`() {
    val gate = GestureActionGate(); gate.acquire("first", "kill_app", "foreground")
    assertFalse(gate.update("first", "cancelled"))
    assertTrue(gate.update("first", "not_sent", "foreground"))
    assertNull(gate.pending)
  }

  @Test fun `restored operations stay unknown and owner transfer preserves identity`() {
    val gate = GestureActionGate()
    gate.restore(GestureActionOperation("first", "lock", "background", "server", "device"))
    assertEquals("unknown", gate.pending!!.state)
    assertTrue(gate.transfer("first", "foreground"))
    assertEquals("server", gate.pending!!.serverId)
    assertEquals("device", gate.pending!!.deviceId)
    assertFalse(gate.update("first", "success", "background"))
    assertTrue(gate.update("first", "failed", "foreground"))
  }

  @Test fun `samples queued before action completion and old ticks cannot enter resumed detector`() {
    val lease = GestureSensorLease()
    val before = lease.start(1000)
    assertTrue(lease.accepts(1100))
    lease.stop()
    assertFalse(lease.accepts(1200))
    val after = lease.start(2000)
    assertFalse(lease.accepts(1500))
    assertFalse(lease.isCurrent(before))
    assertTrue(lease.isCurrent(after))
    assertTrue(lease.accepts(2001))
    lease.stop()
    assertFalse(lease.isCurrent(after))
  }

  @Test fun `persisted correlation restores uncertain without storing credentials or replay data`() {
    val original = GestureActionOperation("operation", "photo_booth", "background", "server-id", "device-id")
    val raw = original.toJson()
    assertEquals(original, GestureActionOperation.parse(raw))
    val restored = GestureActionGate()
    restored.restore(GestureActionOperation.parse(raw)!!)
    assertEquals(original.copy(state = "unknown"), restored.pending)
    assertNull(restored.acquire("new", "lock", "foreground"))
    assertFalse(JSONObject(raw).has("token"))
    assertFalse(JSONObject(raw).has("frames"))
  }

  @Test fun `gesture correlation survives persistence restoration and owner transfer`() {
    val raw = JSONObject(GestureActionOperation("operation", "lock", "background", "server", "device").toJson())
      .put("gesture", "left_straight").toString()
    val parsed = GestureActionOperation.parse(raw)
    assertNotNull(parsed)
    assertEquals("left_straight", JSONObject(parsed!!.toJson()).getString("gesture"))
    val gate = GestureActionGate()
    gate.restore(parsed)
    assertEquals("unknown", gate.pending!!.state)
    assertTrue(gate.transfer("operation", "foreground"))
    assertEquals("left_straight", JSONObject(gate.pending!!.toJson()).getString("gesture"))
    assertTrue(gate.update("operation", "running", "foreground"))
    assertEquals("left_straight", JSONObject(gate.pending!!.toJson()).getString("gesture"))
    assertTrue(gate.update("operation", "success", "foreground"))
    assertNull(gate.pending)
  }

  @Test fun `saved canonical gestures load while absent legacy correlation remains valid`() {
    val legacy = """{"version":1,"id":"old","action":"lock","owner":"background","serverId":"server","deviceId":"device","state":"running"}"""
    val parsedLegacy = GestureActionOperation.parse(legacy)
    assertNotNull(parsedLegacy)
    assertFalse(JSONObject(parsedLegacy!!.toJson()).has("gesture"))
    for (gesture in listOf("single", "double", "triple", "left", "right", "left_straight", "right_straight")) {
      val parsed = GestureActionOperation.parse(JSONObject(legacy).put("gesture", gesture).toString())
      assertNotNull(gesture, parsed)
      assertEquals(gesture, JSONObject(parsed!!.toJson()).getString("gesture"))
    }
    for (gesture in listOf("", "left_right", "right_left", "Left", "other", 1, JSONObject.NULL)) {
      assertNull(gesture.toString(), GestureActionOperation.parse(JSONObject(legacy).put("gesture", gesture).toString()))
    }
  }

  @Test fun `admission retains valid gesture identity and rejects unknown gesture ids`() {
    for (gesture in listOf("single", "double", "triple", "left", "right", "left_straight", "right_straight")) {
      val gate = GestureActionGate()
      val operation = gate.acquire("operation", "lock", "background", gesture = gesture)
      assertEquals(gesture, operation!!.gesture)
      assertEquals(gesture, GestureActionOperation.parse(operation.toJson())!!.gesture)
    }
    for (gesture in listOf("", "left_right", "right_left", "Left", "other")) {
      val gate = GestureActionGate()
      assertNull(gesture, gate.acquire("operation", "lock", "background", gesture = gesture))
      assertNull(gate.pending)
    }
  }

  @Test fun `malformed persisted operations never become runnable or unbounded`() {
    val original = GestureActionOperation("operation", "lock", "foreground").toJson()
    for ((key, value) in listOf("version" to 2, "id" to "", "id" to "a".repeat(65), "action" to "none",
      "owner" to "unknown", "state" to "completed", "serverId" to "s".repeat(65), "token" to "secret")) {
      assertNull("$key=$value", GestureActionOperation.parse(JSONObject(original).put(key, value).toString()))
    }
    assertNull(GestureActionOperation.parse("x".repeat(2049)))
  }

  @Test fun `action revisions fence stale idle replies and survive restoration`() {
    val gate = GestureActionGate()
    gate.restoreRevision(40)
    val idleRevision = gate.revision
    gate.acquire("first", "lock", "foreground")
    assertTrue(gate.revision > idleRevision)
    val acquired = gate.revision
    assertFalse(gate.update("old", "success"))
    assertEquals(acquired, gate.revision)
    gate.update("first", "unknown")
    assertTrue(gate.revision > acquired)
    val pending = gate.pending!!; val savedRevision = gate.revision
    val restored = GestureActionGate()
    restored.restoreRevision(savedRevision); restored.restore(pending)
    assertTrue(restored.revision > savedRevision)
    val beforeRelease = restored.revision
    restored.update("first", "failed", "foreground")
    assertTrue(restored.revision > beforeRelease)
    assertNull(restored.pending)
  }

  @Test fun `confirmed running actions never expire but unanswered queries are bounded`() {
    val budget = GestureActionPollBudget()
    repeat(200) { assertTrue(budget.tryQuery()); budget.reset() }
    repeat(30) { assertTrue(budget.tryQuery()) }
    assertFalse(budget.tryQuery())
    budget.reset()
    assertTrue(budget.tryQuery())
  }

  @Test fun `matching running heartbeat does not mutate or publish a new action revision`() {
    val gate = GestureActionGate(); gate.acquire("first", "lock", "foreground")
    val revision = gate.revision
    assertTrue(gate.runningHeartbeat("first", "foreground"))
    assertEquals(revision, gate.revision)
    assertFalse(gate.runningHeartbeat("old", "foreground"))
    assertFalse(gate.runningHeartbeat("first", "background"))
    gate.update("first", "unknown")
    assertFalse(gate.runningHeartbeat("first", "foreground"))
    val unknownRevision = gate.revision
    gate.update("first", "running", "foreground")
    assertTrue(gate.revision > unknownRevision)
    assertTrue(gate.runningHeartbeat("first", "foreground"))
  }

  @Test fun `confirmed heartbeat refreshes expiry and stale watchdog callbacks cannot expire it`() {
    val watchdog = GestureActionWatchdog()
    watchdog.restart("first", 0)
    assertFalse(watchdog.expired("first", 59000))
    watchdog.restart("first", 45000)
    assertFalse(watchdog.expired("first", 60000))
    assertFalse(watchdog.expired("old", 200000))
    assertTrue(watchdog.expired("first", 105000))
    watchdog.clear()
    assertFalse(watchdog.expired("first", 200000))
  }

  @Test fun `fast action completion cannot discard original recoil debounce`() {
    for (duration in listOf(700L, 1000L)) {
      val pause = GesturePostActionPause()
      val gate = GestureActionGate()
      val lease = GestureSensorLease()
      lease.start(900_000_000)
      gate.acquire("first", "screenshot", "foreground")
      pause.record(1000, duration)
      lease.stop()
      gate.update("first", "success", "foreground")
      assertNull(gate.pending)
      assertEquals(duration - 10, pause.remaining(1010))
      assertFalse(lease.accepts(1_010_000_000))
      assertEquals(0L, pause.remaining(1000 + duration))
      lease.start((1000 + duration) * 1_000_000)
      assertFalse(lease.accepts(1_010_000_000))
      assertTrue(lease.accepts((1001 + duration) * 1_000_000))
    }
  }

  @Test fun `long action remains blocked after debounce expires`() {
    val pause = GesturePostActionPause(); val gate = GestureActionGate()
    gate.acquire("first", "lock", "foreground"); pause.record(1000, 1000)
    assertEquals(0L, pause.remaining(5000))
    assertNull(gate.acquire("second", "screenshot", "foreground"))
    gate.update("first", "failed", "foreground")
    assertEquals(0L, pause.remaining(5000))
    assertNotNull(gate.acquire("second", "screenshot", "foreground"))
  }
}
