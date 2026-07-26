// ═══════════════════════════════════════
// EDIT LINT — Tier 1 deterministic checks (Part F2)
// ═══════════════════════════════════════
// Runs entirely from data already in memory (caption/word timestamps, RMS
// waveform frames) against the currently SELECTED (pending, not-yet-applied)
// cuts — reviewed right before "Apply Selected Cuts", not after. Doing it
// pre-apply (rather than against already-committed S.segments) is a
// deliberate call: every fix here is a plain S.cuts edit going through the
// normal saveHistory()->mutate->render pipeline, which stays simple and
// undoable. Post-apply, cuts no longer exist as objects (applyCuts() removes
// them from S.cuts), so "merge these two cuts" or "snap this edge" wouldn't
// have anything left to act on without segment surgery.
//
// Nothing here auto-removes anything (rule #1) — findings are advisory,
// each optional "Fix" button still goes through saveHistory().

let S_lintFindings = [];

const LINT_ORPHAN_MIN_DUR            = 0.5;  // seconds — gap between two selected cuts shorter than this is noise
const LINT_PACING_WINDOW             = 10;   // seconds
const LINT_PACING_MAX_CUTS           = 6;    // selected-cut starts within the window before flagging
const LINT_SENTENCE_AMPUTATION_RATIO = 0.6;  // fraction of a sentence removed before flagging
const LINT_POP_SEARCH_RADIUS         = 0.15; // seconds either side to search for a quieter (RMS valley) point
const LINT_DEAD_EDGE_MIN             = 0.3;  // seconds of unflagged lead/trail silence before flagging

function runEditLint(){
  if(!S.cuts.some(c=>c.selected)){
    S_lintFindings = [];
    renderLintFindings();
    toast('No selected cuts to check — detect or select cuts first');
    return;
  }
  S_lintFindings = [
    ..._lintMidWordCuts(),
    ..._lintAudioPops(),
    ..._lintOrphanSlivers(),
    ..._lintPacing(),
    ..._lintSentenceAmputation(),
    ..._lintDeadEdges(),
  ];
  renderLintFindings();
  toast(S_lintFindings.length
    ? `🔍 Edit check — ${S_lintFindings.length} issue${S_lintFindings.length!==1?'s':''} found`
    : '✓ Edit check — looks clean');
}

// ── Mid-word cut — a selected cut's start/end lands inside a caption's span.
// S.captions entries are the same "word boundary" granularity _cutSnapTargets()
// already treats as word edges elsewhere in the app (word-chunks at minimum).
function _lintMidWordCuts(){
  const out=[];
  S.cuts.filter(c=>c.selected).forEach(cut=>{
    ['start','end'].forEach(edge=>{
      const t=cut[edge];
      const w=S.captions.find(c=>t>c.start+0.02 && t<c.end-0.02);
      if(!w) return;
      out.push({
        type:'mid_word', time:t,
        message:`Cut ${edge} lands mid-word ("${w.text}")`,
        fix:()=>{
          const target=Math.abs(t-w.start)<Math.abs(t-w.end)?w.start:w.end;
          saveHistory();
          cut[edge]=target;
          buildPlaySegments(); renderAllFindings(); renderTimeline();
          runEditLint();
          toast('✓ Snapped to word boundary');
        },
      });
    });
  });
  return out;
}

// ── Audio-pop risk — a selected cut's edge lands during active audio rather
// than a quiet moment, risking an audible click on playback/export.
function _lintAudioPops(){
  const out=[];
  const frames=S.waveformData?.frames;
  if(!frames?.length) return out;
  const ss=getSilenceSettings();
  const linThresh=Math.pow(10,ss.threshold/20)*0.1;
  const frameAt=t=>{
    let best=null,bestDist=Infinity;
    for(const f of frames){ const d=Math.abs(f.t-t); if(d<bestDist){bestDist=d;best=f;} }
    return best;
  };
  S.cuts.filter(c=>c.selected).forEach(cut=>{
    ['start','end'].forEach(edge=>{
      const t=cut[edge];
      const f=frameAt(t);
      if(!f || f.rms<linThresh) return; // at/below the silence threshold — not a pop risk
      out.push({
        type:'audio_pop', time:t,
        message:`Cut ${edge} lands during active audio — may click on export`,
        fix:()=>{
          const nearby=frames.filter(fr=>Math.abs(fr.t-t)<=LINT_POP_SEARCH_RADIUS);
          if(!nearby.length) return;
          const valley=nearby.reduce((a,b)=>a.rms<b.rms?a:b);
          saveHistory();
          cut[edge]=valley.t;
          buildPlaySegments(); renderAllFindings(); renderTimeline();
          runEditLint();
          toast('✓ Snapped to a quieter point');
        },
      });
    });
  });
  return out;
}

