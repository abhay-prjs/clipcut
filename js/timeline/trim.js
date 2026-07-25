// ═══════════════════════════════════════
// TRIM
// ═══════════════════════════════════════
function updateTrimUI(){
  if(S.selectedCutId!==null){
    const cut=S.cuts.find(c=>c.id===S.selectedCutId);
    if(!cut) return;
    document.getElementById('trimFill').style.left='0%';
    document.getElementById('trimFill').style.width='100%';
    document.getElementById('trimHL').style.left='0%';
    document.getElementById('trimHR').style.left='99%';
    document.getElementById('trimInLbl').textContent=cut.start.toFixed(2)+'s';
    document.getElementById('trimOutLbl').textContent=cut.end.toFixed(2)+'s';
  } else {
    const dur=S.duration; if(!dur) return;
    const pL=(S.trimIn/dur)*100, pR=((S.trimOut||dur)/dur)*100;
    document.getElementById('trimFill').style.left=pL+'%';
    document.getElementById('trimFill').style.width=(pR-pL)+'%';
    document.getElementById('trimHL').style.left=pL+'%';
    document.getElementById('trimHR').style.left=(pR-.3)+'%';
    document.getElementById('trimInLbl').textContent=S.trimIn.toFixed(1)+'s';
    document.getElementById('trimOutLbl').textContent=(S.trimOut||dur).toFixed(1)+'s';
  }
}
function updateTrimPlayhead(){
  if(!S.duration)return;
  const p=(video.currentTime/S.duration)*100;
  document.getElementById('trimPlayPos').style.left=p+'%';
}

let dragTrimMode=null, draggingPlayhead=false, dragCutRef=null;
let _mqActive=false, _mqX0=0, _mqFinished=false, _mqEl=null;

document.getElementById('trimHL').addEventListener('mousedown',e=>{
  dragTrimMode='in';
  if(S.selectedCutId!==null){
    const cut=S.cuts.find(c=>c.id===S.selectedCutId);
    if(cut) dragCutRef={cutStart:cut.start,cutEnd:cut.end,mouseX:e.clientX};
  }
  e.stopPropagation();
});
document.getElementById('trimHR').addEventListener('mousedown',e=>{
  dragTrimMode='out';
  if(S.selectedCutId!==null){
    const cut=S.cuts.find(c=>c.id===S.selectedCutId);
    if(cut) dragCutRef={cutStart:cut.start,cutEnd:cut.end,mouseX:e.clientX};
  }
  e.stopPropagation();
});
ph.addEventListener('mousedown',e=>{draggingPlayhead=true;e.stopPropagation();});

tArea.addEventListener('mousedown',e=>{
  if(e.button!==0) return;
  if(e.target.closest('.tl-clip')||e.target===ph||ph.contains(e.target)) return;
  if(dragTrimMode||draggingPlayhead) return;
  const innerRect=document.getElementById('tracksInner').getBoundingClientRect();
  _mqX0=e.clientX-innerRect.left+tArea.scrollLeft;
  _mqActive=true; _mqFinished=false;
  if(!_mqEl){
    _mqEl=document.createElement('div');
    _mqEl.className='tl-marquee';
    document.getElementById('tracksInner').appendChild(_mqEl);
  }
  _mqEl.style.left=_mqX0+'px';
  _mqEl.style.width='0px';
  _mqEl.style.display='block';
});

