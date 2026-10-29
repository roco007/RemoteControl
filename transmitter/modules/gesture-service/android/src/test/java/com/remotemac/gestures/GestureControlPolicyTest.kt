package com.remotemac.gestures

import org.json.JSONObject
import org.junit.Assert.*
import org.junit.Test

class GestureControlPolicyTest {
  private fun configured(background: Boolean = false): GestureControlSnapshot =
    GestureControlPolicy.configure(GestureControlSnapshot(), config(0, true, background))!!

  private fun config(revision: Long, enabled: Boolean, background: Boolean) = GestureConfig.parse(
    JSONObject(GestureProtocolTest.valid).put("enabled", enabled).put("background", background)
      .put("controlRevision", revision).put("backgroundEligible", true).put("mode", "directional")
      .put("mappings", JSONObject().put("left", "lock")).toString())

  @Test fun `initial state does not replace an existing app preference before first configuration`() {
    assertNull(GestureControlSnapshot().state.enabled)
    val next = GestureControlPolicy.configure(GestureControlSnapshot(), config(0, false, true))!!
    assertEquals(false, next.state.enabled)
    assertTrue(next.state.background)
    assertEquals(1L, next.state.revision)
  }

  @Test fun `ordinary off and on retain pairing mappings and foreground only preference`() {
    val initial = configured()
    val off = GestureControlPolicy.setEnabled(initial, false)!!
    assertFalse(off.config!!.enabled)
    assertEquals(initial.config!!.token, off.config.token)
    assertEquals("lock", off.config.actionFor("left"))
    val on = GestureControlPolicy.setEnabled(off, true)!!
    assertTrue(on.config!!.enabled)
    assertFalse(on.config.background)
    assertEquals(off.state.revision + 1, on.state.revision)
  }

  @Test fun `widget on enables background and stale app configure cannot undo any field`() {
    val initial = GestureControlPolicy.setEnabled(configured(), false)!!
    val widget = GestureControlPolicy.setEnabled(initial, true, fromWidget = true)!!
    assertTrue(widget.state.background)
    assertTrue(widget.config!!.background)
    val stale = config(initial.state.revision, false, false)
    stale.json.put("token", "b".repeat(64))
    assertNull(GestureControlPolicy.configure(widget, stale))
    assertEquals(initial.config!!.token, widget.config.token)
    assertEquals("lock", widget.config.actionFor("left"))
  }

  @Test fun `configure cannot reenable disabled master even at current revision`() {
    val off = GestureControlPolicy.setEnabled(configured(), false)!!
    val next = GestureControlPolicy.configure(off, config(off.state.revision, true, false))!!
    assertEquals(false, next.state.enabled)
    assertFalse(next.config!!.enabled)
  }

  @Test fun `explicit background preference change advances revision but configure cannot replace it`() {
    val initial = configured()
    val changed = GestureControlPolicy.setBackgroundEnabled(initial, true)
    assertEquals(initial.state.revision + 1, changed.state.revision)
    assertTrue(changed.config!!.background)
    val same = GestureControlPolicy.configure(changed, config(changed.state.revision, true, false))!!
    assertTrue(same.state.background)
    assertTrue(same.config!!.background)
    assertEquals(changed.state.revision, same.state.revision)
  }

  @Test fun `foreground transition with temporarily missing credentials preserves known pairing`() {
    val initial = configured()
    val incomplete = GestureConfig.parse("""{"enabled":true,"background":false,"controlRevision":${initial.state.revision},"token":"","foregroundReady":false,"mappings":{"left":"screenshot"}}""")
    val next = GestureControlPolicy.configure(initial, incomplete)!!
    assertTrue(next.config!!.canConnect)
    assertEquals(initial.config!!.token, next.config.token)
    assertEquals("screenshot", next.config.actionFor("left"))
    assertFalse(next.config.foregroundReady)
  }

