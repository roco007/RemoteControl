package com.remotemac.gestures

/** Banded DTW in XY. Generic v2/v3 models match any one stored example. */
internal object LearnedMotionMatcher {
  fun distance(a:LearnedMotionTemplate,b:LearnedMotionTemplate):Double {
    val generic=a.kind=="motion" || a.kind==MotionXY.KIND
    if((if(generic)b.kind!="motion" && b.kind!=MotionXY.KIND else a.kind!=b.kind) || a.points.size!=32 || b.points.size!=32)return Double.POSITIVE_INFINITY
    if(!generic && (a.polarity!=b.polarity || a.cycles!=b.cycles ||
      a.amplitudeG/b.amplitudeG !in .4..2.5 || a.durationMs.toDouble()/b.durationMs !in .5..2.0))return Double.POSITIVE_INFINITY
    if(generic && (a.amplitudeG<.001 || b.amplitudeG<.001) && kotlin.math.abs(a.amplitudeG-b.amplitudeG)>.02)return Double.POSITIVE_INFINITY
    fun energy(t:LearnedMotionTemplate):CalibrationVector {
      val x=t.points.sumOf{it.x*it.x};val y=t.points.sumOf{it.y*it.y}
      val total=(x+y).coerceAtLeast(.000001)
      return CalibrationVector(kotlin.math.sqrt(x/total),kotlin.math.sqrt(y/total),0.0)
    }
    if(!generic) {
      val ea=energy(a);val eb=energy(b)
      if(ea.length()>.5 && eb.length()>.5 && (ea-eb).length()>.5)return Double.POSITIVE_INFINITY
    }
    val size=32;val band=7
    var previous=DoubleArray(size+1){Double.POSITIVE_INFINITY};previous[0]=0.0
    var previousLength=IntArray(size+1)
    var row=DoubleArray(size+1)
    var lengths=IntArray(size+1)
    val scale=kotlin.math.sqrt(3.0)
    for(i in 1..size) {
      row.fill(Double.POSITIVE_INFINITY);lengths.fill(0)
      val point=a.points[i-1]
      for(j in maxOf(1,i-band)..minOf(size,i+band)) {
        // Preserve minBy's diagonal/up/left order, including the first path on
        // equal costs: its length affects the final normalized score.
        var bestCost=previous[j-1];var bestLength=previousLength[j-1]
        if(previous[j].compareTo(bestCost)<0) { bestCost=previous[j];bestLength=previousLength[j] }
        if(row[j-1].compareTo(bestCost)<0) { bestCost=row[j-1];bestLength=lengths[j-1] }
        val other=b.points[j-1];val dx=point.x-other.x;val dy=point.y-other.y
        // Retain the existing score scale and thresholds; only remove depth.
        row[j]=bestCost+kotlin.math.sqrt(dx*dx+dy*dy)/scale
        lengths[j]=bestLength+1
      }
      val oldPrevious=previous;previous=row;row=oldPrevious
      val oldPreviousLength=previousLength;previousLength=lengths;lengths=oldPreviousLength
    }
    val shape=previous[size]/previousLength[size].coerceAtLeast(1)
    if(!generic)return shape
    val timing=kotlin.math.abs(kotlin.math.ln(a.durationMs.toDouble()/b.durationMs))*.035
    val strength=kotlin.math.abs(kotlin.math.ln(a.amplitudeG.coerceAtLeast(.001)/b.amplitudeG.coerceAtLeast(.001)))*.025
    return shape+timing+strength
  }
  fun match(features:Map<String,LearnedMotionTemplate>,models:Map<String,LearnedMotionModel>):String? {
    val scores=models.mapNotNull{(gesture,model)->
      val extracted=features[if(model.version>=2)"motion" else LearnedMotionFeatures.kind(gesture)]?:return@mapNotNull null
      // Project V1's original point scale identically on both sides of its vote.
      val feature=if(model.version==1)MotionXY.template(extracted)else extracted
      val nearest=model.templates.map{distance(feature,if(model.version==1)MotionXY.template(it)else it)}.sorted()
      if(model.version>=2)nearest.firstOrNull()?.takeIf{it.isFinite()}?.let{Triple(gesture,it/model.maxDistance,it/model.maxDistance)}
      else if(nearest.size<2 || !nearest[1].isFinite())null else Triple(gesture,(nearest[0]+nearest[1])/(2*model.maxDistance),nearest[1]/model.maxDistance)
    }.sortedWith(compareBy<Triple<String,Double,Double>>{it.second}.thenBy{MotionCalibration.ALL_GESTURES.indexOf(it.first)})
    // Qualify legacy support/margin before selection. A legacy candidate which
    // fails its own rules cannot veto an independently matching version2 take.
    return scores.firstOrNull{candidate->
      candidate.third<=1 && (models.getValue(candidate.first).version>=2 ||
        scores.none{other->other.first!=candidate.first && other.second-candidate.second<.18})
    }?.first
  }
}