// ── Orphan sliver — a kept gap between two selected cuts too short to read
// as an intentional pause. Fix reuses the existing mergeCuts() threshold-merge.
function _lintOrphanSlivers(){
  const out=[];
  const cuts=S.cuts.filter(c=>c.selected).sort((a,b)=>a.start-b.start);
  for(let i=0;i<cuts.length-1;i++){
    const gap=cuts[i+1].start-cuts[i].end;
    if(gap>0.001 && gap<LINT_ORPHAN_MIN_DUR){
      out.push({
        type:'orphan_sliver', time:cuts[i].end,
        message:`Only ${gap.toFixed(2)}s of footage kept between two cuts`,
        fix:()=>{ mergeCuts(LINT_ORPHAN_MIN_DUR); runEditLint(); },
      });
    }
  }
  return out;
}

// ── Machine-gun pacing — too many cut boundaries close together. No clean
// per-finding auto-fix beyond a broader merge, so it points at the same
// mergeCuts() helper with a looser threshold.
function _lintPacing(){
  const out=[];
  const cuts=S.cuts.filter(c=>c.selected).sort((a,b)=>a.start-b.start);
  let i=0;
  while(i<cuts.length){
    const windowStart=cuts[i].start;
    const windowCuts=cuts.filter(c=>c.start>=windowStart && c.start<windowStart+LINT_PACING_WINDOW);
    if(windowCuts.length>LINT_PACING_MAX_CUTS){
      out.push({
        type:'pacing', time:windowStart,
        message:`${windowCuts.length} cuts within ${LINT_PACING_WINDOW}s — likely to feel like machine-gun pacing`,
        fix:()=>{ mergeCuts(0.6); runEditLint(); },
      });
      i+=windowCuts.length; // skip past this cluster instead of re-flagging every cut inside it
    } else {
      i++;
    }
  }
  return out;
}

// ── Sentence amputation — flag only, no auto-fix (a content judgment call).
// Sentence grouping here is local/lightweight — closes on .!? or a >1s gap —
// used only to size "how much of this sentence got cut", not for rendering.
function _lintSentenceGroups(){
  const sorted=[...S.captions].sort((a,b)=>a.start-b.start);
  const groups=[]; let cur=null;
  for(const c of sorted){
    if(!cur || c.start-cur.end>1){ if(cur) groups.push(cur); cur={start:c.start,end:c.end}; }
    else cur.end=c.end;
    if(/[.!?]$/.test((c.text||'').trim())){ groups.push(cur); cur=null; }
  }
  if(cur) groups.push(cur);
  return groups;
}

function _lintSentenceAmputation(){
  const out=[];
  const sentences=_lintSentenceGroups();
  if(!sentences.length) return out;
  S.cuts.filter(c=>c.selected).forEach(cut=>{
    sentences.forEach(s=>{
      const overlap=Math.max(0, Math.min(cut.end,s.end)-Math.max(cut.start,s.start));
      const sentDur=s.end-s.start;
      if(sentDur>0 && overlap/sentDur>LINT_SENTENCE_AMPUTATION_RATIO){
        out.push({
          type:'sentence_amputation', time:cut.start,
          message:`Cut removes ${Math.round(overlap/sentDur*100)}% of a sentence — check it doesn't change the meaning`,
          fix:null,
        });
      }
    });
  });
  return out;
}

