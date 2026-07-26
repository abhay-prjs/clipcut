// ═══════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════
let _exportFormat  = 'mp4';
let _exportPreset  = 'fast';
let _exportBurnCap = false;
let _exportJobId   = null;
let _exportSSE     = null;

const _PRESET_HINTS = {
  fast:     'nvenc p2 · cq 28 — fastest encode, larger file',
  balanced: 'nvenc p4 · cq 23 — good balance',
  quality:  'nvenc p6 · cq 18 — best quality, slower',
};

function setExportFormat(fmt){
  _exportFormat=fmt;
  document.getElementById('fmtMP4').classList.toggle('primary', fmt==='mp4');
  document.getElementById('fmtWebM').classList.toggle('primary', fmt==='webm');
  document.getElementById('exportPresetRow').style.display = fmt==='mp4'?'':'none';
}

function setExportPreset(preset){
  _exportPreset=preset;
  ['Fast','Balanced','Quality'].forEach(p=>{
    document.getElementById('preset'+p).classList.toggle('primary', preset===p.toLowerCase());
  });
  document.getElementById('presetHint').textContent=_PRESET_HINTS[preset]||'';
}

function toggleBurnCaptions(){
  _exportBurnCap=!_exportBurnCap;
  const btn=document.getElementById('burnCapsBtn');
  btn.textContent=_exportBurnCap?'ON':'OFF';
  btn.classList.toggle('primary',_exportBurnCap);
  if(_exportBurnCap && !S.captions.length) toast('⚠ No captions — transcribe first');
}

async function browseExportFolder(){
  // pywebview native OS dialog — returns a real absolute path string
  if(window.pywebview){
    try{
      const folder = await window.pywebview.api.pick_folder();
      if(folder){
        _exportDirHandle = null; // not using FS API handle
        document.getElementById('exportFolder').value = folder;
        localStorage.setItem('vexxe_export_folder', folder);
        localStorage.removeItem('vexxe_export_folder_picker_name');
        toast(`📁 Save folder: ${folder.split(/[/\\]/).pop()}`);
      }
    }catch(e){ toast('Could not open folder picker'); }
    return;
  }
  // Browser fallback — File System Access API (Chrome/Edge)
  if(window.showDirectoryPicker){
    try{
      const dir = await window.showDirectoryPicker({mode:'readwrite'});
      _exportDirHandle = dir;
      document.getElementById('exportFolder').value = dir.name + '  (via browser picker)';
      localStorage.setItem('vexxe_export_folder_picker_name', dir.name);
      localStorage.removeItem('vexxe_export_folder');
      toast(`📁 Save folder: ${dir.name}`);
    }catch(e){ if(e.name!=='AbortError') toast('Could not open folder picker'); }
  } else {
    toast('Browser picker not supported — type path manually');
  }
}
let _exportDirHandle = null;

function openExportModal(){
  if(!S.current){toast('No video loaded');return;}

  // Build summary
  const segs  = S.segments.length ? S.segments : [{sourceStart:S.trimIn||0,sourceEnd:S.trimOut||S.duration,duration:S.duration}];
  const totalOut = segs.reduce((a,s)=>a+(s.sourceEnd-s.sourceStart),0);
  const pending  = S.cuts.filter(c=>c.selected).length;
  const capCount = S.captions.length;
  const name     = S.current.name;

  document.getElementById('exportSummary').innerHTML =
    `<span style="color:var(--text)">${name}</span><br>`+
    `<span style="color:var(--blue-soft)">${segs.length} segment${segs.length!==1?'s':''}</span> · `+
    `<span style="color:var(--teal)">${totalOut.toFixed(2)}s output</span>`+
    (pending ? ` · <span style="color:var(--red)">⚠ ${pending} unapplied cut${pending!==1?'s':''}</span>` : '')+
    (capCount ? ` · ${capCount} caption${capCount!==1?'s':''}` : '');

  // Default filename
  const base = name.replace(/\.[^.]+$/,'');
  document.getElementById('exportFilename').value = `clipcut_${base}_${Date.now()}.mp4`;

  // Reset UI
  document.getElementById('exportProgress').style.display='none';
  document.getElementById('exportStartBtn').disabled=false;
  document.getElementById('exportStartBtn').textContent='⬇ Export';
  document.getElementById('exportCancelBtn').textContent='Cancel';
  setExportFormat(_exportFormat);
  setExportPreset(_exportPreset);

  document.getElementById('exportAspectLbl').textContent = S.aspect.replace('/',':');
  setAspectMode(S.aspectMode);

  openModal('exportModal');
}

