// ═══════════════════════════════════════
// SILENCE SETTINGS PERSISTENCE
// ═══════════════════════════════════════
const SILENCE_SETTINGS_KEY = 'vexxe_silence_settings';
const SILENCE_DEFAULTS = { threshold: -35, minDuration: 0.5, padBefore: 0.1, padAfter: 0.1 };

function saveSilenceSettings(){
  const settings = {
    threshold:   parseFloat(document.getElementById('silThreshold').value),
    minDuration: parseFloat(document.getElementById('silMinDur').value),
    padBefore:   parseFloat(document.getElementById('silPadBefore').value),
    padAfter:    parseFloat(document.getElementById('silPadAfter').value),
  };
  localStorage.setItem(SILENCE_SETTINGS_KEY, JSON.stringify(settings));
  // "Saved ✓" flash
  const flash = document.getElementById('silSavedFlash');
  if(flash){
    flash.style.opacity = '1';
    clearTimeout(flash._t);
    flash._t = setTimeout(()=>{ flash.style.opacity = '0'; }, 1000);
  }
}

function loadSilenceSettings(){
  let settings = SILENCE_DEFAULTS;
  try {
    const stored = localStorage.getItem(SILENCE_SETTINGS_KEY);
    if(stored) settings = { ...SILENCE_DEFAULTS, ...JSON.parse(stored) };
  } catch(e){ /* corrupt storage — use defaults */ }

  const thr = document.getElementById('silThreshold');
  const dur = document.getElementById('silMinDur');
  const pb  = document.getElementById('silPadBefore');
  const pa  = document.getElementById('silPadAfter');
  if(thr){ thr.value = settings.threshold;   document.getElementById('silThreshVal').textContent = settings.threshold + 'dB'; }
  if(dur){ dur.value = settings.minDuration;  document.getElementById('silDurVal').textContent    = settings.minDuration + 's'; }
  if(pb) { pb.value  = settings.padBefore;    document.getElementById('silPadBVal').textContent   = settings.padBefore + 's'; }
  if(pa) { pa.value  = settings.padAfter;     document.getElementById('silPadAVal').textContent   = settings.padAfter + 's'; }
}

function getSilenceSettings(){
  try {
    const stored = localStorage.getItem(SILENCE_SETTINGS_KEY);
    if(stored) return { ...SILENCE_DEFAULTS, ...JSON.parse(stored) };
  } catch(e){}
  return { ...SILENCE_DEFAULTS };
}

// ═══════════════════════════════════════
// AI SILENCE ANALYSIS
// ═══════════════════════════════════════
async function analyzeAudio(){
  if(!S.current){toast('No video loaded');return;}
  saveHistory();

  // ── Primary: server-side ffmpeg silencedetect ──────────────────
  const _ss        = getSilenceSettings();
  const threshold  = _ss.threshold + 'dB';
  const minDur     = _ss.minDuration;
  const padBefore  = _ss.padBefore;
  const padAfter   = _ss.padAfter;

  let serverCuts = null;
  try {
    if(!window.pywebview) throw new Error('no pywebview');
    if(!S.current.sourcePath) throw new Error('no sourcePath');
    toast('🔍 Analyzing via ffmpeg...');
    const data = await window.pywebview.api.detect_silence(
      S.current.sourcePath, threshold, minDur, padBefore, padAfter
    );
    if(data && data.cuts) serverCuts = data.cuts;
  } catch(e){
    console.warn('[ClipCut] detect_silence unavailable, falling back to Web Audio RMS', e.message);
  }

  let newCuts;
  const ts = Date.now();

  if(serverCuts){
    // Server returned cuts — map to S.cuts schema
    newCuts = serverCuts.map((c,i)=>({
      id:`audio-${ts}-${i}`, start:c.start, end:c.end,
      type:'dead_air', selected:c.selected!==false, skipEnabled:true, scriptPart:false,
      text:'', aiNote:'', _src:'audio'
    }));
  } else {
    // ── Fallback: Web Audio RMS ────────────────────────────────────
    const frames = await extractAudioData();
    if(!frames) return;
    const segs = detectSilences(frames);
    newCuts = segs.map((s,i)=>({
      id:`audio-${ts}-${i}`, start:s.start, end:s.end,
      type:'dead_air', selected:s.cut!==false, skipEnabled:true, scriptPart:false,
      text:'', aiNote:'', _src:'audio'
    }));
  }

  S.cuts = [...S.cuts.filter(c=>c._src!=='audio'), ...newCuts];
  renderAllFindings();
  renderTimeline();
  buildPlaySegments();
  toast(`Found ${newCuts.length} silence segment${newCuts.length===1?'':'s'}${serverCuts?'':' (Web Audio fallback)'}`);
}

