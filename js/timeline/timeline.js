// ═══════════════════════════════════════
// TIMELINE
// ═══════════════════════════════════════
// Signature cache so renderTimeline() only reposts a waveform draw when
// zoom/segment-layout/waveform-data actually changed (F-B6).
let _lastWaveSig = null, _lastWaveformDataRef = null;

function updateCutBadge(){
  const cuts=S.cuts.filter(c=>c.selected).length;
  const badge=document.getElementById('cutBadge');
  if(!badge) return;
  badge.style.display=cuts>0?'block':'none';
  badge.textContent=`${cuts} cuts`;
}

function renderTimeline(){
  const zoom=S.zoom;

  // Total timeline duration — derived from segments when available.
  // _relayoutSegments() keeps timelineStart consistent with S.snapped (gapless
  // cursor layout when snapped, sourceStart-based with real gaps when not),
  // so the rightmost extent is always the same formula either way.
  let totalDur;
  if(S.segments.length){
    const last=S.segments[S.segments.length-1];
    totalDur=last.timelineStart+last.duration;
  } else {
    totalDur=Math.max(...S.clips.map(c=>c.duration),30);
  }
  const totalW=Math.max(totalDur*zoom+200,tArea.clientWidth||600);
  document.getElementById('tracksInner').style.width=totalW+'px';
  buildRuler(totalDur,totalW,zoom);

  // ── VIDEO TRACK: one element per segment, gap-hatch bars in between ──
  const vt=document.getElementById('videoTrack'); vt.innerHTML='';
  const vtFrag=document.createDocumentFragment();
  // Pre-snap, a removed cut leaves timelineStart gaps between segments
  // (see _relayoutSegments) — draw those gaps as visibly hatched rather than
  // silent empty space, so "this was cut" reads instantly without needing to
  // select anything. Gone once snapGaps() runs (S.snapped=true, no gaps left).
  if(!S.snapped){
    for(let i=0;i<S.segments.length-1;i++){
      const cur=S.segments[i], next=S.segments[i+1];
      const gapStart=cur.timelineStart+cur.duration, gapEnd=next.timelineStart;
      if(gapEnd-gapStart<=0.01) continue;
      const gapEl=document.createElement('div');
      gapEl.className='tl-gap';
      gapEl.style.left=(gapStart*zoom)+'px';
      gapEl.style.width=Math.max((gapEnd-gapStart)*zoom,2)+'px';
      gapEl.title=`Cut — ${(gapEnd-gapStart).toFixed(2)}s removed`;
      vtFrag.appendChild(gapEl);
    }
  }
  S.segments.forEach((seg,i)=>{
    const left=seg.timelineStart*zoom;
    const width=Math.max(seg.duration*zoom,20);
    const el=document.createElement('div');
    el.className='tl-clip'+(seg.id===S.selectedSegmentId?' selected':'');
    el.style.left=left+'px';
    el.style.width=width+'px';
    el.dataset.segId=seg.id;
    el.innerHTML=`seg ${i+1} · ${seg.duration.toFixed(1)}s`;
    el.addEventListener('click',e=>{
      e.stopPropagation();
      S.selectedSegmentId=seg.id;
      S.selectedCutId=null;
      // Toggle selection classes directly instead of a full renderTimeline()
      // rebuild (F-B2) — a selection change doesn't move or resize anything.
      document.querySelectorAll('#videoTrack .tl-clip.selected').forEach(c=>c.classList.remove('selected'));
      document.querySelectorAll('.tl-cut.cut-selected').forEach(c=>c.classList.remove('cut-selected'));
      el.classList.add('selected');
      updateTrimContext();
    });
    _bindSegmentDrag(el, seg);
    vtFrag.appendChild(el);
  });

  // ── CUTS ────────────────────────────────────────────────────
  // Solid per-type colors (Part C2) — one element per cut, no rgba stacking.
  const _cutTypeColor={
    dead:'var(--tl-cut-dead)', filler:'var(--tl-cut-filler)', retake:'var(--tl-cut-retake)',
    dead_air:'var(--tl-cut-dead)', weak:'var(--tl-cut-weak)',
  };
  const _cutTypeLabel={
    dead:'✕ dead', filler:'✕ filler', retake:'✕ retake', dead_air:'✕ silence', weak:'? weak',
  };
  const ss=document.getElementById('suggestionStrip'); ss.innerHTML='';
  const ssFrag=document.createDocumentFragment();
  if(S.silenceVisible){
    // Highlights → thin top bar on the video track, not a full-height wash
    S.cuts.filter(c=>c.type==='highlight').forEach(cut=>{
      const tlStart = sourceTimeToTimeline(cut.start);
      const tlEnd   = sourceTimeToTimeline(cut.end);
      if(tlStart === null && tlEnd === null) return;
      const safeStart = tlStart ?? sourceTimeToTimeline(cut.start + 0.05) ?? 0;
      const safeEnd   = tlEnd   ?? sourceTimeToTimeline(cut.end   - 0.05) ?? safeStart + (cut.end - cut.start);
      const clampedStart = Math.max(0, Math.min(safeStart, totalDur));
      const clampedEnd   = Math.max(0, Math.min(safeEnd,   totalDur));
      if(clampedEnd <= clampedStart) return;

      const left  = clampedStart * zoom;
      const width = Math.max((clampedEnd - clampedStart) * zoom, 6);

      const bar=document.createElement('div');
      bar.className='tl-highlight-bar';
      bar.style.left=left+'px'; bar.style.width=width+'px';
      bar.dataset.cutId=cut.id;
      bar.title=`✦ Best Part · ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s${cut.aiNote?' · '+cut.aiNote:''}`;
      bar.addEventListener('click',e=>{
        e.stopPropagation();
        S.selectedCutId=cut.id;
        S.selectedSegmentId=null;
        if(video.src) video.currentTime=cut.start;
        toast(`✦ Highlight · ${cut.start.toFixed(2)}s → ${cut.end.toFixed(2)}s`);
      });
      vtFrag.appendChild(bar);
    });

    // Selected cuts → one solid element per cut on the video track (only before snap)
    if(!S.snapped){
      S.cuts.filter(c=>c.selected && c.type!=='highlight').forEach(cut=>{
        const tlStart=sourceTimeToTimeline(cut.start);
        const tlEnd=sourceTimeToTimeline(cut.end);
        if(tlStart===null && tlEnd===null) return;
        const safeStart=tlStart ?? sourceTimeToTimeline(cut.start+0.05) ?? 0;
        const safeEnd=tlEnd ?? sourceTimeToTimeline(cut.end-0.05) ?? safeStart+(cut.end-cut.start);
        const left=safeStart*zoom;
        const width=Math.max((safeEnd-safeStart)*zoom,6);
        const color=_cutTypeColor[cut.type]||_cutTypeColor.dead;
        const tooltip=`${cut.type||'cut'}: ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s${cut.aiNote?' · '+cut.aiNote:''}`;

        const el=document.createElement('div');
        el.className='tl-cut'+(cut.id===S.selectedCutId?' cut-selected':'');
        el.style.left=left+'px'; el.style.width=width+'px';
        el.style.background=color;
        el.dataset.cutId=cut.id;
        el.title=tooltip;
        // script-part fillers render as dotted teal outline — no fill, no cut
        if(cut.type==='filler' && cut.scriptPart) el.classList.add('tl-cut-scriptpart');
        el.addEventListener('click',e=>{
          e.stopPropagation();
          selectCut(cut.id);
        });
        _bindCutDrag(el, cut);
        if(width>30){
          const lbl=document.createElement('span');
          lbl.className='tl-cut-label';
          lbl.textContent=(cut.type==='filler'&&cut.scriptPart)?'~ script':(_cutTypeLabel[cut.type]||_cutTypeLabel.dead);
          el.appendChild(lbl);
        }
        vtFrag.appendChild(el);
      });
    }

    // Unselected cuts → suggestion strip (own lane, solid mini-bars), only before snap
    if(!S.snapped) S.cuts.filter(c=>!c.selected && c.type!=='highlight').forEach(cut=>{
      const tlStart=sourceTimeToTimeline(cut.start);
      const tlEnd=sourceTimeToTimeline(cut.end);
      if(tlStart===null && tlEnd===null) return;
      const safeStart=tlStart ?? sourceTimeToTimeline(cut.start+0.05) ?? 0;
      const safeEnd=tlEnd ?? sourceTimeToTimeline(cut.end-0.05) ?? safeStart+(cut.end-cut.start);
      const left=safeStart*zoom;
      const width=Math.max((safeEnd-safeStart)*zoom,3);
      const color=_cutTypeColor[cut.type]||_cutTypeColor.dead;
      const tooltip=`${cut.type||'cut'}: ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s${cut.aiNote?' · '+cut.aiNote:''}`;
      const el=document.createElement('div');
      el.className='tl-sugg';
      el.style.left=left+'px'; el.style.width=width+'px';
      el.style.background=color;
      el.title=tooltip;
      el.addEventListener('click',e=>{e.stopPropagation();selectCut(cut.id);});
      ssFrag.appendChild(el);
    });
  }
  vt.appendChild(vtFrag);
  ss.appendChild(ssFrag);
  updateCutBadge();

  // ── CAPTION TRACK ───────────────────────────────────────────
  // One block per S.captions entry — the same unit the transcript tab edits
  // (word-chunks, or whatever a manual split/merge in the transcript editor
  // produced) — so what you see here is exactly what you see there, and each
  // block is individually draggable/resizable. Below ~15px/s a real block
  // would be a sliver anyway, so fall back to a merged solid strip purely for
  // readability (no editing available at that zoom).
  const ct=document.getElementById('captionTrack'); ct.innerHTML='';
  const ctFrag=document.createDocumentFragment();
  const _capMerged = zoom<15;
  const capItems = _capMerged ? _mergeCaptionsIntoStrip(S.captions) : S.captions;

  capItems.forEach((c,i)=>{
    const tlStart=sourceTimeToTimeline(c.start);
    const tlEnd=sourceTimeToTimeline(c.end);
    if(tlStart===null && tlEnd===null) return;
    const safeStart=tlStart ?? sourceTimeToTimeline(c.start+0.05) ?? 0;
    const safeEnd=tlEnd ?? sourceTimeToTimeline(c.end-0.05) ?? safeStart+(c.end-c.start);
    // Clamp width to the next block's start so adjacent blocks physically cannot overlap
    let nextTl=null;
    if(i<capItems.length-1) nextTl=sourceTimeToTimeline(capItems[i+1].start) ?? capItems[i+1].start;
    let width=(safeEnd-safeStart)*zoom;
    if(nextTl!==null) width=Math.min(width,(nextTl-safeStart)*zoom-1);
    width=Math.max(width,2);
    const el=document.createElement('div');
    el.className='tl-clip caption';
    el.style.left=(safeStart*zoom)+'px';
    el.style.width=width+'px';
    if(c.text){
      el.title=c.text;
      el.innerHTML=`${c.text.slice(0,18)}${c.text.length>18?'…':''}`;
      el.onclick=()=>seekTo(c.start);
    } else {
      el.title='Speech';
    }
    if(!_capMerged) _bindCaptionDrag(el, c);
    ctFrag.appendChild(el);
  });
  ct.appendChild(ctFrag);

  // ── TEXT LAYERS ("Add Text") ────────────────────────────────────────
  const tlt=document.getElementById('textLayerTrack'); tlt.innerHTML='';
  const tltFrag=document.createDocumentFragment();
  S.textLayers.forEach(layer=>{
    const tlStart=sourceTimeToTimeline(layer.start);
    const tlEnd=sourceTimeToTimeline(layer.end);
    if(tlStart===null && tlEnd===null) return;
    const safeStart=tlStart ?? sourceTimeToTimeline(layer.start+0.05) ?? 0;
    const safeEnd=tlEnd ?? sourceTimeToTimeline(layer.end-0.05) ?? safeStart+(layer.end-layer.start);
    const left=safeStart*zoom;
    const width=Math.max((safeEnd-safeStart)*zoom,20);
    const el=document.createElement('div');
    el.className='tl-textlayer'+(layer.id===S.selectedTextLayerId?' selected':'');
    el.style.left=left+'px';
    el.style.width=width+'px';
    el.dataset.textId=layer.id;
    el.textContent=layer.text||'Text';
    el.title=layer.text||'Text';
    el.addEventListener('click',e=>{ e.stopPropagation(); selectTextLayer(layer.id); });
    _bindTextLayerDrag(el, layer);
    tltFrag.appendChild(el);
  });
  tlt.appendChild(tltFrag);

  // ── IMAGE LAYERS ("+ Image" stickers) ────────────────────────────────
  const ilt=document.getElementById('imageLayerTrack'); ilt.innerHTML='';
  const iltFrag=document.createDocumentFragment();
  S.imageLayers.forEach(layer=>{
    const tlStart=sourceTimeToTimeline(layer.start);
    const tlEnd=sourceTimeToTimeline(layer.end);
    if(tlStart===null && tlEnd===null) return;
    const safeStart=tlStart ?? sourceTimeToTimeline(layer.start+0.05) ?? 0;
    const safeEnd=tlEnd ?? sourceTimeToTimeline(layer.end-0.05) ?? safeStart+(layer.end-layer.start);
    const left=safeStart*zoom;
    const width=Math.max((safeEnd-safeStart)*zoom,20);
    const el=document.createElement('div');
    el.className='tl-imagelayer'+(layer.id===S.selectedImageLayerId?' selected':'');
    el.style.left=left+'px';
    el.style.width=width+'px';
    el.dataset.imgId=layer.id;
    const fname=(layer.path||'').split(/[/\\]/).pop()||'Image';
    el.textContent=fname;
    el.title=fname;
    el.addEventListener('click',e=>{ e.stopPropagation(); selectImageLayer(layer.id); });
    _bindImageLayerDrag(el, layer);
    iltFrag.appendChild(el);
  });
  ilt.appendChild(iltFrag);

  // Redraw waveform only if something that affects its shape actually changed
  // (zoom, segment layout, or the waveform data itself) — posting an identical
  // draw_tl message on every render (e.g. a pure selection change) is wasted
  // work for the worker/main-thread canvas draw.
  if(S.waveformData){
    const waveSig = S.zoom+'|'+S.segments.map(s=>s.timelineStart+':'+s.duration).join(',');
    if(waveSig !== _lastWaveSig || S.waveformData !== _lastWaveformDataRef){
      _lastWaveSig = waveSig;
      _lastWaveformDataRef = S.waveformData;
      drawTimelineWaveform();
    }
  }

  // Enforce strict DOM order: ruler → suggestionStrip → videoTrack → waveformRow → captionTrack → textLayerTrack → imageLayerTrack → playhead
  const ti=document.getElementById('tracksInner');
  [
    document.getElementById('ruler'),
    document.getElementById('suggestionStrip'),
    document.getElementById('videoTrack'),
    document.getElementById('waveformRow'),
    document.getElementById('captionTrack'),
    document.getElementById('textLayerTrack'),
    document.getElementById('imageLayerTrack'),
    ph,
  ].forEach(el=>ti.appendChild(el));
  updatePlayhead();
  updateCutBadge();
}

