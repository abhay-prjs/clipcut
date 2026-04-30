// ═══════════════════════════════════════
// TIMELINE
// ═══════════════════════════════════════
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
    vt.appendChild(el);
  });

  // ── CUTS ────────────────────────────────────────────────────
  if(S.silenceVisible){
    const _cutColors={
      dead:      {bg:'rgba(255,84,97,.35)',   line:'#ff5461', label:'✕ dead'},
      filler:    {bg:'rgba(167,139,250,.35)', line:'#a78bfa', label:'✕ filler'},
      retake:    {bg:'rgba(255,84,97,.5)',    line:'#ff0000', label:'✕ retake'},
      dead_air:  {bg:'rgba(255,140,0,.35)',   line:'#ff8c00', label:'✕ silence'},
      weak:      {bg:'rgba(250,204,21,.3)',   line:'#facc15', label:'? weak'},
      highlight: {bg:'rgba(56,232,200,.18)',  line:'#38e8c8', label:'✦ best'},
    };
    const _pendColors={
      dead:      {bg:'rgba(255,84,97,.10)',   border:'rgba(255,84,97,.3)',   label:'✕'},
      filler:    {bg:'rgba(167,139,250,.10)', border:'rgba(167,139,250,.3)', label:'f'},
      retake:    {bg:'rgba(255,84,97,.15)',   border:'rgba(255,84,97,.4)',   label:'R'},
      dead_air:  {bg:'rgba(255,140,0,.10)',   border:'rgba(255,140,0,.3)',   label:'…'},
      weak:      {bg:'rgba(250,204,21,.08)',  border:'rgba(250,204,21,.25)', label:'?'},
      highlight: {bg:'rgba(56,232,200,.10)',  border:'rgba(56,232,200,.35)', label:'✦'},
    };

    // Clear stale waveform-row overlays (keep the canvas element)
    const wr=document.getElementById('waveformRow');
    Array.from(wr.children).forEach(el=>{if(el.id!=='tlWaveCanvas') wr.removeChild(el);});

    // Highlights → always-visible teal "keep" zones (rendered before cut zones)
    S.cuts.filter(c=>c.type==='highlight').forEach(cut=>{
      // Map source timestamps to timeline positions — handles snapped/cut timelines
      const tlStart = sourceTimeToTimeline(cut.start);
      const tlEnd   = sourceTimeToTimeline(cut.end);
      // Skip if both endpoints fall in removed regions or beyond the timeline
      if(tlStart === null && tlEnd === null) return;
      const safeStart = tlStart ?? sourceTimeToTimeline(cut.start + 0.05) ?? 0;
      const safeEnd   = tlEnd   ?? sourceTimeToTimeline(cut.end   - 0.05) ?? safeStart + (cut.end - cut.start);
      // Clamp to actual timeline duration so nothing overflows
      const clampedStart = Math.max(0, Math.min(safeStart, totalDur));
      const clampedEnd   = Math.max(0, Math.min(safeEnd,   totalDur));
      if(clampedEnd <= clampedStart) return;

      const left  = clampedStart * zoom;
      const width = Math.max((clampedEnd - clampedStart) * zoom, 6);

      const fill=document.createElement('div');
      fill.style.cssText=`position:absolute;top:0;bottom:0;left:${left}px;width:${width}px;background:rgba(56,232,200,.12);border-top:2px solid rgba(56,232,200,.6);border-bottom:2px solid rgba(56,232,200,.6);z-index:5;pointer-events:all;cursor:pointer;`;
      fill.dataset.cutId=cut.id;
      fill.title=`✦ Best Part · ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s${cut.aiNote?' · '+cut.aiNote:''}`;
      fill.addEventListener('click',e=>{
        e.stopPropagation();
        S.selectedCutId=cut.id;
        S.selectedSegmentId=null;
        if(video.src) video.currentTime=cut.start;
        toast(`✦ Highlight · ${cut.start.toFixed(2)}s → ${cut.end.toFixed(2)}s`);
      });
      vt.appendChild(fill);
      if(width>30){
        const lbl=document.createElement('div');
        lbl.style.cssText=`position:absolute;top:50%;left:${left+4}px;transform:translateY(-50%);font-size:8px;font-weight:700;color:#38e8c8;white-space:nowrap;z-index:8;pointer-events:none;text-shadow:0 0 6px rgba(56,232,200,.5);`;
        lbl.textContent='✦ best part';
        vt.appendChild(lbl);
      }
      // Mirror on waveform row
      const wf=document.createElement('div');
      wf.style.cssText=`position:absolute;top:0;bottom:0;left:${left}px;width:${width}px;background:rgba(56,232,200,.1);border-top:1px solid rgba(56,232,200,.4);border-bottom:1px solid rgba(56,232,200,.4);pointer-events:none;z-index:3;`;
      wr.appendChild(wf);
    });

    // Selected cuts → red gap zones on video + waveform rows (only before snap)
    if(!S.snapped){
      S.cuts.filter(c=>c.selected && c.type!=='highlight').forEach(cut=>{
        const left=cut.start*zoom;
        const width=Math.max((cut.end-cut.start)*zoom,6);
        const c=_cutColors[cut.type]||_cutColors.dead;
        const tooltip=`${cut.type||'cut'}: ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s${cut.aiNote?' · '+cut.aiNote:''}`;

        const fill=document.createElement('div');
        fill.style.cssText=`position:absolute;top:0;bottom:0;left:${left}px;width:${width}px;background:${c.bg};`;
        fill.style.pointerEvents='all';
        fill.style.cursor='pointer';
        fill.style.zIndex='6';
        fill.dataset.cutId=cut.id;
        fill.classList.add('cut-fill');
        fill.title=tooltip;
        fill.addEventListener('click',e=>{
          e.stopPropagation();
          document.querySelectorAll('.cut-fill').forEach(el=>{el.style.outline='none';el.style.filter='none';});
          document.querySelectorAll('.tl-clip').forEach(el=>el.classList.remove('selected'));
          S.selectedCutId=cut.id;
          S.selectedSegmentId=null;
          fill.style.outline='2px solid #fff';
          fill.style.filter='brightness(1.4)';
          // Do NOT write to S.trimIn/S.trimOut — clip-level trim state
          // updateTrimUI() reads cut.start/end via S.selectedCutId
          updateTrimUI();
          updateTrimContext();
          if(video.src) video.currentTime=cut.start;
          toast(`● Cut selected · ${cut.start.toFixed(2)}s → ${cut.end.toFixed(2)}s · ${(cut.end-cut.start).toFixed(2)}s`);
        });
        // script-part fillers render as dotted teal outline — no fill, no cut
        if(cut.type==='filler' && cut.scriptPart){
          fill.style.background='transparent';
          fill.style.border='1px dotted rgba(56,232,200,.4)';
          fill.style.opacity='0.5';
        }
        vt.appendChild(fill);

        const lineL=document.createElement('div');
        lineL.style.cssText=`position:absolute;top:0;bottom:0;left:${left}px;width:2px;background:${c.line};z-index:4;pointer-events:none;`;
        vt.appendChild(lineL);
        const lineR=document.createElement('div');
        lineR.style.cssText=`position:absolute;top:0;bottom:0;left:${left+width-2}px;width:2px;background:${c.line};z-index:4;pointer-events:none;`;
        vt.appendChild(lineR);
        if(width>30){
          const lbl=document.createElement('div');
          lbl.style.cssText=`position:absolute;top:50%;left:${left+3}px;transform:translateY(-50%);font-size:8px;font-weight:700;color:${c.line};white-space:nowrap;z-index:7;pointer-events:all;cursor:pointer;text-shadow:0 0 4px rgba(0,0,0,.8);`;
          lbl.textContent=(cut.type==='filler'&&cut.scriptPart)?'~ script':c.label;
          lbl.style.color=(cut.type==='filler'&&cut.scriptPart)?'var(--teal)':c.line;
          lbl.addEventListener('click',e=>{e.stopPropagation();fill.click();});
          vt.appendChild(lbl);
        }

        // Mirror on waveform row
        const wf=document.createElement('div');
        wf.style.cssText=`position:absolute;top:0;bottom:0;left:${left}px;width:${width}px;background:${c.bg};pointer-events:none;z-index:3;`;
        wr.appendChild(wf);
        const wfL=document.createElement('div');
        wfL.style.cssText=`position:absolute;top:0;bottom:0;left:${left}px;width:2px;background:${c.line};z-index:4;pointer-events:none;`;
        wr.appendChild(wfL);
        const wfR=document.createElement('div');
        wfR.style.cssText=`position:absolute;top:0;bottom:0;left:${left+width-2}px;width:2px;background:${c.line};z-index:4;pointer-events:none;`;
        wr.appendChild(wfR);
      });
    }

    // Unselected cuts → faint suggestion markers (always visible, highlights already rendered above)
    S.cuts.filter(c=>!c.selected && c.type!=='highlight').forEach(cut=>{
      const left=cut.start*zoom;
      const width=Math.max((cut.end-cut.start)*zoom,6);
      const c=_pendColors[cut.type]||_pendColors.dead;
      const tooltip=`${cut.type||'cut'}: ${cut.start.toFixed(2)}–${cut.end.toFixed(2)}s${cut.aiNote?' · '+cut.aiNote:''}`;
      const el=document.createElement('div');
      el.className='tl-clip silence';
      el.style.left=left+'px'; el.style.width=Math.max(width,8)+'px';
      el.style.top='0'; el.style.bottom='0';
      el.style.background=c.bg; el.style.borderColor=c.border;
      el.innerHTML=c.label; el.title=tooltip;
      vt.appendChild(el);
    });
  }
  updateCutBadge();

  // ── CAPTION TRACK ───────────────────────────────────────────
  const ct=document.getElementById('captionTrack'); ct.innerHTML='';
  S.captions.forEach(c=>{
    const el=document.createElement('div');
    el.className='tl-clip caption';
    el.style.left=(c.start*zoom)+'px';
    el.style.width=Math.max((c.end-c.start)*zoom,30)+'px';
    el.title=c.text;
    el.innerHTML=`💬 ${c.text.slice(0,14)}${c.text.length>14?'…':''}`;
    el.onclick=()=>seekTo(c.start);
    ct.appendChild(el);
  });

  // Redraw waveform if data available
  if(S.waveformData) drawTimelineWaveform();

  // Enforce strict DOM order: ruler → videoTrack → waveformRow → captionTrack → playhead
  const ti=document.getElementById('tracksInner');
  [
    document.getElementById('ruler'),
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
  const interval=zoom>=80?1:zoom>=40?2:zoom>=20?5:10;
  for(let t=0;t<=totalDur;t+=interval/4){
    const isMaj=t%interval===0;
    const m=document.createElement('div'); m.className='ruler-mark'; m.style.left=(t*zoom)+'px';
    const l=document.createElement('div'); l.className='ruler-line'+(isMaj?' maj':''); m.appendChild(l);
    if(isMaj){const n=document.createElement('div');n.className='ruler-num';n.textContent=t>=60?`${Math.floor(t/60)}:${String(Math.round(t%60)).padStart(2,'0')}`:`${t}s`;m.appendChild(n);}
    r.appendChild(m);
  }
  // Markers
  S.markers.forEach(mk=>{
    const el=document.createElement('div');
    el.style.cssText=`position:absolute;top:0;left:${mk.t*zoom}px;transform:translateX(-50%);display:flex;flex-direction:column;align-items:center;pointer-events:none;`;
    el.innerHTML=`<span style="color:var(--accent);font-size:9px;line-height:1">♦</span><span style="color:var(--accent);font-size:7px;white-space:nowrap;margin-top:1px">${mk.name}</span>`;
    r.appendChild(el);
  });
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
    for(const seg of S.segments){
      const segEndTl = seg.timelineStart + seg.duration;
      if(tlPos >= seg.timelineStart && tlPos <= segEndTl){
        srcTime = seg.sourceStart + (tlPos - seg.timelineStart);
        break;
      }
      // Past last segment — clamp to end of last segment's source range
      srcTime = S.segments[S.segments.length-1].sourceEnd;
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
  if(e.target===tArea||e.target.id==='tracksInner'||e.target.classList.contains('track-row')||e.target.classList.contains('ruler')){
    document.querySelectorAll('.tl-clip').forEach(c=>c.classList.remove('selected'));
    S.selectedClipId=null;
    S.selectedCutId=null;
    S.selectedSegmentId=null;
    document.querySelectorAll('.cut-fill').forEach(el=>{el.style.outline='none';el.style.zIndex='3';});
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
      <div class="clip-thumb">🎬</div>
      <div class="clip-info"><div class="clip-name">${c.name}</div><div class="clip-dur">${fmt(c.duration)}</div></div>
    </div>`).join('');
}

// ═══════════════════════════════════════
// ZOOM TO FIT
// ═══════════════════════════════════════
tArea.addEventListener('dblclick',()=>{
  if(!S.current) return;
  const dur=S.trimOut-S.trimIn;
  S.zoom=Math.max(1,Math.floor((tArea.clientWidth-20)/dur));
  renderTimeline();
  toast('↔ Zoom to fit');
});