document.addEventListener('mousemove',e=>{
  if(dragTrimMode){
    if(S.selectedCutId!==null && dragCutRef){
      const cut=S.cuts.find(c=>c.id===S.selectedCutId);
      if(cut){
        const sliderWidth=document.getElementById('trimTrack').offsetWidth;
        const pxPerSec=sliderWidth/Math.max(cut.end-cut.start,0.1);
        const deltaX=e.clientX-dragCutRef.mouseX;
        const deltaSec=(deltaX/pxPerSec)*0.5;
        if(dragTrimMode==='in')  cut.start=Math.max(0,           Math.min(dragCutRef.cutStart+deltaSec,cut.end-0.05));
        if(dragTrimMode==='out') cut.end  =Math.min(S.duration,  Math.max(dragCutRef.cutEnd  +deltaSec,cut.start+0.05));
        // Do NOT write to S.trimIn/S.trimOut here — those are clip-level trim state.
        // Writing cut boundaries into them corrupts trimBefore/trimAfter and buildPlaySegments.
        document.getElementById('trimInLbl').textContent=cut.start.toFixed(2)+'s';
        document.getElementById('trimOutLbl').textContent=cut.end.toFixed(2)+'s';
        document.getElementById('trimContextDur').textContent=(cut.end-cut.start).toFixed(2)+'s';
        if(video.src) video.currentTime=dragTrimMode==='in'?cut.start:cut.end;
        // live-nudge the fill element without a full re-render
        const fillEl=document.querySelector(`[data-cut-id="${S.selectedCutId}"]`);
        if(fillEl){
          fillEl.style.left=(cut.start*S.zoom)+'px';
          fillEl.style.width=Math.max((cut.end-cut.start)*S.zoom,6)+'px';
        }
        ph.style.left=(video.currentTime*S.zoom)+'px';
      }
    } else if(!S.selectedCutId){
      // standard clip trim
      const r=document.getElementById('trimTrack').getBoundingClientRect();
      const p=clamp((e.clientX-r.left)/r.width,0,1);
      const t=p*S.duration;
      if(dragTrimMode==='in') S.trimIn=Math.min(t,(S.trimOut||S.duration)-.5);
      else S.trimOut=Math.max(t,S.trimIn+.5);
      if(video.src){
        if(dragTrimMode==='in')  video.currentTime=S.trimIn;
        if(dragTrimMode==='out') video.currentTime=S.trimOut;
      }
      ph.style.left=(video.currentTime*S.zoom)+'px';
    }
    updateTrimUI();
    return;
  }
  if(draggingPlayhead){
    const innerRect=document.getElementById('tracksInner').getBoundingClientRect();
    const x=e.clientX-innerRect.left;
    const t=Math.max(0,Math.min(x/S.zoom,S.duration));
    ph.style.left=(t*S.zoom)+'px';
    document.getElementById('timecodeDisplay').textContent=tc(t);
  }
  if(_mqActive&&_mqEl){
    const innerRect=document.getElementById('tracksInner').getBoundingClientRect();
    const x=e.clientX-innerRect.left+tArea.scrollLeft;
    _mqEl.style.left=Math.min(x,_mqX0)+'px';
    _mqEl.style.width=Math.abs(x-_mqX0)+'px';
  }
});

document.addEventListener('mouseup',e=>{
  if(draggingPlayhead){
    draggingPlayhead=false;
    const innerRect=document.getElementById('tracksInner').getBoundingClientRect();
    const x=e.clientX-innerRect.left;
    const t=Math.max(0,Math.min(x/S.zoom,S.duration));
    if(video.src) video.currentTime=t;
  }
  if(_mqActive){
    _mqActive=false;
    const mqLeft=parseFloat(_mqEl.style.left);
    const mqW=parseFloat(_mqEl.style.width);
    _mqEl.style.display='none';
    if(mqW>5){
      _mqFinished=true;
      const tStart=mqLeft/S.zoom;
      const tEnd=(mqLeft+mqW)/S.zoom;
      document.querySelectorAll('.tl-clip').forEach(c=>c.classList.remove('selected'));
      S.selectedClipId=null;
      let hitCount=0, firstId=null, offset=0;
      S.clips.forEach(clip=>{
        const tIn=clip.trimIn||0, tOut=clip.trimOut||clip.duration;
        const startPos=clip.timelineStart!=null?clip.timelineStart:offset;
        offset=startPos+(tOut-tIn);
        if(startPos<tEnd&&(startPos+(tOut-tIn))>tStart){
          const el=document.querySelector(`[data-clip-id="${clip.id}"]`);
          if(el){el.classList.add('selected');hitCount++;}
          if(!firstId) firstId=clip.id;
        }
      });
      if(firstId){S.selectedClipId=firstId;renderClipList();}
      if(hitCount) toast(`▦ ${hitCount} clip${hitCount!==1?'s':''} selected`);
    }
  }
  if(dragTrimMode){
    if(S.selectedCutId!==null){
      dragCutRef=null;
      dragTrimMode=null;
      buildPlaySegments();
      renderTimeline();
      return;
    }
    renderTimeline();
  }
  dragTrimMode=null;
  dragCutRef=null;
});