function closeExportModal(){
  if(_exportJobId) cancelExport();
  closeModal('exportModal');
}

// Called by Python via evaluate_js() during pywebview export
function _onExportProgress(pct) {
  _setExportProgress(pct, 0, pct >= 100 ? 'done' : 'running');
}

async function startExport(){
  if(!S.current){toast('No clip');return;}
  if(_exportFormat==='webm'){ await _doWebMExport(); return; }
  // Fast path: pywebview + real source path → no upload/download
  if(window.pywebview && S.current.sourcePath){
    await _doPywebviewExport();
    return;
  }
  await _doFlaskExport();
}

async function _doPywebviewExport(){
  const outputName = document.getElementById('exportFilename').value.trim() || `clipcut_${Date.now()}.mp4`;
  const segs = S.segments.length
    ? S.segments.map(s=>({start:s.sourceStart, end:s.sourceEnd}))
    : [{start:S.trimIn||0, end:S.trimOut||S.duration}];
  const segMeta = S.segments.length
    ? S.segments.map(s=>({sourceStart:s.sourceStart, sourceEnd:s.sourceEnd, timelineStart:s.timelineStart}))
    : [];

  _setExportUI('running');
  _setExportLabel('Opening save dialog…');

  try{
    const result = await window.pywebview.api.export_video(
      S.current.sourcePath,
      JSON.stringify(segs),
      outputName,
      _exportPreset,
      S.flipH,
      S.flipV,
      _exportBurnCap,
      _exportBurnCap ? JSON.stringify(S.captions) : '[]',
      _exportBurnCap ? JSON.stringify(segMeta) : '[]',
      S.aspect,
      S.aspectMode
    );

    if(!result || result.error === 'cancelled') {
      _setExportUI('idle');
      return;
    }
    if(!result.success){
      toast(`✕ Export failed: ${result.error}`);
      _setExportUI('idle');
      return;
    }
    _setExportProgress(100, 0, 'done');
    _setExportLabel(`✓ Saved to ${result.path}`);
    toast(`✓ Saved: ${result.path.split(/[/\\]/).pop()}`);
    document.getElementById('exportStartBtn').textContent = '✓ Done';
    setTimeout(()=>closeModal('exportModal'), 2000);
  } catch(e){
    const msg = e?.message || (typeof e === 'string' ? e : JSON.stringify(e)) || 'unknown error';
    jlog('error', `_doPywebviewExport caught: ${msg}`);
    if(e?.stack) jlog('error', e.stack);
    toast(`✕ Export failed: ${msg}`);
    _setExportUI('idle');
  }
}