async function detectDeadSpaces(){
  if(!S.current?.sourcePath){ toast('No video loaded'); return; }
  saveHistory();
  const ts=Date.now();

  // VAD path — runs on raw audio, no caption dependency
  if(S.settings.useVAD && window.pywebview){
    try{
      toast('🔍 Running Silero VAD...');
      const data=await window.pywebview.api.vad_detect(
        S.current.sourcePath,
        S.settings.vadThreshold,
        S.settings.vadMinSpeechMs,
        S.settings.vadMinSilenceMs
      );
      if(data.error) throw new Error(data.error);
      const newCuts=data.cuts.map((c,i)=>({
        id:`dead-${ts}-${i}`, start:c.start, end:c.end,
        type:'dead_air', selected:true, skipEnabled:true, scriptPart:false,
        text:'', aiNote:'silero vad', _src:'dead'
      }));
      jlog('info',`VAD: ${newCuts.length} cuts`);
      S.cuts=[...S.cuts.filter(c=>c._src!=='dead'),...newCuts];
      renderAllFindings(); renderTimeline(); buildPlaySegments();
      toast(`✦ ${newCuts.length} dead space${newCuts.length!==1?'s':''} (Silero VAD)`);
      return;
    } catch(e){
      console.warn('[ClipCut] vad_detect failed, falling back to RMS', e.message);
    }
  }

  // RMS fallback — no caption filtering, raw energy detection only
  if(!S.waveformData){ toast('Run waveform analysis first'); return; }
  const silences=detectSilences(S.waveformData.frames);
  const newCuts=silences.map((s,i)=>({
    id:`dead-${ts}-${i}`, start:s.start, end:s.end,
    type:'dead_air', selected:true, skipEnabled:true, scriptPart:false,
    text:'', aiNote:'dead space (rms)', _src:'dead'
  }));
  S.cuts=[...S.cuts.filter(c=>c._src!=='dead'),...newCuts];
  renderAllFindings(); renderTimeline(); buildPlaySegments();
  toast(`✦ ${newCuts.length} dead space${newCuts.length!==1?'s':''} (RMS)`);
}

function _updateDeadSpacesBtn(){
  const ready=!!S.current?.sourcePath;
  const engine=S.settings?.useVAD ? 'Silero VAD' : 'RMS';
  ['deadSpacesBtn','deadSpacesBtn2'].forEach(id=>{
    const btn=document.getElementById(id);
    if(!btn) return;
    btn.disabled=!ready;
    btn.style.opacity=ready?'1':'.45';
    btn.style.cursor=ready?'pointer':'not-allowed';
    btn.title=ready?`Detect dead spaces (${engine})`:'Load a video first';
  });
  const badge=document.getElementById('deadSpacesEngine');
  if(badge) badge.textContent=engine;
}

// ── FILLER WORDS ──────────────────────────────────────────────
const FILLER_WORDS=['um','uh','like','you know','literally','basically','actually',
  'right','so','i mean','kind of','sort of','you see'];

function detectFillers(){
  if(!S.captions.length){toast('Transcribe first');return;}
  saveHistory();
  const ts=Date.now();
  const newCuts=[];
  S.captions.forEach(c=>{
    const lower=c.text.toLowerCase().trim();
    const isExact=FILLER_WORDS.some(f=>lower===f||lower===f+',');
    const startsWithFiller=FILLER_WORDS.some(f=>lower.startsWith(f+' '));
    if(isExact||startsWithFiller){
      newCuts.push({id:`filler-${ts}-${newCuts.length}`,text:c.text,word:c.text,start:c.start,end:c.end,type:'filler',selected:true,skipEnabled:true,scriptPart:false,aiNote:'',_src:'filler'});
    }
  });
  S.cuts=[...S.cuts.filter(c=>c._src!=='filler'),...newCuts];
  renderAllFindings();
  renderTimeline();
  buildPlaySegments();
  toast(`Found ${newCuts.length} filler word${newCuts.length!==1?'s':''}`);
}

