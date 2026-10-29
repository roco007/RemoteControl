package com.remotemac.gestures

import kotlin.math.abs
import kotlin.math.atan2
import kotlin.math.max
import kotlin.math.sqrt

// Recognition is the phone's upright XY plane. Original XYZ values are retained
// only by the recording/archive path, never by feature or segment calculations.
internal fun CalibrationVector.length() = sqrt(x*x + y*y)
internal operator fun CalibrationVector.minus(v: CalibrationVector) = CalibrationVector(x-v.x, y-v.y, 0.0)
internal fun CalibrationFrame.vector() = CalibrationVector(x,y,0.0)

/** Shared, bounded extraction for captures and live segments. */
internal object LearnedMotionFeatures {
  const val POINTS = 32
  /** Generic XY recordings retain sensor shape only. Trimming removes idle padding; it never
   * declares a movement incorrect. Still and single-frame recordings survive. */
  fun recording(frames:List<CalibrationFrame>,guided:Boolean=true):LearnedMotionTemplate? {
    val input=frames.map(MotionXY::frame)
    if(input.isEmpty() || input.any{it.timestampMs<0 || !it.x.isFinite() || !it.y.isFinite()} ||
      input.zipWithNext().any{(a,b)->b.timestampMs<=a.timestampMs})return null
    val start=input.first().timestampMs
    val prepared=if(guided && input.last().timestampMs-start>=1200)
      input.filter{it.timestampMs-start in 800..7700} else input
    val data=prepared.ifEmpty{input.takeLast(1)}
    val base=median(data.takeWhile{it.timestampMs-data.first().timestampMs<=280})
    // Locate changes, independently of gravity, axis, direction, counts or return.
    val changing=data.indices.filter{i->i>0 && (data[i].vector()-data[(i-2).coerceAtLeast(0)].vector()).length()>.025}
    val active=if(changing.isEmpty())data else data.subList((changing.first()-3).coerceAtLeast(0),(changing.last()+4).coerceAtMost(data.size))
    val elapsed=active.last().timestampMs-active.first().timestampMs
    val amplitude=active.maxOf{(it.vector()-base).length()}
    val scale=amplitude.coerceAtLeast(.001)
    val points=(0 until POINTS).map{index->
      val time=active.first().timestampMs+elapsed*index.toDouble()/(POINTS-1)
      val after=active.indexOfFirst{it.timestampMs>=time}.let{if(it<0)active.lastIndex else it}
      val before=(after-1).coerceAtLeast(0);val a=active[before];val b=active[after]
      val ratio=if(a.timestampMs==b.timestampMs)0.0 else (time-a.timestampMs)/(b.timestampMs-a.timestampMs)
      fun channel(a:Double,b:Double,c:Double)=((a+(b-a)*ratio-c)/scale).coerceIn(-4.0,4.0)
      CalibrationVector(channel(a.x,b.x,base.x),channel(a.y,b.y,base.y),channel(a.z,b.z,base.z))
    }
    return LearnedMotionTemplate(points,elapsed.coerceIn(80,6500),amplitude.coerceIn(0.0,12.0),MotionXY.KIND,0,0)
  }
  fun kind(gesture: String) = when { gesture.endsWith("_straight") -> "tilt"; gesture in setOf("single","double","triple") -> "count"; else -> "flick" }
  fun median(frames: List<CalibrationFrame>): CalibrationVector {
    fun middle(values: List<Double>) = values.sorted()[values.size/2]
    return CalibrationVector(middle(frames.map{it.x}),middle(frames.map{it.y}),0.0)
  }
  fun stable(frames: List<CalibrationFrame>, minimumMs: Long = 240): CalibrationVector? {
    if(frames.size<5 || frames.last().timestampMs-frames.first().timestampMs<minimumMs) return null
    val pose=median(frames)
    if(pose.length() !in .75..1.25) return null
    val errors=frames.map{(it.vector()-pose).length()}.sorted()
    return pose.takeIf { errors[(errors.size*.8).toInt().coerceAtMost(errors.lastIndex)]<=.13 && errors.last()<=.30 &&
      (frames.first().vector()-frames.last().vector()).length()<=.04 }
  }
  fun valid(frames: List<CalibrationFrame>): Boolean = frames.size in 12..260 &&
    frames.all{it.timestampMs>=0 && it.x.isFinite() && it.y.isFinite() && max(abs(it.x),abs(it.y))<=12} &&
    frames.zipWithNext().all{(a,b)->b.timestampMs-a.timestampMs in 1..160}

  fun extract(frames: List<CalibrationFrame>, kind: String): LearnedMotionTemplate? = extractXY(frames.map(MotionXY::frame), kind)

