// ═══════════════════════════════════════
// PROJECT SAVE / LOAD (bug #8)
// ═══════════════════════════════════════
// .ccproj files store clip sourcePaths + per-clip segments/cuts/captions/
// markers + aspect/textStyle — everything except waveformData (re-extracted
// on load) and File objects (drag-drop-only clips with no sourcePath can't
// survive a save; they're skipped).

// Persists the active clip's live edit state onto its own clip object —
// same sync selectClip() does when switching away, but usable without
// actually switching (needed before serializing the current clip).
function _syncCurrentClipState(){
  if(!S.current) return;
  S.current.cuts     = S.cuts;
  S.current.captions = S.captions;
  S.current.markers  = S.markers;
  S.current.trimIn   = S.trimIn;
  S.current.trimOut  = S.trimOut;
  S.current.segments = S.segments;
}

function serializeProject(){
  _syncCurrentClipState();
  const clips = S.clips.filter(c=>c.sourcePath).map(c=>({
    id: c.id, name: c.name, sourcePath: c.sourcePath, duration: c.duration,
    trimIn: c.trimIn, trimOut: c.trimOut, fps: c.fps||30,
    segments: c.segments||[], cuts: c.cuts||[], captions: c.captions||[], markers: c.markers||[],
  }));
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    currentClipId: S.current?.id||null,
    aspect: S.aspect, aspectMode: S.aspectMode,
    textStyle: S.textStyle,
    zoom: S.zoom,
    clips,
  };
}

async function saveProject(){
  if(!window.pywebview){ toast('Project save requires the desktop app'); return; }
  const data = serializeProject();
  if(!data.clips.length){ toast('Nothing to save — import a video first'); return; }
  const base = S.current ? S.current.name.replace(/\.[^.]+$/,'') : 'project';
  const result = await window.pywebview.api.save_project(JSON.stringify(data), `clipcut_${base}.ccproj`);
  if(!result || result.error==='cancelled') return;
  if(!result.success){ toast(`✕ Save failed: ${result.error}`); return; }
  await window.pywebview.api.clear_autosave();
  toast(`✓ Project saved: ${result.path.split(/[/\\]/).pop()}`);
}

// Rebuilds S.clips from saved project data and selects a clip — shared by
// openProject() and autosave recovery.
function _loadProjectData(data){
  saveHistory();
  S.clips = [];
  S.aspect = data.aspect || S.aspect;
  S.aspectMode = data.aspectMode || S.aspectMode;
  if(data.textStyle) S.textStyle = data.textStyle;
  if(data.zoom) S.zoom = data.zoom;

  for(const c of data.clips){
    const fileUrl = `${window.location.origin}/video?path=${encodeURIComponent(c.sourcePath)}`;
    S.clips.push({
      id:c.id, file:null, url:fileUrl, name:c.name, sourcePath:c.sourcePath,
      duration:c.duration, trimIn:c.trimIn, trimOut:c.trimOut, fps:c.fps||30, silCuts:[],
      browserPlayable:null,
      segments:c.segments||[], cuts:c.cuts||[], captions:c.captions||[], markers:c.markers||[],
    });
  }
  renderClipList();
  const toSelect = (data.currentClipId && S.clips.some(c=>c.id===data.currentClipId))
    ? data.currentClipId
    : (S.clips[0]?.id || null);
  if(toSelect) selectClip(toSelect);
  toast(`✓ Project loaded: ${data.clips.length} clip${data.clips.length!==1?'s':''}`);
}

async function openProject(){
  if(!window.pywebview){ toast('Project load requires the desktop app'); return; }
  const json = await window.pywebview.api.open_project();
  if(!json) return;
  try{
    _loadProjectData(JSON.parse(json));
  } catch(e){
    toast(`✕ Project load failed: ${e.message}`);
    jlog('error', `openProject parse failed: ${e.message}`);
  }
}

// ── Autosave + startup recovery ──────────────────────────────────────────────
let _autosaveTimer = null;
function _startAutosave(){
  if(!window.pywebview || _autosaveTimer) return;
  _autosaveTimer = setInterval(()=>{
    if(!S.current) return;
    window.pywebview.api.autosave_project(JSON.stringify(serializeProject()));
  }, 30000);
}

async function _checkAutosaveRecovery(){
  if(!window.pywebview) return;
  const json = await window.pywebview.api.check_autosave();
  if(!json) return;
  let data;
  try{ data = JSON.parse(json); } catch(e){ jlog('error', `autosave recovery parse failed: ${e.message}`); return; }
  const when = data.savedAt ? new Date(data.savedAt).toLocaleString() : 'earlier';
  const n = data.clips?.length||0;
  if(n && confirm(`An autosaved project from ${when} was found (${n} clip${n!==1?'s':''}). Restore it?`)){
    _loadProjectData(data);
  } else {
    await window.pywebview.api.clear_autosave();
  }
}