async function _doFlaskExport(){
  const outputName  = document.getElementById('exportFilename').value.trim() || `clipcut_${Date.now()}.mp4`;
  const folderInput = document.getElementById('exportFolder').value.trim();
  const isPickerAnnotated = /\(via browser picker\)/i.test(folderInput);
  const rawPath = folderInput.replace(/\s*\(via browser picker\)\s*/i,'').trim();
  // Only treat as a Flask server-side path if it looks like a real absolute path
  const isAbsPath = /^[A-Za-z]:[/\\]|^\//.test(rawPath);
  const saveFolder = isAbsPath ? rawPath : '';
  if(isAbsPath) localStorage.setItem('vexxe_export_folder', rawPath);
  else if(!isPickerAnnotated) localStorage.removeItem('vexxe_export_folder');
  // If not using the dir handle and there's no annotation, the user cleared the folder
  if(!_exportDirHandle && !isPickerAnnotated && !rawPath){
    localStorage.removeItem('vexxe_export_folder_picker_name');
  }

  const segs = S.segments.length
    ? S.segments.map(s=>({start:s.sourceStart, end:s.sourceEnd}))
    : [{start:S.trimIn||0, end:S.trimOut||S.duration}];
  const segMeta = S.segments.length
    ? S.segments.map(s=>({sourceStart:s.sourceStart,sourceEnd:s.sourceEnd,timelineStart:s.timelineStart}))
    : [];

  _setExportUI('running');

  try{
    const fd = new FormData();
    fd.append('file',          S.current.file, S.current.name);
    fd.append('segments',      JSON.stringify(segs));
    fd.append('seg_meta',      JSON.stringify(segMeta));
    fd.append('output_name',   outputName);
    fd.append('preset',        _exportPreset);
    fd.append('flip_h',        String(S.flipH));
    fd.append('flip_v',        String(S.flipV));
    fd.append('burn_captions', String(_exportBurnCap));
    if(_exportBurnCap) fd.append('captions', JSON.stringify(S.captions));
    // Only send save_folder to Flask for manually typed paths.
    // For browser-picker folders (_exportDirHandle), we download the blob
    // and write it via the File System Access API ourselves.
    if(saveFolder && !_exportDirHandle) fd.append('save_folder', saveFolder);

    _setExportLabel('Uploading to server...');
    const resp = await fetch(`${getWhisperBase()}/export/start`,{
      method:'POST', body:fd, signal:AbortSignal.timeout(120000)
    });
    if(!resp.ok){
      const e=await resp.json().catch(()=>({error:'Upload failed '+resp.status}));
      throw new Error(e.error||'Upload failed');
    }
    const {job_id, total_duration} = await resp.json();
    _exportJobId = job_id;

    _setExportLabel(`Encoding… ${total_duration.toFixed(1)}s output`);

    // Open SSE progress stream
    await new Promise((resolve,reject)=>{
      const sse = new EventSource(`${getWhisperBase()}/export/progress/${job_id}`);
      _exportSSE = sse;
      sse.onmessage = e=>{
        try{
          const d = JSON.parse(e.data);
          _setExportProgress(d.progress||0, d.elapsed||0, d.status);
          if(d.status==='done'){
            sse.close(); _exportSSE=null; resolve();
          } else if(d.status==='error'){
            sse.close(); _exportSSE=null; reject(new Error(d.error||'ffmpeg failed'));
          } else if(d.status==='cancelled'){
            sse.close(); _exportSSE=null; reject(new Error('cancelled'));
          }
        }catch(err){sse.close();reject(err);}
      };
      sse.onerror=()=>{sse.close();_exportSSE=null;reject(new Error('SSE connection lost'));};
    });

    // Finish — download blob, then either write via FS API, save via Flask path, or browser download
    _setExportLabel(_exportDirHandle ? `Saving to ${_exportDirHandle.name}…` : saveFolder ? 'Saving to folder…' : 'Downloading…');
    const dlResp = await fetch(`${getWhisperBase()}/export/download/${_exportJobId}`);
    if(!dlResp.ok) throw new Error('Download failed '+dlResp.status);

    if(_exportDirHandle){
      const blob = await dlResp.blob();
      try{
        const fh = await _exportDirHandle.getFileHandle(outputName, {create:true});
        const wr = await fh.createWritable();
        await wr.write(blob);
        await wr.close();
        _setExportProgress(100, 0, 'done');
        _setExportLabel(`✓ Saved to ${_exportDirHandle.name}/${outputName}`);
        toast(`✓ Saved: ${_exportDirHandle.name}/${outputName}`);
      } catch(fsErr){
        console.warn('[export] FS API write failed, falling back to browser download:', fsErr);
        toast(`⚠ Folder write failed — downloading instead`);
        const url = URL.createObjectURL(blob);
        const a   = document.createElement('a');
        a.href = url; a.download = outputName;
        document.body.appendChild(a); a.click(); document.body.removeChild(a);
        setTimeout(()=>URL.revokeObjectURL(url), 30000);
        _setExportProgress(100, 0, 'done');
        _setExportLabel(`✓ ${outputName}`);
      }
    } else {
      const savedTo = dlResp.headers.get('X-Saved-To');
      if(savedTo){
        _setExportProgress(100, 0, 'done');
        _setExportLabel(`✓ Saved to ${savedTo}`);
        toast(`✓ Saved: ${savedTo}`);
      } else {
        const blob = await dlResp.blob();
        const url  = URL.createObjectURL(blob);
        const a    = document.createElement('a');
        a.href = url; a.download = outputName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(() => URL.revokeObjectURL(url), 30000);
        _setExportProgress(100, 0, 'done');
        _setExportLabel(`✓ ${outputName}`);
        toast(`✓ Exported: ${outputName}`);
      }
    }
    _exportJobId=null;
    document.getElementById('exportStartBtn').textContent='✓ Done';
    setTimeout(()=>closeModal('exportModal'), 2000);

  } catch(e){
    if(e.message==='cancelled') return;
    console.error('[export] FAILED:', e);
    toast(`✕ Export failed: ${e.message}`);
    _exportJobId=null;
    _setExportUI('idle');
  }
}

async function cancelExport(){
  if(_exportSSE){ _exportSSE.close(); _exportSSE=null; }
  if(_exportJobId){
    fetch(`${getWhisperBase()}/export/cancel/${_exportJobId}`,{method:'POST'}).catch(()=>{});
    _exportJobId=null;
  }
  if(window.pywebview) window.pywebview.api.cancel_export().catch(()=>{});
  _setExportUI('idle');
  toast('Export cancelled');
}

