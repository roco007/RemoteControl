package com.remotemac.gestures

import org.junit.Assert.assertEquals
import org.junit.Test
import java.util.Random
import kotlin.math.*

/** The allocation optimization must preserve even tie-sensitive path lengths and score bits. */
class LearnedMotionMatcherParityTest {
  private fun same(a: LearnedMotionTemplate, b: LearnedMotionTemplate) {
    assertEquals("distance bits for ${a.kind}/${b.kind}, ${a.durationMs}/${b.durationMs}",
      reference(a,b).toBits(), LearnedMotionMatcher.distance(a,b).toBits())
  }
  private fun template(points: List<CalibrationVector>, kind: String = MotionXY.KIND,
    duration: Long = 1200, amplitude: Double = 1.0) = LearnedMotionTemplate(points,duration,amplitude,kind,1,1)

  @Test fun signedTracesAndResampledPrefixesKeepExactScores() {
    val random=Random(0x51A7)
    repeat(240) { iteration ->
      val points=List(32){CalibrationVector(random.nextDouble()*2-1,random.nextDouble()*2-1,random.nextDouble()*8-4)}
      val a=template(points,if(iteration%2==0)"motion" else MotionXY.KIND,80+random.nextInt(6421).toLong(),.15+random.nextDouble()*3)
      val last=3+random.nextInt(28)
      val peak=points.take(last+1).maxOf{it.length()}.coerceAtLeast(.001)
      val prefix=List(32){index->
        val position=index*last/31.0;val before=position.toInt();val after=(before+1).coerceAtMost(last);val ratio=position-before
        val l=points[before];val r=points[after]
        CalibrationVector((l.x+(r.x-l.x)*ratio)/peak,(l.y+(r.y-l.y)*ratio)/peak,0.0)
      }
      val b=a.copy(points=prefix,durationMs=(a.durationMs*last/31).coerceAtLeast(80),amplitudeG=a.amplitudeG*peak)
      same(a,b);same(b,a);same(a,a)
    }
  }

  @Test fun legacyEnergyAndTimingBoundsRemainIdentical() {
    val random=Random(0xA110C)
    for(kind in listOf("flick","tilt","count")) repeat(80) {
      val a=template(List(32){CalibrationVector(random.nextDouble(),random.nextDouble(),0.0)},kind)
      val b=template(List(32){CalibrationVector(random.nextDouble(),random.nextDouble(),100.0)},kind,1000+random.nextInt(400).toLong(),.7+random.nextDouble()*.6)
      same(a,b);same(a,b.copy(polarity=-1));same(a,b.copy(cycles=3));same(a,b.copy(amplitudeG=10.0));same(a,b.copy(durationMs=6500))
    }
  }

  @Test fun plateauTiesThresholdEdgesAndStillExamplesRemainIdentical() {
    val zero=template(List(32){CalibrationVector(0.0,0.0,0.0)})
    for(offset in listOf(0.0,.22*sqrt(3.0)-1e-12,.22*sqrt(3.0),.22*sqrt(3.0)+1e-12,1.0)) {
      same(zero,zero.copy(points=List(32){CalibrationVector(offset,0.0,0.0)}))
    }
    for(period in 2..10) {
      val a=template(List(32){CalibrationVector((it/period%2).toDouble(),0.0,0.0)})
      val b=a.copy(points=List(32){CalibrationVector(((it+1)/period%2).toDouble(),0.0,0.0)})
      same(a,b);same(b,a)
    }
    same(zero.copy(amplitudeG=0.0),zero.copy(amplitudeG=0.0))
    same(zero.copy(amplitudeG=0.0),zero.copy(amplitudeG=.021))
    same(zero,zero.copy(points=zero.points.dropLast(1)))
    same(zero,zero.copy(kind="flick"))
  }

  /** Frozen pre-optimization implementation, deliberately retains its allocating minBy. */
  private fun reference(a:LearnedMotionTemplate,b:LearnedMotionTemplate):Double {
    val generic=a.kind in setOf("motion",MotionXY.KIND)
    if((if(generic)b.kind !in setOf("motion",MotionXY.KIND) else a.kind!=b.kind) || a.points.size!=32 || b.points.size!=32)return Double.POSITIVE_INFINITY
    if(!generic && (a.polarity!=b.polarity || a.cycles!=b.cycles || a.amplitudeG/b.amplitudeG !in .4..2.5 || a.durationMs.toDouble()/b.durationMs !in .5..2.0))return Double.POSITIVE_INFINITY
    if(generic && (a.amplitudeG<.001 || b.amplitudeG<.001) && abs(a.amplitudeG-b.amplitudeG)>.02)return Double.POSITIVE_INFINITY
    fun energy(t:LearnedMotionTemplate):CalibrationVector {
      val x=t.points.sumOf{it.x*it.x};val y=t.points.sumOf{it.y*it.y};val total=(x+y).coerceAtLeast(.000001)
      return CalibrationVector(sqrt(x/total),sqrt(y/total),0.0)
    }
    val ea=energy(a);val eb=energy(b)
    if(!generic && ea.length()>.5 && eb.length()>.5 && (ea-eb).length()>.5)return Double.POSITIVE_INFINITY
    val size=32;val band=7
    var previous=DoubleArray(size+1){Double.POSITIVE_INFINITY};previous[0]=0.0
    var previousLength=IntArray(size+1)
    for(i in 1..size) {
      val row=DoubleArray(size+1){Double.POSITIVE_INFINITY};val lengths=IntArray(size+1)
      for(j in maxOf(1,i-band)..minOf(size,i+band)) {
        val options=listOf(previous[j-1] to previousLength[j-1],previous[j] to previousLength[j],row[j-1] to lengths[j-1])
        val best=options.minBy{it.first}
        row[j]=best.first+(a.points[i-1]-b.points[j-1]).length()/sqrt(3.0);lengths[j]=best.second+1
      }
      previous=row;previousLength=lengths
    }
    val shape=previous[size]/previousLength[size].coerceAtLeast(1)
    if(!generic)return shape
    return shape+abs(ln(a.durationMs.toDouble()/b.durationMs))*.035+abs(ln(a.amplitudeG.coerceAtLeast(.001)/b.amplitudeG.coerceAtLeast(.001)))*.025
  }
}