// ── Dead start/end — leading/trailing silence that no selected cut currently covers.
function _lintDeadEdges(){
  const out=[];
  if(!S.captions.length || !S.duration) return out;
  const sorted=[...S.captions].sort((a,b)=>a.start-b.start);
  const firstWord=sorted[0], lastWord=sorted[sorted.length-1];
  const coveredByCut=t=>S.cuts.some(c=>c.selected && c.start<=t && c.end>=t);

  if(firstWord.start>=LINT_DEAD_EDGE_MIN && !coveredByCut(firstWord.start/2)){
    out.push({
      type:'dead_start', time:0,
      message:`${firstWord.start.toFixed(2)}s of silence at the very start isn't covered by a cut`,
      fix:()=>{
        saveHistory();
        S.cuts.push({id:crypto.randomUUID(),start:0,end:firstWord.start,type:'dead_air',
          text:'',aiNote:'edit check: leading silence',selected:true,skipEnabled:true,scriptPart:false,_src:'lint'});
        renderAllFindings(); buildPlaySegments(); renderTimeline();
        runEditLint();
        toast('✓ Added cut for leading silence');
      },
    });
  }
  const trailing=S.duration-lastWord.end;
  if(trailing>=LINT_DEAD_EDGE_MIN && !coveredByCut(lastWord.end+trailing/2)){
    out.push({
      type:'dead_end', time:lastWord.end,
      message:`${trailing.toFixed(2)}s of silence at the very end isn't covered by a cut`,
      fix:()=>{
        saveHistory();
        S.cuts.push({id:crypto.randomUUID(),start:lastWord.end,end:S.duration,type:'dead_air',
          text:'',aiNote:'edit check: trailing silence',selected:true,skipEnabled:true,scriptPart:false,_src:'lint'});
        renderAllFindings(); buildPlaySegments(); renderTimeline();
        runEditLint();
        toast('✓ Added cut for trailing silence');
      },
    });
  }
  return out;
}

// ── Rendering ────────────────────────────────────────────────────────────
const _LINT_LABEL={
  mid_word:'Mid-word cut', audio_pop:'Audio pop risk', orphan_sliver:'Orphan sliver',
  pacing:'Pacing', sentence_amputation:'Sentence amputation',
  dead_start:'Unflagged silence', dead_end:'Unflagged silence',
};
const _LINT_COLOR={
  mid_word:'var(--tl-cut-weak)', audio_pop:'var(--red)', orphan_sliver:'#a855f7',
  pacing:'var(--tl-cut-weak)', sentence_amputation:'var(--teal)',
  dead_start:'var(--red)', dead_end:'var(--red)',
};

function renderLintFindings(){
  const el=document.getElementById('lintFindings');
  const stats=document.getElementById('lintStats');
  if(!el) return;
  if(!S_lintFindings.length){
    el.innerHTML='<div class="empty-state">Run a check before applying cuts</div>';
    if(stats) stats.textContent='';
    return;
  }
  if(stats) stats.textContent=`${S_lintFindings.length} issue${S_lintFindings.length!==1?'s':''}`;
  el.innerHTML=S_lintFindings.map((f,i)=>{
    const color=_LINT_COLOR[f.type]||'var(--text2)';
    return `<div class="sil-result-item" style="cursor:pointer;border-color:${color}" onclick="seekTo(${f.time})">
      <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
        <span style="font-size:9px;font-weight:700;color:${color};width:12px;text-align:center;flex-shrink:0">!</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:5px">
            <span style="font-size:8px;font-weight:700;color:${color};text-transform:uppercase;letter-spacing:.5px">${_LINT_LABEL[f.type]||f.type}</span>
            <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--text2)">@ ${f.time.toFixed(2)}s</span>
          </div>
          <div style="font-size:10px;color:var(--text);margin-top:1px">${f.message}</div>
        </div>
      </div>
      ${f.fix?`<button onclick="event.stopPropagation();_runLintFix(${i})" style="flex-shrink:0;font-size:8.5px;padding:3px 8px;border-radius:4px;background:${color};border:none;color:#000;font-weight:700;cursor:pointer">Fix</button>`:''}
    </div>`;
  }).join('');
}

function _runLintFix(idx){
  const f=S_lintFindings[idx];
  if(f?.fix) f.fix();
}
