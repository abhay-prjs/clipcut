// ═══════════════════════════════════════
// TOOLS / DELETE
// ═══════════════════════════════════════
['selectTool','trimTool'].forEach(id=>{
  const btn=document.getElementById(id);
  if(!btn) return;
  btn.addEventListener('click',function(){
    document.querySelectorAll('.tool-btn:not(.ai-btn):not(.danger)').forEach(b=>b.classList.remove('active'));
    this.classList.add('active');
    S.tool=id.replace('Tool','');
  });
});

function deleteClip(){
  const clip=S.clips.find(c=>c.id===S.selectedClipId)||S.current;
  if(!clip){toast('No clip selected');return;}
  if(!confirm(`Delete "${clip.name}"?`)) return;
  saveHistory();
  S.clips=S.clips.filter(c=>c.id!==clip.id);
  if(S.current?.id===clip.id){
    S.current=null; S.selectedClipId=null;
    S.segments=[]; S.cuts=[]; S.captions=[]; S.playSegments=[]; S.waveformData=null;
    S.trimIn=0; S.trimOut=null; S.markers=[];
    video.src=''; video.style.display='none';
    document.getElementById('noVideoMsg').style.display='flex';
  }
  renderClipList(); renderTimeline(); renderAllFindings(); updateCaptionList(); syncTopbarClipName();
  toast('Clip deleted');
}

function deleteClipById(id){
  S.selectedClipId=id;
  deleteClip();
}

// ═══════════════════════════════════════
// ASPECT RATIO
// ═══════════════════════════════════════
function setAspect(r,el){
  document.querySelectorAll('.ab').forEach(b=>b.classList.remove('active'));
  el.classList.add('active');
  document.getElementById('videoContainer').style.aspectRatio=r;
}

// ═══════════════════════════════════════
// MODALS
// ═══════════════════════════════════════
function openModal(id){document.getElementById(id).classList.add('open');}
function closeModal(id){document.getElementById(id).classList.remove('open');}
function openSilenceModal(){if(!S.current){toast('Load a video first');return;}openModal('silenceModal');pingAIStatus();}
document.querySelectorAll('.modal-backdrop').forEach(m=>m.addEventListener('click',e=>{if(e.target===m)m.classList.remove('open');}));

// ═══════════════════════════════════════
// TABS
// ═══════════════════════════════════════
function syncTopbarClipName(){
  const el=document.getElementById('topbarClipName');
  if(!el) return;
  el.textContent = S.current ? S.current.name : 'No clip loaded';
}

function switchTab(name){
  document.querySelectorAll('.panel-tab').forEach(t=>t.classList.toggle('active',t.dataset.tab===name));
  document.querySelectorAll('.tab-content').forEach(c=>c.classList.toggle('active',c.id===`tab-${name}`));
  if(name==='settings') _loadWhisperConfigFromServer();
}

function switchInspTab(name){
  document.querySelectorAll('.insp-tab').forEach(t=>t.classList.toggle('active',t.dataset.insp===name));
  document.querySelectorAll('.insp-panel').forEach(p=>p.classList.toggle('active',p.dataset.insp===name));
}

// ═══════════════════════════════════════
// TOAST / KEYBOARD
// ═══════════════════════════════════════
function toast(msg){
  const t=document.getElementById('toast'); t.textContent=msg; t.classList.add('show');
  clearTimeout(t._t); t._t=setTimeout(()=>t.classList.remove('show'),2800);
}

