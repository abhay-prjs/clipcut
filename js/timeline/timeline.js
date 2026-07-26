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

  // Total timeline duration — derived from segments when available
  let totalDur;
  if(S.segments.length){
    if(S.snapped){
      const last=S.segments[S.segments.length-1];
      totalDur=last.timelineStart+last.duration;
    } else {
      // Before snap: use sum of segment durations (= source content after applied cuts)
      totalDur=S.segments.reduce((sum,seg)=>sum+seg.duration,0);
    }
  } else {
    totalDur=Math.max(...S.clips.map(c=>c.duration),30);
  }
  const totalW=Math.max(totalDur*zoom+200,tArea.clientWidth||600);
  document.getElementById('tracksInner').style.width=totalW+'px';
  buildRuler(totalDur,totalW,zoom);

  // ── VIDEO TRACK: one element per segment ───────────────────
  const vt=document.getElementById('videoTrack'); vt.innerHTML='';
  const vtFrag=document.createDocumentFragment();
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
      renderTimeline();
      updateTrimContext();
    });
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
  // Zoom-aware granularity (Part C4/C5): word-level chunks are unreadable at
  // normal zoom (forced min-width made every chip overlap). Sentence-level is
  // the default; word-level only above ~150px/s; a merged solid strip (no
  // text) below ~30px/s.
  const ct=document.getElementById('captionTrack'); ct.innerHTML='';
  const ctFrag=document.createDocumentFragment();
  let capItems;
  if(zoom<30) capItems=_mergeCaptionsIntoStrip(S.captions);
  else if(zoom>=150) capItems=S.captions.map(c=>({start:c.start,end:c.end,text:c.text}));
  else capItems=_groupCaptionsIntoSentences(S.captions);

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
    ctFrag.appendChild(el);
  });
  ct.appendChild(ctFrag);

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

  // Enforce strict DOM order: ruler → suggestionStrip → videoTrack → waveformRow → captionTrack → playhead
  const ti=document.getElementById('tracksInner');
  [
    document.getElementById('ruler'),
    document.getElementById('suggestionStrip'),
    document.getElementById('videoTrack'),
    document.getElementById('waveformRow'),
    document.getElementById('captionTrack'),
    ph,
  ].forEach(el=>ti.appendChild(el));
  updatePlayhead();
  updateCutBadge();
}

function buildRuler(totalDur,totalW,zoom){
  const r=document.getElementById('ruler');
  r.style.width=totalW+'px'; r.innerHTML='';
  const frag=document.createDocumentFragment();
  const interval=zoom>=80?1:zoom>=40?2:zoom>=20?5:10;
  for(let t=0;t<=totalDur;t+=interval/4){
    const isMaj=t%interval===0;
    const m=document.createElement('div'); m.className='ruler-mark'; m.style.left=(t*zoom)+'px';
    const l=document.createElement('div'); l.className='ruler-line'+(isMaj?' maj':''); m.appendChild(l);
    if(isMaj){const n=document.createElement('div');n.className='ruler-num';n.textContent=t>=60?`${Math.floor(t/60)}:${String(Math.round(t%60)).padStart(2,'0')}`:`${t}s`;m.appendChild(n);}
    frag.appendChild(m);
  }
  // Markers
  S.markers.forEach(mk=>{
    const el=document.createElement('div');
    el.style.cssText=`position:absolute;top:0;left:${mk.t*zoom}px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;pointer-events:none;`;
    el.innerHTML=`<span style="color:var(--accent);font-size:9px;line-height:1">♦</span><span style="color:var(--accent);font-size:7px;white-space:nowrap;margin-top:1px">${mk.name}</span>`;
    frag.appendChild(el);
  });
  r.appendChild(frag);
}

function updatePlayhead(){
  const x=getPlayheadPosition();
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

  if(video.src && srcTime >= 0)
    video.currentTime = clamp(srcTime, S.trimIn, S.trimOut || S.duration);
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
  let cursor=0;
  S.segments.forEach(seg=>{
    seg.timelineStart=cursor;
    cursor+=seg.duration;
  });
  S.snapped=true;
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
