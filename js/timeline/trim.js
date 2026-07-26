// ═══════════════════════════════════════
// TRIM
// ═══════════════════════════════════════
// NOTE (bug #15): the clip-trim branch below (and updateTrimPlayhead()) maps
// by raw t/S.duration — i.e. source-file time, NOT the post-cut/snapped
// timeline. This is intentional: trimIn/trimOut are the outer bounds of the
// whole source clip, a concept that exists independently of internal cuts,
// so mapping them through playSegments would change what they mean rather
// than fix a bug. Labeled "(source time)" in updateTrimContext() so this
// doesn't read as a positioning bug when it visually diverges from the
// timeline below it.
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
// overrideSrcTime: see updateCaptionOverlay() in captions.js — proxy playback
// passes the mapped source time explicitly.
function updateTrimPlayhead(overrideSrcTime){
  if(!S.duration)return;
  const t=overrideSrcTime!==undefined?overrideSrcTime:video.currentTime;
  const p=(t/S.duration)*100;
  document.getElementById('trimPlayPos').style.left=p+'%';
}

let dragTrimMode=null, draggingPlayhead=false, dragCutRef=null;
let _mqActive=false, _mqX0=0, _mqFinished=false, _mqEl=null;

document.getElementById('trimHL').addEventListener('mousedown',e=>{
  dragTrimMode='in';
  if(S.selectedCutId!==null){
    const cut=S.cuts.find(c=>c.id===S.selectedCutId);
    if(cut){saveHistory();dragCutRef={cutStart:cut.start,cutEnd:cut.end,mouseX:e.clientX};}
  }
  e.stopPropagation();
});
document.getElementById('trimHR').addEventListener('mousedown',e=>{
  dragTrimMode='out';
  if(S.selectedCutId!==null){
    const cut=S.cuts.find(c=>c.id===S.selectedCutId);
    if(cut){saveHistory();dragCutRef={cutStart:cut.start,cutEnd:cut.end,mouseX:e.clientX};}
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
        const deltaSec=deltaX/pxPerSec;
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
    const mqW=parseFloat(_mqEl.style.width);
    _mqEl.style.display='none';
    // Marquee-drag selection of timeline clips was dead code (S.clips isn't
    // rendered per-clip on the timeline and clip.timelineStart is never set —
    // only S.segments have real timeline positions). Suppress the click-to-seek
    // that would otherwise fire on drag-release; no selection behavior (yet).
    if(mqW>5) _mqFinished=true;
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
  _relayoutSegments();

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

// Shared timeline layout for S.segments — the single place that decides where
// each segment sits on the timeline, so every segment-mutating function
// (applyCuts, splitAtPlayhead, deleteSegment, _applyTrimToSegments here,
// snapGaps) agrees on the same rule instead of each hand-rolling its own
// cursor math:
//   S.snapped === true  → contiguous layout, gaps closed (cursor-based)
//   S.snapped === false → each segment sits at its own sourceStart, so a
//                         removed cut leaves a real gap in timelineStart —
//                         renderTimeline() draws that gap as a hatched
//                         .tl-gap block instead of silently closing it
function _relayoutSegments(){
  if(S.snapped){
    let cursor=0;
    S.segments.forEach(seg=>{ seg.timelineStart=cursor; cursor+=seg.duration; });
  } else {
    S.segments.forEach(seg=>{ seg.timelineStart=seg.sourceStart; });
  }
}

// Shared: clamp S.segments to [tIn, tOut] and rebuild timelineStart offsets.
function _applyTrimToSegments(tIn, tOut){
  const trimmed = [];
  for(const seg of S.segments){
    if(seg.sourceEnd <= tIn || seg.sourceStart >= tOut) continue;
    const sStart = Math.max(seg.sourceStart, tIn);
    const sEnd   = Math.min(seg.sourceEnd,   tOut);
    const dur    = sEnd - sStart;
    trimmed.push({...seg, sourceStart:sStart, sourceEnd:sEnd, duration:dur, timelineStart:0, waveformSlice:null});
  }
  if(!trimmed.length){
    trimmed.push({id:crypto.randomUUID(), sourceStart:tIn, sourceEnd:tOut, duration:tOut-tIn, timelineStart:0, waveformSlice:null});
  }
  S.segments = trimmed;
  _relayoutSegments();
}

// Removes the selected segment (the "split → delete bad half" flow —
// Split existed via Ctrl+B but there was no way to then discard the split-off
// piece). Recomputes timelineStart for the remaining segments via _relayoutSegments().
function deleteSegment(){
  if(S.selectedSegmentId===null) return;
  if(S.segments.length<=1){ toast("Can't delete the only segment"); return; }
  saveHistory();
  S.segments = S.segments.filter(s=>s.id!==S.selectedSegmentId);
  _relayoutSegments();
  S.selectedSegmentId=null;
  buildPlaySegments();
  sliceWaveforms();
  renderTimeline();
  updateTrimContext();
  toast('✕ Segment removed');
}

// ═══════════════════════════════════════
// ON-TIMELINE CUT DRAGGING (§C6) — grab a cut block's edges to resize,
// or its center to move it, directly on the timeline.
// ═══════════════════════════════════════

// Candidate snap positions (timeline seconds): word boundaries, other cut
// edges, segment edges, the playhead. Whole-second snapping is handled
// separately (doesn't depend on app state).
function _cutSnapTargets(excludeCutId){
  const targets=[];
  S.captions.forEach(c=>{
    const s=sourceTimeToTimeline(c.start), e=sourceTimeToTimeline(c.end);
    if(s!==null) targets.push(s);
    if(e!==null) targets.push(e);
  });
  S.cuts.forEach(c=>{
    if(c.id===excludeCutId) return;
    const s=sourceTimeToTimeline(c.start), e=sourceTimeToTimeline(c.end);
    if(s!==null) targets.push(s);
    if(e!==null) targets.push(e);
  });
  S.segments.forEach(seg=>{
    targets.push(seg.timelineStart);
    targets.push(seg.timelineStart+seg.duration);
  });
  if(video.src){
    const p=sourceTimeToTimeline(video.currentTime);
    if(p!==null) targets.push(p);
  }
  return targets;
}

function _bindCutDrag(el, cut){
  const EDGE=8;
  let mode=null, startX=0, startTlStart=0, startTlEnd=0, historySaved=false;

  el.addEventListener('mousemove', e=>{
    if(mode) return; // dragging — leave cursor as set by pointerdown
    const rect=el.getBoundingClientRect();
    const offsetX=e.clientX-rect.left;
    el.style.cursor = (offsetX<=EDGE||offsetX>=rect.width-EDGE) ? 'ew-resize' : 'grab';
  });

  el.addEventListener('pointerdown', e=>{
    if(e.button!==0) return;
    e.stopPropagation();
    const rect=el.getBoundingClientRect();
    const offsetX=e.clientX-rect.left;
    mode = offsetX<=EDGE ? 'resize-l' : (offsetX>=rect.width-EDGE ? 'resize-r' : 'move');
    startX=e.clientX;
    startTlStart=sourceTimeToTimeline(cut.start);
    startTlEnd=sourceTimeToTimeline(cut.end);
    historySaved=false;
    el.setPointerCapture(e.pointerId);
    selectCut(cut.id);
  });

  el.addEventListener('pointermove', e=>{
    if(!mode) return;
    if(!historySaved){ saveHistory(); historySaved=true; }
    let deltaSec=(e.clientX-startX)/S.zoom;
    if(e.shiftKey) deltaSec*=0.25;

    let newTlStart=startTlStart, newTlEnd=startTlEnd;
    if(mode==='move'){ newTlStart=startTlStart+deltaSec; newTlEnd=startTlEnd+deltaSec; }
    else if(mode==='resize-l'){ newTlStart=Math.min(startTlStart+deltaSec, startTlEnd-0.05); }
    else if(mode==='resize-r'){ newTlEnd=Math.max(startTlEnd+deltaSec, startTlStart+0.05); }
    newTlStart=Math.max(0,newTlStart);

    if(!e.altKey){
      const snapSec=6/S.zoom;
      const targets=_cutSnapTargets(cut.id);
      const trySnap=(val)=>{
        let best=val, bestDist=snapSec;
        for(const t of targets){ const d=Math.abs(t-val); if(d<bestDist){bestDist=d;best=t;} }
        const rounded=Math.round(val);
        if(Math.abs(rounded-val)<bestDist) best=rounded;
        return best;
      };
      if(mode==='move'){ const s=trySnap(newTlStart); newTlEnd+=(s-newTlStart); newTlStart=s; }
      else if(mode==='resize-l') newTlStart=trySnap(newTlStart);
      else if(mode==='resize-r') newTlEnd=trySnap(newTlEnd);
    }

    el.style.left=(newTlStart*S.zoom)+'px';
    el.style.width=Math.max((newTlEnd-newTlStart)*S.zoom,6)+'px';
    cut._dragTlStart=newTlStart; cut._dragTlEnd=newTlEnd;
    const srcStart=timelineToSourceTime(newTlStart), srcEnd=timelineToSourceTime(newTlEnd);
    document.getElementById('trimInLbl').textContent=srcStart.toFixed(2)+'s';
    document.getElementById('trimOutLbl').textContent=srcEnd.toFixed(2)+'s';
    document.getElementById('trimContextDur').textContent=(srcEnd-srcStart).toFixed(2)+'s';
  });

  el.addEventListener('pointerup', e=>{
    if(!mode) return;
    if(cut._dragTlStart!=null){
      cut.start=timelineToSourceTime(cut._dragTlStart);
      cut.end=timelineToSourceTime(cut._dragTlEnd);
      delete cut._dragTlStart; delete cut._dragTlEnd;
      buildPlaySegments();
      if(video.src) video.currentTime=cut.start;
    }
    mode=null; historySaved=false;
    renderTimeline();
  });
}

// ═══════════════════════════════════════
// ON-TIMELINE CAPTION DRAGGING — same edge-resize/move grammar as cuts (§C6/F1),
// applied to caption blocks so retiming a caption doesn't require reopening the
// transcript tab. Neighbors are clamped directly (adjacent captions must stay
// gapless/non-overlapping) instead of relying on width-clamping like the
// read-only render path does.
// ═══════════════════════════════════════
function _captionNeighborBounds(cap){
  const idx=S.captions.indexOf(cap);
  const prevEnd  = idx>0 ? S.captions[idx-1].end : 0;
  const nextStart= idx<S.captions.length-1 ? S.captions[idx+1].start : Infinity;
  return {prevEnd, nextStart};
}

function _bindCaptionDrag(el, cap){
  const EDGE=8;
  let mode=null, startX=0, startTlStart=0, startTlEnd=0, historySaved=false;

  el.addEventListener('mousemove', e=>{
    if(mode) return;
    const rect=el.getBoundingClientRect();
    const offsetX=e.clientX-rect.left;
    el.style.cursor = (offsetX<=EDGE||offsetX>=rect.width-EDGE) ? 'ew-resize' : 'grab';
  });

  el.addEventListener('pointerdown', e=>{
    if(e.button!==0) return;
    e.stopPropagation();
    const rect=el.getBoundingClientRect();
    const offsetX=e.clientX-rect.left;
    mode = offsetX<=EDGE ? 'resize-l' : (offsetX>=rect.width-EDGE ? 'resize-r' : 'move');
    startX=e.clientX;
    startTlStart=sourceTimeToTimeline(cap.start);
    startTlEnd=sourceTimeToTimeline(cap.end);
    historySaved=false;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', e=>{
    if(!mode) return;
    if(!historySaved){ saveHistory(); historySaved=true; }
    let deltaSec=(e.clientX-startX)/S.zoom;
    if(e.shiftKey) deltaSec*=0.25;

    const {prevEnd, nextStart}=_captionNeighborBounds(cap);
    const minTlStart = sourceTimeToTimeline(prevEnd) ?? 0;
    const maxTlEnd   = nextStart===Infinity ? Infinity : (sourceTimeToTimeline(nextStart) ?? Infinity);

    let newTlStart=startTlStart, newTlEnd=startTlEnd;
    if(mode==='move'){
      const dur=startTlEnd-startTlStart;
      newTlStart=startTlStart+deltaSec; newTlEnd=startTlEnd+deltaSec;
      if(newTlStart<minTlStart){ newTlStart=minTlStart; newTlEnd=newTlStart+dur; }
      if(newTlEnd>maxTlEnd){ newTlEnd=maxTlEnd; newTlStart=newTlEnd-dur; }
    } else if(mode==='resize-l'){
      newTlStart=Math.max(minTlStart, Math.min(startTlStart+deltaSec, startTlEnd-0.1));
    } else if(mode==='resize-r'){
      newTlEnd=Math.min(maxTlEnd, Math.max(startTlEnd+deltaSec, startTlStart+0.1));
    }
    newTlStart=Math.max(0,newTlStart);

    if(!e.altKey){
      const snapSec=6/S.zoom;
      const targets=_cutSnapTargets(null);
      const trySnap=(val)=>{
        let best=val, bestDist=snapSec;
        for(const t of targets){ const d=Math.abs(t-val); if(d<bestDist){bestDist=d;best=t;} }
        const rounded=Math.round(val);
        if(Math.abs(rounded-val)<bestDist) best=rounded;
        return best;
      };
      if(mode==='move'){ const s=trySnap(newTlStart); newTlEnd+=(s-newTlStart); newTlStart=s; }
      else if(mode==='resize-l') newTlStart=trySnap(newTlStart);
      else if(mode==='resize-r') newTlEnd=trySnap(newTlEnd);
    }

    el.style.left=(newTlStart*S.zoom)+'px';
    el.style.width=Math.max((newTlEnd-newTlStart)*S.zoom,4)+'px';
    cap._dragTlStart=newTlStart; cap._dragTlEnd=newTlEnd;
  });

  el.addEventListener('pointerup', e=>{
    if(!mode) return;
    if(cap._dragTlStart!=null){
      cap.start=timelineToSourceTime(cap._dragTlStart);
      cap.end=timelineToSourceTime(cap._dragTlEnd);
      delete cap._dragTlStart; delete cap._dragTlEnd;
      if(video.src) video.currentTime=cap.start;
    }
    mode=null; historySaved=false;
    renderTimeline();
  });
}

// ═══════════════════════════════════════
// ON-TIMELINE SEGMENT EDGE-DRAG (F1 — universal trim grammar, segments)
// ═══════════════════════════════════════
// Slip-trims a kept segment's sourceStart/sourceEnd by dragging its edges —
// center-drag ("move") is deliberately out of scope for v1 (segments aren't
// freely repositionable the way a cut or caption is; only the click-to-select
// behavior lives on the center, unchanged). Bounded by the neighboring
// segment's own source range so you can't eat into content another kept
// segment owns, but CAN extend into an adjacent gap — un-cutting part of it.
//
// "Ripple mode" from the original spec needed no new state: it's already
// S.snapped. _relayoutSegments() (called after every mutation here) lays out
// contiguously when snapped — so extending a segment automatically pushes
// every downstream segment along, i.e. ripples — and gap-preserving
// (sourceStart-based, no ripple) when not snapped. Toggling Snap Gaps is the
// ripple toggle.
function _segmentNeighborBounds(seg){
  const idx=S.segments.indexOf(seg);
  const prevEnd   = idx>0 ? S.segments[idx-1].sourceEnd : 0;
  const nextStart = idx<S.segments.length-1 ? S.segments[idx+1].sourceStart : S.duration;
  return {prevEnd, nextStart};
}

function _bindSegmentDrag(el, seg){
  const EDGE=8;
  let mode=null, startX=0, startSourceStart=0, startSourceEnd=0, historySaved=false;

  el.addEventListener('mousemove', e=>{
    if(mode) return;
    const rect=el.getBoundingClientRect();
    const offsetX=e.clientX-rect.left;
    el.style.cursor = (offsetX<=EDGE||offsetX>=rect.width-EDGE) ? 'ew-resize' : 'pointer';
  });

  el.addEventListener('pointerdown', e=>{
    if(e.button!==0) return;
    const rect=el.getBoundingClientRect();
    const offsetX=e.clientX-rect.left;
    if(offsetX>EDGE && offsetX<rect.width-EDGE) return; // center — leave to the existing click-to-select handler
    e.stopPropagation();
    mode = offsetX<=EDGE ? 'resize-l' : 'resize-r';
    startX=e.clientX;
    startSourceStart=seg.sourceStart;
    startSourceEnd=seg.sourceEnd;
    historySaved=false;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', e=>{
    if(!mode) return;
    if(!historySaved){ saveHistory(); historySaved=true; }
    let deltaSec=(e.clientX-startX)/S.zoom;
    if(e.shiftKey) deltaSec*=0.25;

    const {prevEnd,nextStart}=_segmentNeighborBounds(seg);
    if(mode==='resize-l'){
      seg.sourceStart=Math.max(prevEnd, Math.min(startSourceStart+deltaSec, seg.sourceEnd-0.1));
    } else {
      seg.sourceEnd=Math.min(nextStart, Math.max(startSourceEnd+deltaSec, seg.sourceStart+0.1));
    }
    seg.duration=seg.sourceEnd-seg.sourceStart;
    _relayoutSegments();

    // Live-nudge every existing segment element's position/width directly.
    // Ripple (snapped) can shift every downstream segment, but calling
    // renderTimeline() mid-drag would destroy this element (and its active
    // pointer capture) the moment the DOM rebuilds — same trap _bindCutDrag/
    // _bindCaptionDrag avoid by nudging styles instead of re-rendering.
    // Gap-hatch bars go stale for the duration of the drag (they're rebuilt
    // fresh on pointerup) — a minor visual nit, not worth rebuilding the DOM for.
    S.segments.forEach(s=>{
      const segEl=document.querySelector(`.tl-clip[data-seg-id="${s.id}"]`);
      if(!segEl) return;
      segEl.style.left=(s.timelineStart*S.zoom)+'px';
      segEl.style.width=Math.max(s.duration*S.zoom,20)+'px';
    });
  });

  el.addEventListener('pointerup', e=>{
    if(!mode) return;
    mode=null; historySaved=false;
    buildPlaySegments();
    sliceWaveforms();
    renderTimeline();
  });
}

// ═══════════════════════════════════════
// ON-TIMELINE TEXT LAYER DRAG ("Add Text") — same edge-resize/move grammar
// as cuts/captions/segments. Unlike captions/segments, text layers can
// freely overlap each other in time (independent on-screen objects, not a
// single running transcript) — the only clamp is the clip's own [0,duration]
// bounds, no neighbor-adjacency constraint.
// ═══════════════════════════════════════
function _bindTextLayerDrag(el, layer){
  const EDGE=8;
  let mode=null, startX=0, startTlStart=0, startTlEnd=0, historySaved=false;

  el.addEventListener('mousemove', e=>{
    if(mode) return;
    const rect=el.getBoundingClientRect();
    const offsetX=e.clientX-rect.left;
    el.style.cursor = (offsetX<=EDGE||offsetX>=rect.width-EDGE) ? 'ew-resize' : 'grab';
  });

  el.addEventListener('pointerdown', e=>{
    if(e.button!==0) return;
    e.stopPropagation();
    const rect=el.getBoundingClientRect();
    const offsetX=e.clientX-rect.left;
    mode = offsetX<=EDGE ? 'resize-l' : (offsetX>=rect.width-EDGE ? 'resize-r' : 'move');
    startX=e.clientX;
    startTlStart=sourceTimeToTimeline(layer.start);
    startTlEnd=sourceTimeToTimeline(layer.end);
    historySaved=false;
    el.setPointerCapture(e.pointerId);
    selectTextLayer(layer.id);
  });

  el.addEventListener('pointermove', e=>{
    if(!mode) return;
    if(!historySaved){ saveHistory(); historySaved=true; }
    let deltaSec=(e.clientX-startX)/S.zoom;
    if(e.shiftKey) deltaSec*=0.25;

    const maxTl = sourceTimeToTimeline(S.duration||0) ?? (S.duration||0);
    let newTlStart=startTlStart, newTlEnd=startTlEnd;
    if(mode==='move'){
      const dur=startTlEnd-startTlStart;
      newTlStart=startTlStart+deltaSec; newTlEnd=startTlEnd+deltaSec;
      if(newTlStart<0){ newTlStart=0; newTlEnd=dur; }
      if(newTlEnd>maxTl){ newTlEnd=maxTl; newTlStart=maxTl-dur; }
    } else if(mode==='resize-l'){
      newTlStart=Math.max(0, Math.min(startTlStart+deltaSec, startTlEnd-0.1));
    } else if(mode==='resize-r'){
      newTlEnd=Math.min(maxTl, Math.max(startTlEnd+deltaSec, startTlStart+0.1));
    }

    if(!e.altKey){
      const snapSec=6/S.zoom;
      const targets=_cutSnapTargets(null);
      const trySnap=(val)=>{
        let best=val, bestDist=snapSec;
        for(const t of targets){ const d=Math.abs(t-val); if(d<bestDist){bestDist=d;best=t;} }
        const rounded=Math.round(val);
        if(Math.abs(rounded-val)<bestDist) best=rounded;
        return best;
      };
      if(mode==='move'){ const s=trySnap(newTlStart); newTlEnd+=(s-newTlStart); newTlStart=s; }
      else if(mode==='resize-l') newTlStart=trySnap(newTlStart);
      else if(mode==='resize-r') newTlEnd=trySnap(newTlEnd);
    }

    el.style.left=(newTlStart*S.zoom)+'px';
    el.style.width=Math.max((newTlEnd-newTlStart)*S.zoom,20)+'px';
    layer._dragTlStart=newTlStart; layer._dragTlEnd=newTlEnd;
  });

  el.addEventListener('pointerup', e=>{
    if(!mode) return;
    if(layer._dragTlStart!=null){
      layer.start=timelineToSourceTime(layer._dragTlStart);
      layer.end=timelineToSourceTime(layer._dragTlEnd);
      delete layer._dragTlStart; delete layer._dragTlEnd;
      if(video.src) video.currentTime=layer.start;
      renderTextLayerInspector();
    }
    mode=null; historySaved=false;
    renderTimeline();
  });
}
