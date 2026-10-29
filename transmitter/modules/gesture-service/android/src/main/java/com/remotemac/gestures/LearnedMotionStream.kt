package com.remotemac.gestures

import kotlin.math.abs
import kotlin.math.atan2

/** Generic XY endpoint detection uses changes only; any pose and trajectory are valid. */
internal class GenericMotionSegmenter(private val quietMs:Long,private val adaptiveRest:Boolean=false,private val ready:(List<CalibrationFrame>,Long,Boolean)->Long?) {
  private val history=ArrayDeque<CalibrationFrame>()
  private val recent=ArrayDeque<CalibrationFrame>()
  private var baseline:CalibrationVector?=null
  private var frames:MutableList<CalibrationFrame>?=null
  private var lastSample:Long?=null
  private var onset=0L
  private var quietSince:Long?=null
  private var lastReady=0L
  private var cooldownUntil=0L
  private var restingNoise=0.0
  // Survives service stop/resume after dispatch: quiet residual drift belongs
  // to the previous movement rather than a new frozen resting pose.
  private var followRest=false
  private var rearmNoise=0.0
  private val rearm=ArrayDeque<CalibrationFrame>()
  fun addSample(input:CalibrationFrame) {
    val frame=MotionXY.frame(input)
    val now=frame.timestampMs
    if(lastSample?.let{now<=it}==true)return
    if(lastSample?.let{now-it>180}==true)reset()
    lastSample=now
    if(now<cooldownUntil)return
    recent.addLast(frame)
    while(recent.size>2 && recent.elementAt(1).timestampMs<=now-280)recent.removeFirst()
    val center=LearnedMotionFeatures.median(recent.toList())
    val residual=recent.map{(it.vector()-center).length()}.sorted()
    val noise=residual[(residual.size*.8).toInt().coerceAtMost(residual.lastIndex)]
    val quiet=now-recent.first().timestampMs>=240 && noise<=maxOf(.08,if(adaptiveRest)restingNoise*2 else 0.0) &&
      (recent.first().vector()-recent.last().vector()).length()<=maxOf(.04,if(adaptiveRest)restingNoise*2 else 0.0)
    val active=frames
    if(active==null) {
      if(adaptiveRest && followRest && baseline==null) {
        rearm.addLast(frame)
        while(rearm.size>2 && rearm.elementAt(1).timestampMs<=now-1000)rearm.removeFirst()
        if(now-rearm.first().timestampMs<1000)return
        val rest=LearnedMotionFeatures.median(rearm.toList())
        val spread=rearm.map{(it.vector()-rest).length()}.sorted()
        // A hand can be noisier than the pose before the action. Adjacent-frame
        // jitter permits that stationary noise without mistaking slow residual
        // movement for rest; neither allowance exceeds ordinary quiet's .08g.
        val changes=rearm.zipWithNext().map{(a,b)->(a.vector()-b.vector()).length()}.sorted()
        val jitter=changes[changes.size/2]
        val noiseLimit=maxOf(.01,maxOf(rearmNoise,jitter)*1.5).coerceAtMost(.08)
        val driftLimit=maxOf(.02,maxOf(rearmNoise,jitter)*2).coerceAtMost(.08)
        val half=rearm.size/2
        fun mean(values:List<CalibrationFrame>)=CalibrationVector(values.sumOf{it.x}/values.size,values.sumOf{it.y}/values.size,0.0)
        val meanDrift=(mean(rearm.take(half))-mean(rearm.takeLast(half))).length()
        val meanLimit=maxOf(.01,maxOf(rearmNoise,jitter)*2/kotlin.math.sqrt(half.toDouble()))
        if(spread[(spread.size*.8).toInt().coerceAtMost(spread.lastIndex)]>noiseLimit ||
          (rearm.first().vector()-rearm.last().vector()).length()>driftLimit || meanDrift>meanLimit)return
        followRest=false
        // Rearm against the entire observed rest envelope, including occasional
        // hand tremor peaks, rather than immediately treating its tail as onset.
        baseline=rest;restingNoise=spread.last().coerceAtMost(.08)
        if(history.isEmpty())history.addAll(recent.dropLast(1))
      }
      if(baseline==null && recent.size>=(if(adaptiveRest)7 else 5) && now-recent.first().timestampMs>=(if(adaptiveRest)240 else 160) && (!adaptiveRest || quiet)) {
        baseline=center;restingNoise=noise
      }
      if(baseline!=null && history.size>=7 && (frame.vector()-baseline!!).length()>maxOf(.025,if(adaptiveRest)restingNoise*2.5 else 0.0)) {
        frames=(history.toList()+frame).toMutableList();onset=now;quietSince=null;lastReady=0
      }else{
        history.addLast(frame)
        while(history.size>2 && history.elementAt(1).timestampMs<=now-400)history.removeFirst()
      }
      return
    }
    active.add(frame)
    if(quiet){if(quietSince==null)quietSince=recent.first().timestampMs}else quietSince=null
    val forced=now-onset>=6500
    if((quietSince?.let{now-it>=quietMs}==true || forced) && now-lastReady>=160) {
      lastReady=now
      val noiseBeforeAction=restingNoise
      ready(active.toList(),quietSince?.let{now-it}?:0,forced)?.let{cooldown->reset();cooldownUntil=now+cooldown;followRest=true;rearmNoise=noiseBeforeAction}
    }
    if(frames!=null && (now-onset>8500 || active.size>250))reset()
  }
  fun tick(now:Long){if(lastSample?.let{now-it>180}==true)reset()}
  fun reset(){history.clear();recent.clear();rearm.clear();baseline=null;frames=null;lastSample=null;quietSince=null;lastReady=0;cooldownUntil=0;restingNoise=0.0}
}