const _TYPE_COLOR={
  filler:    '#a855f7',
  retake:    'var(--red)',
  dead_air:  '#ff6a00',
  highlight: 'var(--teal)',
  weak:   '#facc15',
  missing:'var(--teal)',
};
const _TYPE_LABEL={filler:'Filler',retake:'Retake',dead_air:'Dead Air',weak:'Weak',missing:'Missing',highlight:'Highlight'};

const _CUT_COLOR={dead_air:'var(--red)',filler:'#a855f7',retake:'#ff0000',weak:'#facc15',silence:'var(--red)',dead:'var(--red)',highlight:'var(--teal)'};
const _CUT_ICON={dead_air:'✕',filler:'f',retake:'R',weak:'?',silence:'✕',dead:'✕',highlight:'✦'};
const SILENCE_TYPES=new Set(['dead_air','silence','dead']);
const AI_TYPES=new Set(['filler','retake','weak','highlight']);

function _buildCutCard(cut){
  const dur=(cut.end-cut.start).toFixed(2);
  const color=_CUT_COLOR[cut.type]||'var(--red)';
  const icon=_CUT_ICON[cut.type]||'✕';
  const isHighlight=cut.type==='highlight';
  const isScriptPart=cut.scriptPart===true;
  const spoken=cut.text||cut.word||'';
  const reason=cut.reason||cut.aiNote||'';
  if(isHighlight){
    return `<div class="sil-result-item"
      id="cut-card-${cut.id}"
      style="cursor:pointer;border-color:var(--teal);background:rgba(56,232,200,0.04)"
      onclick="seekToCut('${cut.id}')">
      <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
        <span style="font-size:11px;font-weight:700;color:var(--teal);width:12px;text-align:center;flex-shrink:0">✦</span>
        <div style="flex:1;min-width:0">
          <div style="display:flex;align-items:center;gap:5px">
            <span style="font-size:8px;font-weight:700;color:var(--teal);text-transform:uppercase;letter-spacing:.5px">Best Part</span>
            <span style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--text2)">@ ${cut.start.toFixed(2)}s · <span style="color:var(--teal)">${dur}s</span></span>
          </div>
          ${spoken?`<div style="font-size:10px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:160px;margin-top:1px">"${spoken}"</div>`:''}
          ${reason?`<div style="font-size:8.5px;color:var(--text2);font-style:italic;margin-top:1px">${reason}</div>`:''}
        </div>
      </div>
    </div>`;
  }
  return `<div class="sil-result-item ${cut.selected?'':'kept-row'}"
    id="cut-card-${cut.id}"
    style="cursor:pointer;border-color:${cut.selected?color:'var(--b1)'}"
    onclick="seekToCut('${cut.id}')">
    <div style="display:flex;align-items:center;gap:6px;flex:1;min-width:0">
      <span style="font-size:9px;font-weight:700;color:${color};width:12px;text-align:center;flex-shrink:0">${icon}</span>
      <div style="flex:1;min-width:0">
        <div style="font-family:'JetBrains Mono',monospace;font-size:9px;color:var(--text2)">@ ${cut.start.toFixed(2)}s · <span style="color:${color}">${dur}s</span></div>
        ${spoken?`<div style="font-size:10px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;margin-top:1px">"${spoken}"</div>`:''}
        ${reason?`<div style="font-size:8.5px;color:var(--text2);font-style:italic;margin-top:1px">${reason}</div>`:''}
        ${cut.type==='filler'?`<button onclick="event.stopPropagation();toggleScriptPart('${cut.id}')" style="font-size:7.5px;padding:1px 5px;border-radius:3px;margin-top:2px;background:${isScriptPart?'rgba(56,232,200,.15)':'var(--s3)'};border:1px solid ${isScriptPart?'var(--teal)':'var(--b1)'};color:${isScriptPart?'var(--teal)':'var(--text2)'};cursor:pointer">${isScriptPart?'✓ script':'script?'}</button>`:''}
      </div>
    </div>
    <div style="flex-shrink:0">
      <input type="checkbox" ${cut.selected?'checked':''}
        onclick="event.stopPropagation();toggleCutSelected('${cut.id}')"
        style="cursor:pointer;accent-color:${color};width:14px;height:14px">
    </div>
  </div>`;
}