  @Test fun `different selected Mac never inherits prior pairing credentials`() {
    val initial = configured()
    val incoming = GestureConfig.parse("""{"controlRevision":${initial.state.revision},"serverId":"87654321-4321-4321-4321-cba987654321"}""")
    val next = GestureControlPolicy.configure(initial, incoming)!!
    assertFalse(next.config!!.canConnect)
    assertEquals("", next.config.token)
  }

  @Test fun `local profile retains pairing only for same destination and explicit retention`() {
    val initial = configured()
    fun local(host: String = "mac.local", preserve: Boolean = true) = GestureConfig.parse(JSONObject()
      .put("controlRevision", initial.state.revision).put("host", host).put("port", 9876)
      .put("preservePairing", preserve).put("mappings", JSONObject().put("left", org.json.JSONArray()
        .put(JSONObject().put("type", "open_app").put("target", "mobile").put("appId", "com.example.phone")))).toString())
    val retained = GestureControlPolicy.configure(initial, local())!!.config!!
    assertTrue(retained.canConnect)
    assertTrue(retained.hasMobileActions)
    assertFalse(GestureControlPolicy.configure(initial, local("other.local"))!!.config!!.canConnect)
    assertFalse(GestureControlPolicy.configure(initial, local(preserve = false))!!.config!!.canConnect)
  }

  @Test fun `phone only gestures can be enabled from widget without Mac credentials`() {
    val local = GestureConfig.parse("""{"mappings":{"left":[{"type":"open_app","target":"mobile","appId":"com.example.phone"}]}}""")
    val initial = GestureControlPolicy.configure(GestureControlSnapshot(), local)!!
    assertFalse(initial.config!!.canConnect)
    val enabled = GestureControlPolicy.setEnabled(initial, true, fromWidget = true)!!
    assertTrue(enabled.config!!.enabled)
    assertTrue(enabled.config.background)
    assertTrue(enabled.config.hasMobileActions)
  }

  @Test fun `phone URL gestures retain offline widget and revocation behavior`() {
    val local = GestureConfig.parse("""{"backgroundEligible":true,"mappings":{"left":[{"type":"open_url","target":"mobile","url":"https://example.com/phone"}]}}""")
    val initial = GestureControlPolicy.configure(GestureControlSnapshot(), local)!!
    assertTrue(initial.config!!.hasMobileActions)
    assertFalse(initial.config.canConnect)
    val enabled = GestureControlPolicy.setEnabled(initial, true, fromWidget = true)!!
    assertTrue(enabled.config!!.enabled)
    assertTrue(enabled.config.background)
    val revoked = GestureControlPolicy.clearPairing(enabled)
    assertTrue(revoked.config!!.enabled)
    assertTrue(revoked.config.hasMobileActions)
    assertTrue(revoked.config.background)
    assertEquals("https://example.com/phone", revoked.config.actionsFor("left").single().parameters()["url"])
  }

  @Test fun `revoking pairing preserves phone actions and fences stale configuration`() {
    val paired = config(0, true, true)
    paired.json.put("mappings", JSONObject().put("single", org.json.JSONArray()
      .put(JSONObject().put("type", "open_app").put("target", "mobile").put("appId", "com.example.phone"))))
    val initial = GestureControlPolicy.configure(GestureControlSnapshot(), GestureConfig(paired.json))!!
    val revoked = GestureControlPolicy.clearPairing(initial)
    assertTrue(revoked.config!!.enabled)
    assertTrue(revoked.config.hasMobileActions)
    assertFalse(revoked.config.canConnect)
    assertEquals("", revoked.config.token)
    assertEquals("", revoked.config.serverId)
    assertTrue(revoked.config.background)
    assertNull(GestureControlPolicy.configure(revoked, config(initial.state.revision, true, true)))
  }

  @Test fun `disconnect clears credentials and widget cannot resurrect forgotten Mac`() {
    val initial = configured(true)
    val forgotten = GestureControlPolicy.clear(initial)
    assertEquals(false, forgotten.state.enabled)
    assertNull(forgotten.config)
    assertTrue(forgotten.state.revision > initial.state.revision)
    assertNull(GestureControlPolicy.setEnabled(forgotten, true, fromWidget = true))
    assertNull(GestureControlPolicy.configure(forgotten, config(initial.state.revision, true, true)))
  }