// Stashed so the scroll handler can re-run just the ruler without a full
// renderTimeline() (F-B1) — ticks are the single biggest DOM-node source on
// long clips (duration/interval of them), so this is the highest-value
// virtualization target.
let _lastRulerParams=null;

function buildRuler(totalDur,totalW,zoom){
  _lastRulerParams={totalDur,totalW,zoom};
  const r=document.getElementById('ruler');
  r.style.width=totalW+'px'; r.innerHTML='';
  const frag=document.createDocumentFragment();
  const interval=zoom>=80?1:zoom>=40?2:zoom>=20?5:10;
  const step=interval/4;
  const margin=300; // px either side of the visible scroll window
  const viewStart=Math.max(0,(tArea.scrollLeft-margin))/zoom;
  const viewEnd=(tArea.scrollLeft+tArea.clientWidth+margin)/zoom;
  const tStart=Math.max(0,Math.floor(viewStart/step)*step);
  const tEnd=Math.min(totalDur,viewEnd);
  for(let t=tStart;t<=tEnd;t+=step){
    const isMaj=Math.abs(t%interval)<1e-6 || Math.abs(t%interval-interval)<1e-6;
    const m=document.createElement('div'); m.className='ruler-mark'; m.style.left=(t*zoom)+'px';
    const l=document.createElement('div'); l.className='ruler-line'+(isMaj?' maj':''); m.appendChild(l);
    if(isMaj){const n=document.createElement('div');n.className='ruler-num';n.textContent=t>=60?`${Math.floor(t/60)}:${String(Math.round(t%60)).padStart(2,'0')}`:`${t}s`;m.appendChild(n);}
    frag.appendChild(m);
  }
  // Markers — usually few, no virtualization needed
  S.markers.forEach(mk=>{
    const el=document.createElement('div');
    el.style.cssText=`position:absolute;top:0;left:${mk.t*zoom}px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;pointer-events:none;`;
    el.innerHTML=`<span style="color:var(--accent);font-size:9px;line-height:1">♦</span><span style="color:var(--accent);font-size:7px;white-space:nowrap;margin-top:1px">${mk.name}</span>`;
    frag.appendChild(el);
  });
  r.appendChild(frag);
}

