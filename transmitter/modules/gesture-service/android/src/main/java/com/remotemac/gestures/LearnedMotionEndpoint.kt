package com.remotemac.gestures

/** Runtime-only continuation evidence. Saved examples and full-match bounds stay unchanged. */
internal class LearnedMotionEndpoint(models: Map<String, LearnedMotionModel>, recordings: Map<String,List<List<CalibrationFrame>>> = emptyMap()) {
  private data class Continuation(val shape: LearnedMotionTemplate, val pauseMs: Long, val limit: Double)
  val needsOriginalSilence = models.any { (gesture, model) -> model.version >= 2 && model.templates.withIndex().any { (index, template) ->
    recordings[gesture]?.getOrNull(index) == null && template.durationMs >= 2000
  } }
  // A long, coarsely sampled old shape can lose its actual peak. Without its
  // originals there is insufficient evidence to safely accelerate its endpoint.
  private val continuations = models.entries.filter { it.value.version >= 2 }.flatMap { (gesture, model) ->
    model.templates.flatMapIndexed { index, template ->
      val raw = recordings[gesture]?.getOrNull(index)
      if (raw != null && raw.isNotEmpty()) return@flatMapIndexed rawContinuations(raw, model.maxDistance)
      val points = template.points
      val edges = points.zipWithNext().map { (a, b) -> (a - b).length() }
      val result = mutableListOf<Continuation>()
      var start = 0
      while (start < edges.size) {
        if (edges[start] > .04) { start++; continue }
        var end = start
        while (end < edges.size && edges[end] <= .04) end++
        // Only internal pauses with meaningful movement before AND after them
        // can make a completed short example ambiguous with a longer example.
        if (start >= 2 && end < edges.size && end - start >= 2 &&
          points.take(start + 1).any { (it - points.first()).length() > .001 } &&
          points.drop(end + 1).any { (it - points[start]).length() > .15 }) {
          val padding = kotlin.math.ceil(120.0 * 31 / template.durationMs).toInt().coerceAtLeast(1)
          val last = (start + padding).coerceAtMost(end)
          val prefix = points.take(last + 1)
          val peak = prefix.maxOf { it.length() }.coerceAtLeast(.001)
          val resampled = (0 until 32).map { index ->
            val position = index * last / 31.0
            val before = position.toInt(); val after = (before + 1).coerceAtMost(last); val ratio = position - before
            val a = prefix[before]; val b = prefix[after]
            CalibrationVector((a.x + (b.x - a.x) * ratio) / peak, (a.y + (b.y - a.y) * ratio) / peak, 0.0)
          }
          val shape = template.copy(points = resampled, durationMs = (template.durationMs * last / 31).coerceAtLeast(80),
            amplitudeG = template.amplitudeG * peak)
          // Allow natural slower pauses, anchored to the live pause start. A
          // repeated check never extends this budget; the segment is still bounded.
          val pause = ((end - start) * template.durationMs / 31 * 3 / 2 + 320).coerceIn(320, 6500)
          result.add(Continuation(shape, pause, model.maxDistance))
        }
        start = end
      }
      result
    }
  }

  private fun rawContinuations(raw: List<CalibrationFrame>, limit: Double): List<Continuation> {
    val start = raw.first().timestampMs
    val data = raw.map(MotionXY::frame).filter { it.timestampMs - start in 800..7700 }
    if (data.size < 12) return emptyList()
    val initial = data.takeWhile { it.timestampMs - data.first().timestampMs <= 280 }
    val base = LearnedMotionFeatures.median(initial)
    val errors = initial.map { (it.vector() - base).length() }.sorted()
    val noise = errors[(errors.size * .8).toInt().coerceAtMost(errors.lastIndex)]
    val amplitude = data.maxOf { (it.vector() - base).length() }
    val result = mutableListOf<Continuation>()
    var wasQuiet = true
    for (index in 7 until data.size - 1) {
      val now = data[index].timestampMs
      val recent = data.subList(0,index + 1).takeLastWhile { now - it.timestampMs <= 280 }
      if (recent.size < 5 || now - recent.first().timestampMs < 240) continue
      val center = LearnedMotionFeatures.median(recent)
      val residual = recent.map { (it.vector() - center).length() }.sorted()
      val quiet = residual[(residual.size * .8).toInt().coerceAtMost(residual.lastIndex)] <= maxOf(.08, noise * 2) &&
        (recent.first().vector() - recent.last().vector()).length() <= maxOf(.04, noise * 2)
      if (quiet && !wasQuiet) {
        val next = data.drop(index + 1).firstOrNull { (it.vector() - center).length() > maxOf(.08, noise * 3, amplitude * .10) }
        if (next != null) {
          val shape = LearnedMotionFeatures.recording(data.take(index + 1), guided = false)
          if (shape != null) {
            val pause = ((next.timestampMs - recent.first().timestampMs) * 3 / 2 + 320).coerceIn(320,6500)
            result.add(Continuation(shape,pause,limit))
          }
        }
      }
      wasQuiet = quiet
    }
    return result
  }

  fun pending(feature: LearnedMotionTemplate, completedScore: Double, quietForMs: Long): Boolean = continuations.any { continuation ->
    if (quietForMs >= continuation.pauseMs) false
    else {
      val score = LearnedMotionMatcher.distance(feature, continuation.shape) / continuation.limit
      // The same score scale and threshold as a full match. A nearly tied
      // continuation is genuinely ambiguous; unrelated templates cannot delay it.
      score <= 1.0 && score <= completedScore + .08
    }
  }
}
