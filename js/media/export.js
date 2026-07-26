// ═══════════════════════════════════════
// EXPORT
// ═══════════════════════════════════════
let _exportFormat  = 'mp4';
let _exportPreset  = 'fast';
let _exportBurnCap = false;

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
  if(document.getElementById('exportStartBtn').disabled) cancelExport();
  closeModal('exportModal');
}

// Called by Python via evaluate_js() during pywebview export
function _onExportProgress(pct) {
  _setExportProgress(pct, 0, pct >= 100 ? 'done' : 'running');
}

async function startExport(){
  if(!S.current){toast('No clip');return;}
  if(_exportFormat==='webm'){ await _doWebMExport(); return; }
  if(window.pywebview && S.current.sourcePath){
    await _doPywebviewExport();
    return;
  }
  toast('✕ Export requires the desktop app with a real file path (open via 📂, not drag-drop)');
}

async function _doPywebviewExport(){
  const outputName = document.getElementById('exportFilename').value.trim() || `clipcut_${Date.now()}.mp4`;
  const segs = S.segments.length
    ? S.segments.map(s=>({start:s.sourceStart, end:s.sourceEnd}))
    : [{start:S.trimIn||0, end:S.trimOut||S.duration}];
  // gaplessSegmentMeta(), not S.segments directly — the exported video is
  // always a gapless concat of kept segments, but S.segments[].timelineStart
  // may currently hold real pre-snap gaps (gap-hatching), which would
  // desync burned-in caption timing from the actual export.
  const segMeta = S.segments.length ? gaplessSegmentMeta() : [];

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
      S.aspectMode,
      // S.textStyle + the live preview element's rendered height — lets
      // _generate_ass() (serve.py) scale font/stroke proportionally from
      // "px in the preview box" to "px in the actual exported frame"
      _exportBurnCap ? JSON.stringify(S.textStyle) : '{}',
      _exportBurnCap ? (video.clientHeight||0) : 0,
      S.captionMode
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

async function cancelExport(){
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

function exportFrame(){
  if(!video.src){toast('No video');return;}
  const c=document.createElement('canvas');
  c.width=video.videoWidth; c.height=video.videoHeight;
  c.getContext('2d').drawImage(video,0,0);
  const a=document.createElement('a'); a.href=c.toDataURL('image/png'); a.download='frame.png'; a.click();
  toast('📸 Frame exported!');
}