function applyTrim(){
  if(!S.current)return;
  saveHistory();
  const tIn  = S.trimIn;
  const tOut = S.trimOut;
  S.current.trimIn  = tIn;
  S.current.trimOut = tOut;

  _applyTrimToSegments(tIn, tOut);
  buildPlaySegments();
  video.currentTime = tIn;
  updateTrimUI();
  sliceWaveforms();
  renderTimeline();
  toast(`✓ Trim applied: ${tIn.toFixed(2)}s → ${tOut.toFixed(2)}s`);
}
function resetTrim(){
  if(!S.current)return;
  saveHistory();
  S.trimIn=0; S.trimOut=S.duration;
  S.current.trimIn=0; S.current.trimOut=S.duration;
  _applyTrimToSegments(0, S.duration);
  buildPlaySegments();
  updateTrimUI(); sliceWaveforms(); renderTimeline(); toast('↺ Trim reset');
}

function splitAtPlayhead(){
  if(!S.current){toast('No clip loaded');return;}
  if(!S.segments.length){toast('No segments to split');return;}

  const t=video.currentTime;

  // Find the segment that contains the playhead source time,
  // with a small margin so we don't split right at a boundary
  const segIdx=S.segments.findIndex(seg=>t>seg.sourceStart+0.05 && t<seg.sourceEnd-0.05);
  if(segIdx===-1){toast('Playhead must be inside a segment, not at a boundary');return;}

  saveHistory();

  const seg=S.segments[segIdx];

  const segA={
    id:crypto.randomUUID(),
    sourceStart:seg.sourceStart,
    sourceEnd:t,
    duration:t-seg.sourceStart,
    timelineStart:seg.timelineStart,
    waveformSlice:null
  };
  const segB={
    id:crypto.randomUUID(),
    sourceStart:t,
    sourceEnd:seg.sourceEnd,
    duration:seg.sourceEnd-t,
    timelineStart:seg.timelineStart+(t-seg.sourceStart),
    waveformSlice:null
  };

  // Replace the original segment with the two halves
  S.segments.splice(segIdx,1,segA,segB);

  // Recalculate timelineStart for every segment after the split
  let cursor=segA.timelineStart+segA.duration;
  for(let i=segIdx+1;i<S.segments.length;i++){
    S.segments[i].timelineStart=cursor;
    S.segments[i].waveformSlice=null;
    cursor+=S.segments[i].duration;
  }

  buildPlaySegments();
  sliceWaveforms();
  renderTimeline();
  toast(`⊘ Split at ${t.toFixed(2)}s — ${S.segments.length} segments`);
}

function trimBefore(){
  if(!S.current){toast('No clip loaded');return;}
  const t = video.currentTime;
  saveHistory();
  S.trimIn = t;
  S.current.trimIn = t;
  _applyTrimToSegments(t, S.trimOut);
  video.currentTime = t;
  updateTrimUI(); buildPlaySegments(); sliceWaveforms(); renderTimeline();
  toast(`◁ Trimmed before ${t.toFixed(2)}s`);
}

function trimAfter(){
  if(!S.current){toast('No clip loaded');return;}
  const t = video.currentTime;
  saveHistory();
  S.trimOut = t;
  S.current.trimOut = t;
  _applyTrimToSegments(S.trimIn, t);
  updateTrimUI(); buildPlaySegments(); sliceWaveforms(); renderTimeline();
  toast(`▷ Trimmed after ${t.toFixed(2)}s`);
}

// Shared: clamp S.segments to [tIn, tOut] and rebuild timelineStart offsets.
function _applyTrimToSegments(tIn, tOut){
  const trimmed = [];
  let cursor = 0;
  for(const seg of S.segments){
    if(seg.sourceEnd <= tIn || seg.sourceStart >= tOut) continue;
    const sStart = Math.max(seg.sourceStart, tIn);
    const sEnd   = Math.min(seg.sourceEnd,   tOut);
    const dur    = sEnd - sStart;
    trimmed.push({...seg, sourceStart:sStart, sourceEnd:sEnd, duration:dur, timelineStart:cursor, waveformSlice:null});
    cursor += dur;
  }
  if(!trimmed.length){
    trimmed.push({id:crypto.randomUUID(), sourceStart:tIn, sourceEnd:tOut, duration:tOut-tIn, timelineStart:0, waveformSlice:null});
  }
  S.segments = trimmed;
}