// Re-render just the ruler as the user scrolls, rAF-throttled — avoids a
// full renderTimeline() (segments/cuts/captions/waveform) on pure scroll.
let _rulerScrollRafPending=false;
tArea.addEventListener('scroll',()=>{
  if(!_lastRulerParams || _rulerScrollRafPending) return;
  _rulerScrollRafPending=true;
  requestAnimationFrame(()=>{
    _rulerScrollRafPending=false;
    if(_lastRulerParams) buildRuler(_lastRulerParams.totalDur,_lastRulerParams.totalW,_lastRulerParams.zoom);
  });
});

// overrideSrcTime: see updateCaptionOverlay() — proxy playback passes the
// mapped source time explicitly since video.currentTime is proxy-space there.
function updatePlayhead(overrideSrcTime){
  const x=getPlayheadPosition(overrideSrcTime);
  ph.style.left=x+'px';
  if(x>tArea.scrollLeft+tArea.clientWidth-60) tArea.scrollLeft=x-80;
}

function handleTLClick(e){
  const r    = tArea.getBoundingClientRect();
  const x    = e.clientX - r.left + tArea.scrollLeft;
  const tlPos = x / S.zoom;  // timeline seconds

  // Convert timeline position → source time via segment offsets.
  // Without this, trimBefore (sourceStart > timelineStart=0) causes the
  // playhead to appear frozen because click→src and src→pixel are inconsistent.
  let srcTime = tlPos;
  if(S.segments.length){
    let matched = false;
    for(const seg of S.segments){
      const segEndTl = seg.timelineStart + seg.duration;
      if(tlPos >= seg.timelineStart && tlPos <= segEndTl){
        srcTime = seg.sourceStart + (tlPos - seg.timelineStart);
        matched = true;
        break;
      }
    }
    if(!matched){
      // Click landed in a gap (pre-snap) or outside all segments — snap to the
      // nearer boundary: the end of the segment before the click, or the start
      // of the segment after it.
      const first = S.segments[0], last = S.segments[S.segments.length-1];
      if(tlPos <= first.timelineStart){
        srcTime = first.sourceStart;
      } else if(tlPos >= last.timelineStart+last.duration){
        srcTime = last.sourceEnd;
      } else {
        let prevSeg=null, nextSeg=null;
        for(const seg of S.segments){
          const segEndTl = seg.timelineStart + seg.duration;
          if(segEndTl <= tlPos) prevSeg = seg;
          if(!nextSeg && seg.timelineStart >= tlPos) nextSeg = seg;
        }
        const distToPrev = prevSeg ? tlPos-(prevSeg.timelineStart+prevSeg.duration) : Infinity;
        const distToNext = nextSeg ? nextSeg.timelineStart-tlPos : Infinity;
        srcTime = (distToNext <= distToPrev) ? nextSeg.sourceStart : prevSeg.sourceEnd;
      }
    }
  }

  if(video.src && srcTime >= 0){
    const clampedSrc = clamp(srcTime, S.trimIn, S.trimOut || S.duration);
    // Proxy playback needs the source timestamp mapped into the proxy file's
    // own (gapless) time — video.currentTime there is proxy-space, not
    // source-space (see the PREVIEW PROXY section in playback.js).
    if(S.proxyActive){
      const proxyTime = _sourceToProxyTime(clampedSrc);
      if(proxyTime !== null) video.currentTime = proxyTime;
    } else {
      video.currentTime = clampedSrc;
    }
  }
}