// Silence tab — dead_air / silence / dead only
function renderSilenceFindings(){
  const el=document.getElementById('silenceFindings');
  if(!el) return;
  const cuts=S.cuts.filter(c=>SILENCE_TYPES.has(c.type));
  if(!cuts.length){
    el.innerHTML='<div class="empty-state">Run detection first</div>';
    const st=document.getElementById('silenceStats');
    if(st) st.textContent='';
    return;
  }
  const sel=cuts.filter(c=>c.selected);
  const saved=sel.reduce((a,c)=>a+(c.end-c.start),0);
  const st=document.getElementById('silenceStats');
  if(st) st.textContent=`${sel.length}/${cuts.length} · ${saved.toFixed(1)}s`;
  el.innerHTML=cuts.map(_buildCutCard).join('');
}

// AI tab — filler / retake / weak only
function _renderAIFindings(){
  const el=document.getElementById('fillerList');
  if(!el) return;
  const cuts=S.cuts.filter(c=>AI_TYPES.has(c.type));
  if(!cuts.length){
    el.innerHTML='<div class="empty-state">Run analysis first</div>';
    const statsEl=document.getElementById('fillerStats');
    if(statsEl) statsEl.textContent='';
    updateCutBadge();
    return;
  }
  const highlights=cuts.filter(c=>c.type==='highlight');
  const nonHL=cuts.filter(c=>c.type!=='highlight');
  const sel=nonHL.filter(c=>c.selected);
  const saved=sel.reduce((a,c)=>a+(c.end-c.start),0);
  const statsEl=document.getElementById('fillerStats');
  const hlPart=highlights.length?` · ✦ ${highlights.length} highlight${highlights.length!==1?'s':''}`:''
  if(statsEl) statsEl.textContent=`${sel.length} of ${nonHL.length} selected · ${saved.toFixed(1)}s${hlPart}`;

  const toolbar=`<div style="display:flex;gap:5px;margin-bottom:8px">
    <button class="act-btn" style="margin:0;flex:1;font-size:9px" onclick="selectAllFindings()">All</button>
    <button class="act-btn" style="margin:0;flex:1;font-size:9px" onclick="selectNoneFindings()">None</button>
    <button class="act-btn" style="margin:0;flex:1;font-size:9px" onclick="selectByType()">By Type</button>
  </div>`;

  el.innerHTML=toolbar+cuts.map(_buildCutCard).join('');
  updateCutBadge();
}

// Render both lists at once — call this whenever S.cuts changes
function renderAllFindings(){
  renderSilenceFindings();
  _renderAIFindings();
  updateCutBadge();
  _applyWordCuts();   // re-stamp .word-cut on transcript spans whenever cuts change
}

function toggleCutSelected(cutId){
  const cut=S.cuts.find(c=>c.id===cutId);
  if(!cut) return;
  saveHistory();
  cut.selected=!cut.selected;
  renderAllFindings();
  renderTimeline();
  buildPlaySegments();
}

function seekToCut(cutId){
  const cut=S.cuts.find(c=>c.id===cutId);
  if(!cut) return;
  S.selectedCutId=cutId;
  // Do NOT write to S.trimIn/S.trimOut — those are clip-level trim state.
  // updateTrimUI() already reads cut.start/end via S.selectedCutId when a cut is selected.
  updateTrimUI();
  updateTrimContext();
  if(video.src) video.currentTime=Math.max(0,cut.start-0.3);
  document.querySelectorAll('.sil-result-item').forEach(el=>el.style.outline='none');
  const card=document.getElementById(`cut-card-${cutId}`);
  if(card){card.style.outline='1px solid #fff';card.scrollIntoView({behavior:'smooth',block:'nearest'});}
  toast(`● @ ${cut.start.toFixed(2)}s · ${(cut.end-cut.start).toFixed(2)}s`);
}