/** Rest-to-rest segmentation; ticks never manufacture samples or an endpoint. */
internal class MotionSegmenter(private val mode:String, private val ready:(List<CalibrationFrame>)->Long?) {
  private val history=ArrayDeque<CalibrationFrame>()
  private val recent=ArrayDeque<CalibrationFrame>()
  private var baseline:CalibrationVector?=null
  private var frames:MutableList<CalibrationFrame>?=null
  private var onset=0L
  private var quietSince:Long?=null
  private var lastStableAt=0L
  private var lastReady=0L
  private var lastSample:Long?=null
  private var cooldownUntil=0L
  fun addSample(input:CalibrationFrame) {
    val frame=MotionXY.frame(input)
    if(!frame.x.isFinite()||!frame.y.isFinite()||!frame.z.isFinite()||frame.timestampMs<0)return
    val now=frame.timestampMs
    if(lastSample?.let{now<=it}==true)return
    if(lastSample?.let{now-it>180}==true)reset()
    lastSample=now
    if(now<cooldownUntil)return
    recent.addLast(frame)
    while(recent.size>2 && recent.elementAt(1).timestampMs<=now-280)recent.removeFirst()
    val pose=LearnedMotionFeatures.stable(recent.toList())
    val active=frames
    if(active==null) {
      val base=baseline
      // Start buffering at the first small departure, before a slow roll has
      // moved the rest prefix. Feature quality still requires meaningful motion.
      if(base!=null && history.size>=7 && (frame.vector()-base).length()>.03) {
        frames=(history.toList()+frame).toMutableList();onset=now;quietSince=null;lastReady=0
      } else {
        if(pose!=null && baseline==null){baseline=pose;history.clear();history.addAll(recent.dropLast(1))}
        history.addLast(frame)
        while(history.size>2 && history.elementAt(1).timestampMs<=now-400)history.removeFirst()
      }
      return
    }
    active.add(frame)
    if(now-onset>8200 || active.size>250){reset();cooldownUntil=now+600;return}
    if(pose!=null){lastStableAt=now;if(quietSince==null)quietSince=recent.first().timestampMs}
    else if(now-lastStableAt>160)quietSince=null
    val quietMs=if(mode=="count")1400 else 1200
    if(quietSince?.let{now-it>=quietMs}==true && now-lastReady>=160) {
      lastReady=now
      ready(active.toList())?.let{cooldown->
        val rest=recent.toList();reset();cooldownUntil=now+cooldown
        if(cooldown==0L && pose!=null){baseline=pose;history.addAll(rest);recent.addAll(rest);lastSample=now}
      }
    }
  }
  fun tick(now:Long) { if(lastSample?.let{now-it>180}==true)reset() }
  fun pendingFrames():List<CalibrationFrame>?=frames?.toList()
  fun reset(){history.clear();recent.clear();baseline=null;frames=null;quietSince=null;lastStableAt=0;lastSample=null;lastReady=0;cooldownUntil=0}
}

internal object LearnedMotionCapture {
  fun templates(trial:CalibrationTrial):List<LearnedMotionTemplate> {
    if(!LearnedMotionFeatures.valid(trial.frames))return emptyList()
    val result=mutableListOf<LearnedMotionTemplate>()
    val kind=LearnedMotionFeatures.kind(trial.gesture)
    val segmenter=MotionSegmenter(if(kind=="count")"count" else "directional"){frames->
      val feature=LearnedMotionFeatures.extract(frames,kind)
      if(feature==null)null else {result.add(feature);700L}
    }
    // Preparation supplies real resting data, exactly as live rest history does.
    val begin=trial.frames.first().timestampMs+800
    trial.frames.filter{it.timestampMs>=begin}.forEach(segmenter::addSample)
    // A guided capture has an explicit end. Accept its real settled tail without
    // inventing samples; live recognition still waits for count-sequence silence.
    segmenter.pendingFrames()?.let{LearnedMotionFeatures.extract(it,kind)}?.let(result::add)
    return result
  }
  fun unfinishedTilt(frames:List<CalibrationFrame>):Boolean {
    if(frames.size<12)return false
    val base=LearnedMotionFeatures.median(frames.takeWhile{it.timestampMs-frames.first().timestampMs<=280})
    val tail=LearnedMotionFeatures.median(frames.takeLast(7))
    if(base.y/base.length()<.35 || tail.length() !in .75..1.25)return false
    val angle=Math.toDegrees(atan2(tail.x,tail.y)-atan2(base.x,base.y))
    return abs(angle)>4 && frames.maxOf{abs(it.vector().length()-base.length())}<.70
  }
}
