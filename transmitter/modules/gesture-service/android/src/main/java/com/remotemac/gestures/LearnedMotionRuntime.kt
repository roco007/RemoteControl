package com.remotemac.gestures

internal class LearnedMotionRuntime @JvmOverloads constructor(private val mode:String,private val profile:MotionCalibrationProfile,
  private val progress:(Int,String)->Unit,private val action:(String,Int)->Unit,
  recordings:Map<String,List<List<CalibrationFrame>>> = emptyMap()) {
  private val models=MotionXY.effectiveProfile(SavedGestureCalibration(profile=profile))!!.learnedModels
    .filterKeys{(LearnedMotionFeatures.kind(it)=="count")== (mode=="count")}
  private val segmenter=MotionSegmenter(mode,::complete)
  private val endpoint=if(mode!="count" && models.values.any{it.version>=2})LearnedMotionEndpoint(models,recordings)else null
  private val fastDirectional=endpoint?.needsOriginalSilence==false
  val postActionPauseMs:Long get()=if(fastDirectional)0 else 700
  private val originalQuietMs=sequenceQuietMs()
  private val generic=models.takeIf{it.values.any{model->model.version>=2}}?.let{GenericMotionSegmenter(genericQuietMs(),fastDirectional,::completeGeneric)}
  private var sampleClock:GestureCalibrationSampleClock?=null
  private fun genericQuietMs():Long {
    // Keep established count sequence timing. Directional labels use their own
    // continuation evidence instead of inheriting every other example's pause.
    return if(fastDirectional)320 else originalQuietMs
  }
  private fun sequenceQuietMs():Long {
    return models.values.filter{it.version>=2}.flatMap{it.templates}.maxOfOrNull{template->
      val edges=template.points.zipWithNext().map{(a,b)->(a-b).length()}
      val moving=edges.indices.filter{edges[it]>.04}
      var longest=0;var run=0
      if(moving.isNotEmpty())for(i in moving.first()..moving.last()){
        if(edges[i]<=.04){run++;longest=maxOf(longest,run)}else run=0
      }
      (longest*template.durationMs/31+320).coerceIn(1100,6500)
    }?:1100L
  }
  private fun completeGeneric(frames:List<CalibrationFrame>,quietForMs:Long,forced:Boolean):Long? {
    val feature=LearnedMotionFeatures.recording(frames,guided=false)?:return null
    val features=mutableMapOf("motion" to feature)
    // Existing version1 labels keep their original interpretation and bounds.
    for(kind in models.filterValues{it.version==1}.keys.map{LearnedMotionFeatures.kind(it)}.distinct())
      LearnedMotionFeatures.extract(frames,kind)?.let{features[kind]=it}
    val match=LearnedMotionMatcher.match(features,models)
    if(match!=null){
      val model=models.getValue(match)
      val matched=features[if(model.version>=2)"motion" else LearnedMotionFeatures.kind(match)]!!
      val distances=model.templates.map{LearnedMotionMatcher.distance(if(model.version==1)MotionXY.template(matched)else matched,if(model.version==1)MotionXY.template(it)else it)}.sorted()
      val score=(if(model.version>=2)distances.first()else(distances[0]+distances[1])/2)/model.maxDistance
      if(fastDirectional && !forced && ((model.version==1 && quietForMs<1200) || endpoint!!.pending(feature,score,quietForMs)))return null
      dispatch(match);return postActionPauseMs
    }
    // Learned labels never fall back to the old recognizer on a mismatch.
    // An early learned endpoint must not accelerate an untrained legacy action
    // or turn the beginning of a known longer movement into that fallback.
    if(fastDirectional && !forced && (quietForMs<1200 || endpoint!!.pending(feature,1.0,quietForMs)))return null
    val events=mutableListOf<String>()
    val legacy=MotionGestureDetector(mode,{_,_->},{g,_->events.add(g)},profile.copy(learnedModels=emptyMap()))
    frames.forEach{legacy.addSample(it.x,it.y,it.z,it.timestampMs)}
    if(events.size==1 && events.single() !in models){dispatch(events.single());return postActionPauseMs}
    return null
  }
  private fun complete(frames:List<CalibrationFrame>):Long? {
    val kinds=if(mode=="count")listOf("count") else listOf("flick","tilt")
    val features=kinds.mapNotNull{kind->LearnedMotionFeatures.extract(frames,kind)?.let{kind to it}}.toMap()
    val match=LearnedMotionMatcher.match(features,models)
    if(match!=null){dispatch(match);return 700L}
    if(mode=="count" && features["count"]==null)return 0L
    if(mode=="directional" && LearnedMotionCapture.unfinishedTilt(frames))return null
    val shape=features["count"]?.let{when(it.cycles){1->"single";2->"double";else->"triple"}}
      ?:features["tilt"]?.let{if(it.polarity>0)"left_straight" else "right_straight"}
      ?:features["flick"]?.let{if(it.polarity>0)"right" else "left"}
    if(shape in models && (mode=="count" || features["tilt"]!=null))return 0L
    val events=mutableListOf<String>()
    val legacy=MotionGestureDetector(mode,{_,_->},{gesture,_->events.add(gesture)},profile.copy(learnedModels=emptyMap()))
    frames.forEach{legacy.addSample(it.x,it.y,it.z,it.timestampMs)}
    val accepted=events.filter{it !in models && (shape==null || it==shape || (mode=="directional" && features["tilt"]==null && it in setOf("left","right")))}
    if(events.size==1 && accepted.size==1){dispatch(accepted.single());return 700L}
    val tail=LearnedMotionFeatures.median(frames.takeLast(7))
    val lastMotion=frames.lastOrNull{(it.vector()-tail).length()>.18}?.timestampMs?:frames.first().timestampMs
    val pause=if(mode=="count")profile.countSequencePauseMs else profile.sequencePauseMs
    return if(shape==null || events.isNotEmpty() || frames.last().timestampMs-lastMotion>=pause+80)0L else null
  }
  private fun dispatch(gesture:String){progress(0,"");action(gesture,when(gesture){"single","left","right"->1;"triple"->3;else->2})}
  fun addSample(frame:CalibrationFrame) {
    if(frame.timestampMs<0 || !frame.x.isFinite() || !frame.y.isFinite() ||
      (generic==null && maxOf(kotlin.math.abs(frame.x),kotlin.math.abs(frame.y))>12)){reset();return}
    val clock=sampleClock?:GestureCalibrationSampleClock(frame.timestampMs).also{sampleClock=it}
    if(clock.accept(frame.timestampMs)){if(generic!=null)generic.addSample(MotionXY.frame(frame))else segmenter.addSample(MotionXY.frame(frame))}
  }
  fun tick(now:Long){if(generic!=null)generic.tick(now)else segmenter.tick(now)}
  fun reset(){sampleClock=null;segmenter.reset();generic?.reset();progress(0,"")}
}
