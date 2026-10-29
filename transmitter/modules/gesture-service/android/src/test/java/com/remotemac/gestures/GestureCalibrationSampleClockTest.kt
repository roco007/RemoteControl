package com.remotemac.gestures

import org.junit.Assert.*
import org.junit.Test

class GestureCalibrationSampleClockTest {
  @Test fun `fast sensors are bucketed to the same 25Hz capture rate`() {
    val clock = GestureCalibrationSampleClock(1000)
    val accepted = (1000L..5800L step 5).filter(clock::accept)
    assertEquals(121, accepted.size)
    assertTrue(accepted.zipWithNext().all { (a, b) -> b - a == 40L })
  }

  @Test fun `longer one sample capture stays within bounded native buffer`() {
    val clock = GestureCalibrationSampleClock(0)
    val accepted = (0L..7700L step 5).filter(clock::accept)
    assertEquals(193, accepted.size)
    assertTrue(accepted.size <= 220)
  }

  @Test fun `39ms jitter does not cause every other frame to be dropped`() {
    val clock = GestureCalibrationSampleClock(0)
    val accepted = (0L..4800L step 39).filter(clock::accept)
    assertTrue("Expected about 120 frames, got ${accepted.size}", accepted.size in 118..122)
    assertTrue(accepted.zipWithNext().all { (a, b) -> b - a in 15..120 })
  }

  @Test fun `late adjacent buckets cannot create a one millisecond sample gap`() {
    val clock = GestureCalibrationSampleClock(0)
    val accepted = listOf(0L, 79, 80, 81, 95, 120).filter(clock::accept)
    assertEquals(listOf(0L, 79, 95, 120), accepted)
  }

  @Test fun `queued samples before capture and backwards timestamps are ignored`() {
    val clock = GestureCalibrationSampleClock(1000)
    assertFalse(clock.accept(999))
    assertTrue(clock.accept(1000))
    assertFalse(clock.accept(1000))
    assertFalse(clock.accept(900))
    assertTrue(clock.accept(1041))
    assertFalse(clock.accept(1039))
    assertTrue(clock.accept(1080))
  }
}
