// ═══════════════════════════════════════
// IMPORT
// ═══════════════════════════════════════
document.getElementById('fileInput').addEventListener('change', e => {
  [...e.target.files].forEach(loadClip);
  e.target.value='';
});

function loadClip(file) {
  // pywebview 5+ exposes the real Windows path on dragged files
  const sourcePath = file.pywebviewFullPath || file.path || null;

  // If we have a real path, use the HTTP streaming URL (avoids file:// cross-origin block)
  const url = sourcePath
    ? `${window.location.origin}/video?path=${encodeURIComponent(sourcePath)}`
    : URL.createObjectURL(file);

  const id   = crypto.randomUUID();
  const clip = {id, file, url, name:file.name, duration:0, trimIn:0, trimOut:null, silCuts:[],
                sourcePath, browserPlayable:null};
  _clipRegistry[id] = {file, url};

  const tmp = document.createElement('video');
  tmp.src   = url;
  tmp.onloadedmetadata = () => {
    clip.browserPlayable = true;
    clip.duration = tmp.duration;
    clip.trimOut  = tmp.duration;
    clip.segments = [{
      id: crypto.randomUUID(),
      sourceStart: 0, sourceEnd: clip.duration,
      timelineStart: 0, duration: clip.duration, waveformSlice: null
    }];
    S.clips.push(clip);
    renderClipList();
    renderTimeline();
    if(S.clips.length===1) selectClip(id);
    toast(`✓ Imported: ${file.name}`);
  };
  tmp.onerror = async () => {
    clip.browserPlayable = false;
    if(sourcePath){
      jlog('warn', `loadClip: browser can't play "${file.name}" — probing via ffprobe`);
      try { clip.duration = await window.pywebview.api.probe_duration(sourcePath); } catch{}
    }
    clip.trimOut = clip.duration;
    clip.segments = [{
      id: crypto.randomUUID(),
      sourceStart: 0, sourceEnd: clip.duration,
      timelineStart: 0, duration: clip.duration, waveformSlice: null
    }];
    S.clips.push(clip);
    renderClipList(); renderTimeline();
    if(S.clips.length===1) selectClip(id);
    toast(`⚠ Preview N/A for ${file.name} — export works fine`);
  };
}

// Route upload zone click: native picker in pywebview, browser input otherwise.
function onUploadZoneClick() {
  if(window.pywebview){ openFileNative(); return; }
  document.getElementById('fileInput').click();
}

async function openFileNative() {
  if(!window.pywebview) return;
  const path = await window.pywebview.api.open_file();
  if(path) loadClipFromPath(path);
}

// Load a clip from an absolute file path (pywebview native open).
// sourcePath stored on clip → export/transcribe use ffmpeg directly (no browser upload).
// Falls back to ffprobe for duration when the browser can't play the container (e.g. MOV/ProRes).
function loadClipFromPath(sourcePath) {
  const name    = sourcePath.split(/[/\\]/).pop();
  // Serve through the local HTTP server so the browser page (http://localhost:8080)
  // can access it — file:// URLs are blocked cross-origin from HTTP pages.
  const fileUrl = `${window.location.origin}/video?path=${encodeURIComponent(sourcePath)}`;
  const id      = crypto.randomUUID();
  const clip    = {id, file:null, url:fileUrl, name, sourcePath, duration:0, trimIn:0, trimOut:null, silCuts:[], browserPlayable:null};

  const finalize = (duration) => {
    clip.duration = duration;
    clip.trimOut  = duration;
    clip.segments = [{
      id: crypto.randomUUID(),
      sourceStart: 0, sourceEnd: duration,
      timelineStart: 0, duration, waveformSlice: null
    }];
    S.clips.push(clip);
    renderClipList();
    renderTimeline();
    if(S.clips.length === 1) selectClip(id);
    jlog('info', `loadClipFromPath: loaded "${name}"  duration=${duration.toFixed(3)}s  sourcePath=${sourcePath}`);
    toast(`✓ Imported: ${name}`);
  };

  const tmp = document.createElement('video');
  tmp.src   = fileUrl;

  tmp.onloadedmetadata = () => {
    clip.browserPlayable = true;
    finalize(tmp.duration);
  };

  tmp.onerror = async () => {
    // Browser can't decode the container (MOV, ProRes, etc.) — probe via ffprobe instead.
    // The clip is still fully usable: ffmpeg handles it fine for transcription and export.
    clip.browserPlayable = false;
    jlog('warn', `loadClipFromPath: browser can't play "${name}" — probing duration via ffprobe`);
    let duration = 0;
    try {
      duration = await window.pywebview.api.probe_duration(sourcePath);
    } catch(e) {
      jlog('error', `probe_duration failed: ${e.message}`);
    }
    toast(`⚠ Preview unavailable for ${name} — transcription & export still work`);
    finalize(duration);
  };
}

function selectClip(id) {
  const c = S.clips.find(x=>x.id===id);
  if(!c) return;
  S.current      = c;
  S.selectedClipId = id;
  S.selectedFindingId = null;
  S.selectedCutId = null;
  S.selectedSegmentId = null;
  S.segments  = c.segments || [];
  S.trimIn    = c.trimIn;
  S.trimOut   = c.trimOut;
  S.duration  = c.duration;
  S.waveformData = null;
  video.src   = c.url;
  video.currentTime = c.trimIn;
  document.getElementById('noVideoMsg').style.display='none';
  video.style.display='block';
  document.getElementById('propName').textContent = c.name.slice(0,16);
  document.getElementById('propDur').textContent  = fmt(c.duration);
  syncTopbarClipName();

  document.getElementById('propRes').textContent = c.file ? (c.file.size/1e6).toFixed(1)+'MB' : '…';
  video.onerror = null;
  video.src = c.url;
  video.currentTime = c.trimIn;
  video.onloadedmetadata = () => {
    document.getElementById('propRes').textContent = `${video.videoWidth}×${video.videoHeight}`;
    updateTrimUI();
    extractAudioData(true);
  };
  video.onerror = () => {
    // Codec not supported even over HTTP (ProRes, etc.) — clip still works for export/transcription
    document.getElementById('propRes').textContent = 'preview N/A';
    jlog('warn', `selectClip: browser can't decode "${c.name}" — preview disabled, export unaffected`);
    updateTrimUI();
  };
  renderClipList();
  updateCaptionList();
  updateTrimContext();
  renderTimeline();
}