  private fun extractXY(frames: List<CalibrationFrame>, kind: String): LearnedMotionTemplate? {
    if(!valid(frames)) return null
    val baselineFrames=frames.takeWhile{it.timestampMs-frames.first().timestampMs<=280}
    val base=stable(baselineFrames)?:return null
    val tailFrames=frames.filter{frames.last().timestampMs-it.timestampMs<=320}
    val tail=stable(tailFrames)?:return null
    val noise=baselineFrames.map{(it.vector()-base).length()}.sorted().let{it[(it.size*.8).toInt().coerceAtMost(it.lastIndex)]}
    val floor=max(.18,(noise*3).coerceAtMost(.30))
    val first=frames.indexOfFirst{it.timestampMs>baselineFrames.last().timestampMs && (it.vector()-base).length()>floor}
    if(first<0) return null
    val last=frames.indexOfLast{(it.vector()-tail).length()>floor*.8}
    if(last<first) return null
    val active=frames.subList((first-2).coerceAtLeast(0),(last+5).coerceAtMost(frames.size))
    val duration=active.last().timestampMs-active.first().timestampMs
    if(duration !in 80..6500) return null
    val motion=active.map{it.vector()-base}
    val magnitudes=motion.map{it.length()}.sorted()
    val amplitude=magnitudes[(magnitudes.size*.95).toInt().coerceAtMost(magnitudes.lastIndex)].coerceAtLeast(.15)
    if(amplitude !in .22..12.0) return null
    val identity=identity(active,motion,base,tail,noise,amplitude,kind)?:return null
    val points=(0 until POINTS).map{index->
      val time=active.first().timestampMs+duration*index.toDouble()/(POINTS-1)
      val after=active.indexOfFirst{it.timestampMs>=time}.let{if(it<0)active.lastIndex else it}
      val before=(after-1).coerceAtLeast(0);val a=active[before];val b=active[after]
      val ratio=if(a.timestampMs==b.timestampMs)0.0 else (time-a.timestampMs)/(b.timestampMs-a.timestampMs)
      fun channel(a:Double,b:Double,base:Double)=((a+(b-a)*ratio-base)/amplitude).coerceIn(-4.0,4.0)
      CalibrationVector(channel(a.x,b.x,base.x),channel(a.y,b.y,base.y),channel(a.z,b.z,base.z))
    }
    return LearnedMotionTemplate(points,duration,amplitude,kind,identity.first,identity.second)
  }
  private fun identity(active:List<CalibrationFrame>,motion:List<CalibrationVector>,base:CalibrationVector,tail:CalibrationVector,
    noise:Double,amplitude:Double,kind:String):Pair<Int,Int>? {
    val rawDeviation=active.maxOf{abs(it.vector().length()-base.length())}
    if(kind=="tilt") {
      if(base.y/base.length()<.35)return null
      fun roll(v:CalibrationVector)=Math.toDegrees(atan2(v.x,v.y))
      val poses=active.mapIndexedNotNull{index,_->if(index<2)null else {
        val pose=median(active.subList(index-2,index+1))
        if(pose.length() !in .78..1.22 || pose.y/pose.length()<.15)null else pose
      }}
      val angles=poses.map{roll(it)-roll(base)}
      val peak=angles.maxByOrNull{abs(it)}?:return null
      // A roll changes gravity's direction, not its strength. Demand this evidence
      // at the sustained outward pose, excluding brief acceleration overshoots.
      val outward=angles.map{abs(it)}.sorted().let{it[(it.size*.9).toInt().coerceAtMost(it.lastIndex)]}
      if(poses.indices.none{abs(angles[it])>=outward*.9 && abs(poses[it].length()-base.length())<=.05})return null
      if(abs(peak)<12 || abs(roll(tail)-roll(base))>minOf(10.0,abs(peak)*.5))return null
      val polarity=if(peak>0)1 else -1;val gate=max(12.0,abs(peak)*.4)
      var cycles=0;var armed=true
      for(angle in angles) {
        if(angle*polarity < -max(15.0,abs(peak)*.5))return null
        if(angle*polarity>=gate && armed){cycles++;armed=false}
        if(abs(angle)<8)armed=true
      }
      return if(cycles in 1..3)polarity to cycles else null
    }
    if(kind=="flick") {
      if(rawDeviation<.06 || motion.sumOf{it.x*it.x}<motion.sumOf{it.y*it.y+it.z*it.z}*.55)return null
      val onset=motion.firstOrNull{abs(it.x)>=max(.22,noise*3)}?:return null
      return (if(onset.x>0)1 else -1) to 0
    }
    if(kind!="count" || rawDeviation<.12 || amplitude<.4)return null
    val axis=(0..2).maxBy{a->motion.sumOf{v->val n=when(a){0->v.x;1->v.y;else->v.z};n*n}}
    fun value(v:CalibrationVector)=when(axis){0->v.x;1->v.y;else->v.z}
    val gate=max(.25,(noise*4).coerceAtMost(.35))
    var firstSign=0;var returned=false;var previousSign=0;var lastEnd=0L;var cycles=0
    for(i in motion.indices) {
      val n=value(motion[i]);val sign=if(n>=0)1 else -1;val t=active[i].timestampMs
      if(abs(n)<gate){previousSign=0;continue}
      if(firstSign==0){firstSign=sign;cycles=1}
      else if(sign!=firstSign)returned=true
      else if(previousSign!=sign && (returned || t-lastEnd>=240)){cycles++;returned=false}
      previousSign=sign;lastEnd=t
    }
    return if(cycles in 1..3)0 to cycles else null
  }
}
