// ═══════════════════════════════════════
// UNDO / REDO  — two-stack approach
// ═══════════════════════════════════════
// undoStack: pre-action snapshots  (most recent = top = last element)
// redoStack: states to redo to     (cleared on every new action)
//
// saveHistory()  →  push current live state onto undoStack, clear redoStack
// undo()         →  push current onto redoStack, pop+apply from undoStack
// redo()         →  push current onto undoStack, pop+apply from redoStack
//
// No dirty flags, no index arithmetic, no off-by-one.

function _makeSnapshot(){
  return {
    clips:             S.clips.map(c=>({...c, file:null})),
    captions:          JSON.parse(JSON.stringify(S.captions)),
    cuts:              JSON.parse(JSON.stringify(S.cuts)),
    segments:          JSON.parse(JSON.stringify(S.segments)),
    snapped:           S.snapped,
    selectedSegmentId: S.selectedSegmentId,
    trimIn:            S.trimIn,
    trimOut:           S.trimOut,
    markers:           JSON.parse(JSON.stringify(S.markers)),
    current:           S.current ? {id:S.current.id} : null,
    aspect:            S.aspect,
    aspectMode:        S.aspectMode,
    textStyle:         JSON.parse(JSON.stringify(S.textStyle)),
  };
}

function saveHistory(){
  S.undoStack.push(JSON.stringify(_makeSnapshot()));
  if(S.undoStack.length > 50) S.undoStack.shift();
  S.redoStack = []; // new action always kills redo branch
}

function _applySnapshot(snap){
  // Re-wire File + blob URL — File objects can't survive JSON round-trip
  if(snap.clips){
    snap.clips = snap.clips.map(sc=>{
      const reg = _clipRegistry[sc.id];
      return reg ? {...sc, file:reg.file, url:reg.url} : sc;
    });
  }
  const savedCurrent = snap.current;
  delete snap.current;
  Object.assign(S, snap);
  S.current = savedCurrent ? S.clips.find(c=>c.id===savedCurrent.id)||null : null;

  // Stop playback cleanly before changing video.src — prevents S.playing
  // getting out of sync with actual video state (Space press would "pause" instead of play)
  _stopRVFC();
  S.playing = false;
  _setPlayIcon(false);

  if(S.current){
    video.onerror = null;
    video.onloadedmetadata = null;
    video.src = S.current.url;
    video.currentTime = S.trimIn;
    document.getElementById('noVideoMsg').style.display='none';
    video.style.display='block';
    document.getElementById('propName').textContent = S.current.name.slice(0,16);
    document.getElementById('propDur').textContent  = fmt(S.current.duration);
    syncTopbarClipName();
    video.onloadedmetadata = () => {
      document.getElementById('propRes').textContent = `${video.videoWidth}×${video.videoHeight}`;
      updateTrimUI();
    };
    video.onerror = () => {
      document.getElementById('propRes').textContent = 'preview N/A';
      jlog('warn', `_applySnapshot: browser can't decode "${S.current?.name}"`);
      updateTrimUI();
    };
  } else {
    video.onerror = null;
    video.onloadedmetadata = null;
    video.src=''; video.style.display='none';
    document.getElementById('noVideoMsg').style.display='flex';
  }
  buildPlaySegments();
  renderClipList(); updateCaptionList(); updateTrimUI();
  renderAllFindings(); sliceWaveforms(); renderTimeline();
  _applyTextStyle();
}

function undo(){
  if(!S.undoStack.length){
    jlog('warn', `undo() called but undoStack is empty  (redoStack=${S.redoStack.length})`);
    toast('Nothing to undo');
    return;
  }
  S.redoStack.push(JSON.stringify(_makeSnapshot()));
  const snap = S.undoStack.pop();
  try {
    _applySnapshot(JSON.parse(snap));
    jlog('info', `undo() ok  undoStack=${S.undoStack.length}  redoStack=${S.redoStack.length}`);
  } catch(e) {
    jlog('error', `undo() _applySnapshot threw: ${e.message}`);
  }
  toast(`↺ Undo  (${S.undoStack.length} left)`);
}

function redo(){
  if(!S.redoStack.length){
    jlog('warn', `redo() called but redoStack is empty  (undoStack=${S.undoStack.length})`);
    toast('Nothing to redo');
    return;
  }
  S.undoStack.push(JSON.stringify(_makeSnapshot()));
  const snap = S.redoStack.pop();
  try {
    _applySnapshot(JSON.parse(snap));
    jlog('info', `redo() ok  undoStack=${S.undoStack.length}  redoStack=${S.redoStack.length}`);
  } catch(e) {
    jlog('error', `redo() _applySnapshot threw: ${e.message}`);
  }
  toast(`↻ Redo  (${S.redoStack.length} left)`);
}