function selectAllFindings(){
  S.cuts.filter(c=>AI_TYPES.has(c.type)).forEach(c=>{if(c.scriptPart!==true) c.selected=true;});
  renderAllFindings();renderTimeline();buildPlaySegments();
}

function selectNoneFindings(){
  S.cuts.filter(c=>AI_TYPES.has(c.type)).forEach(c=>c.selected=false);
  renderAllFindings();renderTimeline();buildPlaySegments();
}

function selectByType(){
  const type=prompt('Type to select:\nfiller / retake / weak');
  if(!type) return;
  const t=type.trim().toLowerCase();
  const matched=S.cuts.filter(c=>c.type===t && AI_TYPES.has(c.type));
  if(!matched.length){toast(`No "${t}" findings`);return;}
  matched.forEach(c=>{if(c.scriptPart!==true) c.selected=true;});
  renderAllFindings();renderTimeline();buildPlaySegments();
  toast(`✓ Selected all "${t}"`);
}

function selectAllSilence(){
  S.cuts.filter(c=>SILENCE_TYPES.has(c.type)).forEach(c=>c.selected=true);
  renderAllFindings();renderTimeline();buildPlaySegments();
}

function selectNoneSilence(){
  S.cuts.filter(c=>SILENCE_TYPES.has(c.type)).forEach(c=>c.selected=false);
  renderAllFindings();renderTimeline();buildPlaySegments();
}

// Merge overlapping or near-adjacent cuts of the same type into single cuts.
// threshold: max gap (seconds) between two cuts of the same type to merge them.
function mergeCuts(threshold=0.3){
  if(!S.cuts.length){ toast('No cuts to merge'); return; }
  saveHistory();

  // Group by type
  const byType={};
  for(const c of S.cuts){
    if(!byType[c.type]) byType[c.type]=[];
    byType[c.type].push(c);
  }

  const merged=[];
  for(const cuts of Object.values(byType)){
    cuts.sort((a,b)=>a.start-b.start);
    let cur={...cuts[0]};
    for(let i=1;i<cuts.length;i++){
      const c=cuts[i];
      if(c.start<=cur.end+threshold){
        // Absorb into current
        cur.end=Math.max(cur.end,c.end);
        if(c.text&&!cur.text) cur.text=c.text;
        if(c.aiNote&&cur.aiNote!==c.aiNote) cur.aiNote=[cur.aiNote,c.aiNote].filter(Boolean).join('; ');
        // Keep selected=true if either was selected
        if(c.selected) cur.selected=true;
      } else {
        merged.push(cur);
        cur={...c};
      }
    }
    merged.push(cur);
  }

  const before=S.cuts.length, after=merged.length;
  S.cuts=merged;
  renderAllFindings(); renderTimeline();
  toast(`⊕ Merged ${before} → ${after} cuts`);
}