  @Test fun `widget off is available even after pairing becomes unavailable`() {
    val unpaired = GestureControlSnapshot(GestureControlState(true, 10, true), null)
    val off = GestureControlPolicy.setEnabled(unpaired, false, fromWidget = true)!!
    assertEquals(false, off.state.enabled)
    assertEquals(11L, off.state.revision)
  }

  @Test fun `Bluetooth eligibility does not erase desired background preference`() {
    val initial = configured(true)
    val bluetooth = config(initial.state.revision, true, false)
    bluetooth.json.put("controlBackground", true).put("backgroundEligible", false)
    val next = GestureControlPolicy.configure(initial, bluetooth)!!
    assertTrue(next.state.background)
    assertFalse(next.config!!.background)
    assertEquals(initial.state.revision, next.state.revision)
    val off = GestureControlPolicy.setEnabled(next, false)!!
    assertFalse(GestureControlPolicy.setEnabled(off, true)!!.config!!.background)
    assertTrue(GestureControlPolicy.setEnabled(off, true, fromWidget = true)!!.config!!.background)
  }

  @Test fun `later background off intent fences earlier configure and leaves master unchanged`() {
    val initial = configured(true)
    val off = GestureControlPolicy.setBackgroundEnabled(initial, false)
    assertEquals(initial.state.enabled, off.state.enabled)
    assertFalse(off.config!!.background)
    assertEquals(initial.config!!.token, off.config.token)
    assertEquals("lock", off.config.actionFor("left"))
    assertNull(GestureControlPolicy.configure(off, config(initial.state.revision, true, true)))
  }

  @Test fun `background setter retains transport eligibility while master is off`() {
    val initial = GestureControlPolicy.setEnabled(configured(), false)!!
    val enabled = GestureControlPolicy.setBackgroundEnabled(initial, true)
    assertEquals(false, enabled.state.enabled)
    assertTrue(enabled.config!!.background)
    val bluetooth = config(enabled.state.revision, false, false)
    bluetooth.json.put("backgroundEligible", false)
    val onBluetooth = GestureControlPolicy.configure(enabled, bluetooth)!!
    val reenabled = GestureControlPolicy.setBackgroundEnabled(GestureControlPolicy.setBackgroundEnabled(onBluetooth, false), true)
    assertTrue(reenabled.state.background)
    assertFalse(reenabled.config!!.background)
  }

  @Test fun `explicit background choice before first pairing is preserved by initialization`() {
    val choice = GestureControlPolicy.setBackgroundEnabled(GestureControlSnapshot(), true)
    assertNull(choice.state.enabled)
    assertEquals(1L, choice.state.revision)
    val initialized = GestureControlPolicy.configure(choice, config(choice.state.revision, false, false))!!
    assertEquals(false, initialized.state.enabled)
    assertTrue(initialized.state.background)
    assertTrue(initialized.config!!.background)
    assertEquals(2L, initialized.state.revision)
  }

  @Test fun `migrated tilt actions survive disabling and widget restart`() {
    val legacy = GestureConfig.parse(JSONObject(GestureProtocolTest.valid).put("controlRevision", 0)
      .put("backgroundEligible", true).put("mappings", JSONObject().put("left_right", "lock").put("right_left", "photo_booth")).toString())
    val initial = GestureControlPolicy.configure(GestureControlSnapshot(), legacy)!!
    val off = GestureControlPolicy.setEnabled(initial, false)!!
    val on = GestureControlPolicy.setEnabled(off, true, fromWidget = true)!!
    assertEquals("lock", on.config!!.actionFor("left_straight"))
    assertEquals("photo_booth", on.config.actionFor("right_straight"))
    assertFalse(on.config.json.getJSONObject("mappings").has("left_right"))
    assertTrue(on.config.canConnect)
    assertEquals(initial.config!!.token, on.config.token)
  }
}