document.addEventListener('keydown',e=>{
  const mods = [e.ctrlKey&&'Ctrl', e.shiftKey&&'Shift', e.altKey&&'Alt'].filter(Boolean).join('+');
  const keyStr = (mods ? mods + '+' : '') + e.code;
  const target = e.target.tagName + (e.target.id ? '#'+e.target.id : '');

  if(e.ctrlKey&&e.code==='KeyZ'){
    e.preventDefault();
    const action = e.shiftKey ? 'redo' : 'undo';
    jlog('key', `${keyStr} → ${action}()  [undoStack=${S.undoStack.length}  redoStack=${S.redoStack.length}]`);
    e.shiftKey ? redo() : undo();
    return;
  }
  if(e.ctrlKey&&e.code==='KeyB'){e.preventDefault();jlog('key',`${keyStr} → splitAtPlayhead()`);splitAtPlayhead();return;}
  if(['INPUT','TEXTAREA','SELECT'].includes(e.target.tagName) || e.target.isContentEditable){
    // key eaten by input — log only if it looks like a shortcut that might confuse
    if(e.ctrlKey||e.altKey) jlog('key', `${keyStr} ignored — focus is on ${target}`);
    return;
  }
  if(e.code==='Space'){e.preventDefault();jlog('key',`Space → togglePlay()`);togglePlay();}
  if(e.code==='ArrowLeft'){const d=e.shiftKey?-10:-2;jlog('key',`${keyStr} → skipTime(${d})`);skipTime(d);}
  if(e.code==='ArrowRight'){const d=e.shiftKey?10:2;jlog('key',`${keyStr} → skipTime(${d})`);skipTime(d);}
  if(e.code==='KeyH'){jlog('key','H → toggleFlip(h)');toggleFlip('h');}
  if(e.code==='KeyV'){jlog('key','V → toggleFlip(v)');toggleFlip('v');}
  if(e.code==='KeyQ'){jlog('key','Q → trimBefore()');trimBefore();}
  if(e.code==='KeyW'){jlog('key','W → trimAfter()');trimAfter();}
  if(e.code==='Delete'||e.code==='Backspace'){
    if(S.selectedCutId!==null){
      jlog('key',`${keyStr} → delete cut ${S.selectedCutId}`);
      deleteSelectedCut();
      return;
    }
    if(S.selectedFindingId!==null){
      jlog('key',`${keyStr} → delete finding ${S.selectedFindingId}`);
      S.cuts=S.cuts.filter(c=>c.id!==S.selectedFindingId);
      S.selectedFindingId=null;
      renderAllFindings(); renderTimeline();
      toast('Finding removed');
      return;
    }
    if(S.selectedSegmentId!==null){
      jlog('key',`${keyStr} → deleteSegment()`);
      deleteSegment();
      return;
    }
    jlog('key',`${keyStr} → deleteClip()`);
    deleteClip();
  }
  if(e.code==='Equal'||e.code==='NumpadAdd') zoomTL(1);
  if(e.code==='Minus'||e.code==='NumpadSubtract') zoomTL(-1);
});

// drag-drop
document.body.addEventListener('dragover',e=>e.preventDefault());
document.body.addEventListener('drop',e=>{
  e.preventDefault();
  [...e.dataTransfer.files].filter(f=>f.type.startsWith('video/')).forEach(loadClip);
});

// ═══════════════════════════════════════
// MARKERS
// ═══════════════════════════════════════
function addMarker(){
  if(!video.src) return;
  const t=video.currentTime;
  const name=prompt('Marker name (optional):')||`M${S.markers.length+1}`;
  saveHistory();
  S.markers.push({t,name});
  renderTimeline();
  toast(`♦ Marker: ${name} @ ${t.toFixed(2)}s`);
}

// ═══════════════════════════════════════
// LOOP REGION
// ═══════════════════════════════════════
function setLoopA(){ S.loopA=video.currentTime; toast(`Loop A: ${S.loopA.toFixed(2)}s`); }
function setLoopB(){ S.loopB=video.currentTime; toast(`Loop B: ${S.loopB.toFixed(2)}s`); }
function toggleLoop(){
  S.looping=!S.looping;
  document.getElementById('loopBtn').classList.toggle('active',S.looping);
  toast(S.looping?'⟳ Loop ON':'Loop OFF');
}

function toggleSkipCuts(){
  S.skipCuts=!S.skipCuts;
  document.getElementById('skipCutsBtn').classList.toggle('act',S.skipCuts);
  buildPlaySegments();
  toast(S.skipCuts?'⊘ Skip cuts ON':'⊘ Skip cuts OFF');
}

function deleteSelectedCut(){
  if(S.selectedCutId===null) return;
  saveHistory();
  S.cuts=S.cuts.filter(c=>c.id!==S.selectedCutId);
  S.selectedCutId=null;
  S.trimIn=S.current?.trimIn||0;
  S.trimOut=S.current?.trimOut||S.duration;
  updateTrimUI();
  renderTimeline(); updateCutBadge();
  toast('✕ Cut removed');
}

function toggleScriptPart(cutId){
  const cut=S.cuts.find(c=>c.id===cutId);
  if(!cut) return;
  cut.scriptPart=!cut.scriptPart;
  if(cut.scriptPart){
    cut.skipEnabled=false;
    cut.selected=false;
  } else {
    cut.skipEnabled=true;
    cut.selected=true;
  }
  buildPlaySegments();
  renderTimeline();
  renderAllFindings();
  const word=cut.text||cut.word||'cut';
  toast(cut.scriptPart?`✓ "${word}" marked as script — won't be cut`:`⊘ "${word}" back to filler`);
}

function toggleCutSkip(cutId){
  const cut=S.cuts.find(c=>c.id===cutId);
  if(!cut) return;
  cut.skipEnabled=cut.skipEnabled===false?true:false;
  buildPlaySegments();
  renderTimeline();
  renderAllFindings();
  toast(cut.skipEnabled!==false?'⊘ Skipping cut':'● Keeping cut in playback');
}