function applyCuts(){
  const selectedCuts=S.cuts.filter(c=>c.selected)
    .sort((a,b)=>a.start-b.start);
  if(!selectedCuts.length){toast('No cuts selected');return;}
  if(!confirm(`Apply ${selectedCuts.length} cuts?`)) return;
  saveHistory();

  // for each segment, split it at any cuts that overlap it
  let newSegments=[];
  S.segments.forEach(seg=>{
    // Overlap test: cut must intersect the segment (not just start inside it)
    const cutsInside=selectedCuts.filter(c=>
      c.end>seg.sourceStart && c.start<seg.sourceEnd
    );
    if(!cutsInside.length){
      newSegments.push(seg);
      return;
    }
    // split segment at each cut, clamping cut boundaries to the segment range
    let cursor=seg.sourceStart;
    cutsInside.forEach(cut=>{
      const cutStart=Math.max(cut.start, seg.sourceStart);
      const cutEnd  =Math.min(cut.end,   seg.sourceEnd);
      if(cutStart-cursor>0.001){
        newSegments.push({
          id:crypto.randomUUID(),
          sourceStart:cursor,
          sourceEnd:cutStart,
          timelineStart:0,
          duration:cutStart-cursor,
          waveformSlice:null
        });
      }
      cursor=cutEnd;
    });
    // remaining piece after last cut
    if(seg.sourceEnd-cursor>0.001){
      newSegments.push({
        id:crypto.randomUUID(),
        sourceStart:cursor,
        sourceEnd:seg.sourceEnd,
        timelineStart:0,
        duration:seg.sourceEnd-cursor,
        waveformSlice:null
      });
    }
  });

  // Sort by sourceStart; timelineStart is assigned by _relayoutSegments()
  // below (sourceStart-based since S.snapped=false — leaves a real gap where
  // each applied cut was, which renderTimeline() draws as a hatched block
  // until snapGaps() closes it)
  newSegments.sort((a,b)=>a.sourceStart-b.sourceStart);

  S.segments=newSegments;
  S.snapped=false;
  _relayoutSegments();
  // remove applied cuts from S.cuts
  S.cuts=S.cuts.filter(c=>!c.selected);
  updateCaptionList();
  // ensure Skip Cuts is ON so playback jumps applied segments immediately
  S.skipCuts=true;
  document.getElementById('skipCutsBtn')?.classList.add('act');
  renderAllFindings();
  buildPlaySegments();
  sliceWaveforms();
  renderTimeline();
  // Sync to pywebview shared state so Python can read segments without bridge call
  if(window.pywebview?.state) window.pywebview.state.segments = S.segments;
  toast(`✓ ${selectedCuts.length} cuts applied — ${newSegments.length} segments`);
}

async function runAutoMode(deep=false){
  if(!S.current){toast('Import a video first');return;}
  if(!S.current.sourcePath){toast('✕ No file path — reload clip via Open File (📂), not drag-drop');return;}
  const btn=document.getElementById(deep?'autoModeDeepBtn':'autoModeBtn');
  const origText=btn.textContent;
  document.getElementById('autoModeBtn').disabled=true;
  document.getElementById('autoModeDeepBtn').disabled=true;
  const st=S.settings;
  let step=1;
  try{
    // The whole chain is one logical action — withHistoryBatch() snapshots
    // once up front and suppresses the individual saveHistory() calls inside
    // transcribeWithWhisper/detectDeadSpaces/detectFillers/runAIScriptAnalysis
    // for the duration, so a single Undo afterward goes all the way back to
    // the pre-Auto-Mode state instead of needing one Undo per internal step.
    await withHistoryBatch(async () => {
    if(st.autoTranscribe){
      btn.textContent=`⏳ Step ${step++}: Transcribing...`;
      toast(`⚡ Auto Mode — Transcribing...`);
      await transcribeWithWhisper();
      await new Promise(r=>setTimeout(r,500));
    }

    if(st.autoWaveform){
      btn.textContent=`⏳ Step ${step++}: Waveform...`;
      toast(`⚡ Auto Mode — Waveform analysis...`);
      await extractAudioData(true);
      await new Promise(r=>setTimeout(r,300));
    }

    if(st.autoSilence){
      btn.textContent=`⏳ Step ${step++}: Silence...`;
      toast(`⚡ Auto Mode — Silence detection...`);
      await analyzeAudio();
      await new Promise(r=>setTimeout(r,300));
    }

    if(st.autoDeadSpaces){
      btn.textContent=`⏳ Step ${step++}: Dead spaces...`;
      toast(`⚡ Auto Mode — Dead space detection...`);
      await detectDeadSpaces();
      await new Promise(r=>setTimeout(r,300));
    }

    if(st.autoFillers){
      btn.textContent=`⏳ Step ${step++}: Fillers...`;
      toast(`⚡ Auto Mode — Filler detection...`);
      detectFillers();
      await new Promise(r=>setTimeout(r,300));
    }

    if(deep){
      if(st.deepAI){
        if(!S.orKey)         toast('⚠ No OpenRouter key — skipping AI step');
        else if(!S.selectedModel) toast('⚠ No model selected — skipping AI step');
        else{
          btn.textContent=`⏳ Step ${step++}: AI analysis...`;
          toast(`⚡ Deep Mode — AI script analysis...`);
          await runAIScriptAnalysis();
        }
      }
    }
    });

    switchTab('silence');
    const totalFindings=S.cuts.length;
    const totalSaved=S.cuts.filter(c=>c.selected).reduce((a,c)=>a+(c.end-c.start),0);
    toast(`⚡ Done — ${totalFindings} findings · ${totalSaved.toFixed(1)}s removable`);
  } catch(e){
    toast('✕ Auto Mode failed: '+e.message);
  } finally{
    btn.textContent=origText;
    document.getElementById('autoModeBtn').disabled=false;
    document.getElementById('autoModeDeepBtn').disabled=false;
  }
}