tArea.addEventListener('click',e=>{
  if(_mqFinished){ _mqFinished=false; return; }
  // Scrub to clicked time
  handleTLClick(e);
  // Deselect if clicking empty track space (not a clip)
  if(e.target===tArea||e.target.id==='tracksInner'||e.target.classList.contains('track-row')||e.target.classList.contains('ruler')||e.target.classList.contains('suggestion-strip')){
    document.querySelectorAll('.tl-clip').forEach(c=>c.classList.remove('selected'));
    S.selectedClipId=null;
    S.selectedCutId=null;
    S.selectedSegmentId=null;
    document.querySelectorAll('.tl-cut').forEach(el=>el.classList.remove('cut-selected'));
    if(S.current){
      S.trimIn=S.current.trimIn||0;
      S.trimOut=S.current.trimOut||S.duration;
      updateTrimUI();
    }
    updateTrimContext();
  }
});

let _tlRafPending=false;
tArea.addEventListener('mousemove',e=>{
  if(!e.buttons) return; // only while mouse button held (scrub drag)
  if(_mqActive) return;
  if(_tlRafPending) return;
  _tlRafPending=true;
  requestAnimationFrame(()=>{ handleTLClick(e); _tlRafPending=false; });
});

function zoomTL(d){S.zoom=clamp(S.zoom+d*15,20,200);renderTimeline();}
function snapPlayhead(){if(!video.src)return;const x=getPlayheadPosition();tArea.scrollLeft=Math.max(0,x-tArea.clientWidth/2);}
function snapGaps(){
  if(!S.segments.length){toast('No segments');return;}
  saveHistory();
  S.snapped=true;
  _relayoutSegments();
  renderTimeline();
  // Sync to pywebview shared state
  if(window.pywebview?.state) window.pywebview.state.segments = S.segments;
  toast('⊞ Gaps closed');
}

// ═══════════════════════════════════════
// CLIP LIST
// ═══════════════════════════════════════
function renderClipList(){
  const el=document.getElementById('clipList');
  if(!S.clips.length){el.innerHTML='<div class="empty-state">No clips yet</div>';return;}
  el.innerHTML=S.clips.map(c=>`
    <div class="clip-item ${S.current&&S.current.id===c.id?'active':''}" onclick="selectClip('${c.id}')">
      <div class="clip-thumb">🎬<span class="clip-dur">${fmt(c.duration)}</span></div>
      <button class="clip-del" onclick="event.stopPropagation();deleteClipById('${c.id}')" title="Delete clip">✕</button>
      <div class="clip-info"><div class="clip-name">${c.name}</div></div>
    </div>`).join('');
}

// ═══════════════════════════════════════
// ZOOM TO FIT
// ═══════════════════════════════════════
function zoomToFit(){
  if(!S.current) return;
  const dur=S.trimOut-S.trimIn;
  S.zoom=Math.max(1,Math.floor((tArea.clientWidth-20)/dur));
  renderTimeline();
  toast('↔ Zoom to fit');
}
tArea.addEventListener('dblclick',zoomToFit);