function _setExportUI(state){
  const prog  = document.getElementById('exportProgress');
  const start = document.getElementById('exportStartBtn');
  const cancel= document.getElementById('exportCancelBtn');
  if(state==='running'){
    prog.style.display='block';
    start.disabled=true;
    start.textContent='Encoding…';
    cancel.textContent='✕ Cancel Export';
  } else {
    start.disabled=false;
    start.textContent='⬇ Export';
    cancel.textContent='Cancel';
  }
}

function _setExportLabel(msg){
  document.getElementById('exportStatusLabel').textContent=msg;
}

function _setExportProgress(pct, elapsed, status){
  document.getElementById('exportProgressFill').style.width=pct+'%';
  document.getElementById('exportProgressPct').textContent=pct+'%';
  document.getElementById('exportElapsed').textContent=elapsed+'s';
  const color = status==='done'?'var(--teal)':status==='error'?'var(--red)':'var(--blue-soft)';
  document.getElementById('exportProgressFill').style.background=color;
  const label = status==='done'?'Done':status==='error'?'Failed':pct<5?'Preparing…':pct<100?'Encoding…':'Finishing…';
  document.getElementById('exportProgressLabel').textContent=label;
}

// Legacy alias
function setProgress(pct,label){
  _setExportProgress(pct,0,'running');
  document.getElementById('exportProgressLabel').textContent=label;
}

async function _doWebMExport(){
  document.getElementById('exportProgress').style.display='block';
  _setExportLabel('Recording via MediaRecorder…');
  setProgress(10,'Setting up MediaRecorder...');

  const canvas=document.createElement('canvas');
  canvas.width=video.videoWidth||1080;
  canvas.height=video.videoHeight||1920;
  const ctx2=canvas.getContext('2d');
  const stream=canvas.captureStream(30);

  const audioCtx=new AudioContext();
  const src=audioCtx.createMediaElementSource(video);
  const dest=audioCtx.createMediaStreamDestination();
  src.connect(dest); src.connect(audioCtx.destination);
  stream.addTrack(dest.stream.getAudioTracks()[0]);

  const rec=new MediaRecorder(stream,{mimeType:'video/webm;codecs=vp9'});
  const chunks=[];
  rec.ondataavailable=e=>chunks.push(e.data);

  setProgress(20,'Recording...');
  video.currentTime=S.trimIn;
  await new Promise(r=>setTimeout(r,200));
  rec.start(100);
  video.play();

  const totalDur=(S.trimOut||S.duration)-S.trimIn;
  const startT=performance.now();
  const drawLoop=()=>{
    ctx2.drawImage(video,0,0,canvas.width,canvas.height);
    const elapsed=(performance.now()-startT)/1000;
    const pct=Math.min(20+(elapsed/totalDur)*70,90);
    setProgress(Math.round(pct),`Recording... ${elapsed.toFixed(1)}/${totalDur.toFixed(1)}s`);
    if(elapsed<totalDur && S.playing) requestAnimationFrame(drawLoop);
  };
  drawLoop();

  await new Promise(r=>{
    const check=setInterval(()=>{
      if(video.currentTime>=(S.trimOut||S.duration)-0.1){
        clearInterval(check); video.pause(); rec.stop();
        S.playing=false; _setPlayIcon(false);
        r();
      }
    },100);
  });

  setProgress(95,'Finalizing...');
  await new Promise(r=>setTimeout(r,300));
  const blob=new Blob(chunks,{type:'video/webm'});
  const url=URL.createObjectURL(blob);
  const fname = (document.getElementById('exportFilename')?.value||`clipcut_${Date.now()}`).replace(/\.mp4$/i,'')+'.webm';
  const a=document.createElement('a'); a.href=url; a.download=fname;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(()=>URL.revokeObjectURL(url),30000);
  setProgress(100,'✓ Done!');
  _setExportLabel('✓ WebM exported');
  toast('✓ Exported as WebM');
  audioCtx.close();
  setTimeout(()=>closeModal('exportModal'),1500);
}

// exportMP4FFmpeg kept as alias for any legacy HTML onclick calls
async function exportMP4FFmpeg(){ await _doFlaskExport(); }

function exportFrame(){
  if(!video.src){toast('No video');return;}
  const c=document.createElement('canvas');
  c.width=video.videoWidth; c.height=video.videoHeight;
  c.getContext('2d').drawImage(video,0,0);
  const a=document.createElement('a'); a.href=c.toDataURL('image/png'); a.download='frame.png'; a.click();
  toast('📸 Frame exported!');
}