function _updateFillerBtn(){
  const btn=document.getElementById('fillerDetectBtn');
  if(!btn) return;
  const ready=S.captions.length>0;
  btn.disabled=!ready;
  btn.style.opacity=ready?'1':'.45';
  btn.style.cursor=ready?'pointer':'not-allowed';
  btn.title=ready?'Detect filler words in transcript':'Transcribe video first';
}

// renderSilenceResults — merged into renderAllFindings(); calls here redirect there
function renderSilenceResults(){ renderAllFindings(); }

function selectCut(cutId){
  S.selectedCutId=cutId;
  const cut=S.cuts.find(c=>c.id===cutId);
  if(!cut) return;
  // highlight fill element
  document.querySelectorAll('.tl-cut').forEach(el=>el.classList.toggle('cut-selected',el.dataset.cutId===cutId));
  // load into trim panel — do NOT write to S.trimIn/S.trimOut (clip-level trim state)
  // updateTrimUI() reads cut.start/end via S.selectedCutId when a cut is selected
  updateTrimUI();
  updateTrimContext();
  if(video.src) video.currentTime=cut.start;
  toast(`Cut selected · ${cut.start.toFixed(2)}s → ${cut.end.toFixed(2)}s`);
}

function updateTrimContext(){
  const label=document.getElementById('trimContextLabel');
  const dur=document.getElementById('trimContextDur');
  if(!label) return;
  if(S.selectedCutId!==null){
    const cut=S.cuts.find(c=>c.id===S.selectedCutId);
    if(cut){
      label.textContent=`● Cut · ${cut.type||'silence'}`;
      label.style.color='var(--red)';
      dur.textContent=(cut.end-cut.start).toFixed(2)+'s';
    }
  } else if(S.selectedSegmentId){
    const idx=S.segments.findIndex(s=>s.id===S.selectedSegmentId);
    label.textContent=`● Segment ${idx+1} of ${S.segments.length}`;
    label.style.color='var(--blue-soft)';
    dur.textContent=(S.segments[idx]?.duration||0).toFixed(2)+'s';
  } else {
    // Clip-level trimIn/trimOut are always source-file time (the outer bounds
    // of the whole clip) — deliberately NOT remapped through playSegments,
    // which would break their actual purpose. Labeled explicitly (bug #15)
    // so this doesn't read as a bug when it doesn't match the post-cut timeline.
    label.textContent='● Clip trim (source time)';
    label.style.color='var(--text2)';
    dur.textContent='';
  }
}

// previewSilence / toggleSilCut — merged into seekToCut / toggleCutSelected
function previewSilence(id){ seekToCut(id); }
function toggleSilCut(id){ toggleCutSelected(id); }

function applySilenceRemoval(){
  if(!S.cuts.length){toast('No segments to apply');return;}
  saveHistory();
  const cuts=S.cuts.filter(s=>s.selected).length;
  toast(`✓ Applied ${cuts} silence cuts — playback skips them live`);
  renderAllFindings();
  renderTimeline();
  closeModal('silenceModal');
}

function toggleSilenceVis(){
  S.silenceVisible=!S.silenceVisible;
  document.getElementById('silVisBtn').classList.toggle('active',S.silenceVisible);
  renderTimeline();
}
