// ═══════════════════════════════════════
// AUDIO ANALYSIS (Web Audio API)
// ═══════════════════════════════════════
async function extractAudioData(silent=false){
  if(!S.current)return null;
  if(!silent) toast('🔊 Analyzing audio waveform...');
  const ctx=new AudioContext();
  const res=await fetch(S.current.url);
  const buf=await res.arrayBuffer();
  const audio=await ctx.decodeAudioData(buf);
  const ch=audio.getChannelData(0);
  const sr=audio.sampleRate;
  const dur=audio.duration;
  // RMS per 0.05s frame
  const frameSize=Math.floor(sr*0.05);
  const frames=[];
  for(let i=0;i<ch.length;i+=frameSize){
    const slice=ch.slice(i,i+frameSize);
    const rms=Math.sqrt(slice.reduce((a,v)=>a+v*v,0)/slice.length);
    frames.push({t:i/sr, rms});
  }
  S.waveformData={frames,dur,sr};
  drawWaveformModal(frames);
  drawTimelineWaveform();
  _updateDeadSpacesBtn();
  ctx.close();
  return frames;
}

// ── Waveform rendering — OffscreenCanvas worker when supported ─────────────────
let _waveWorker    = null;
let _workerTlReady = false;
let _workerModReady= false;

(function _initWaveWorker() {
  const tlCanvas  = document.getElementById('tlWaveCanvas');
  const modCanvas = document.getElementById('waveCanvas');
  if (!tlCanvas.transferControlToOffscreen) {
    jlog('info', 'Waveform: main-thread canvas (OffscreenCanvas not supported)');
    return;
  }
  try {
    _waveWorker = new Worker('waveform.worker.js');
    const tlOff  = tlCanvas.transferControlToOffscreen();
    const modOff = modCanvas.transferControlToOffscreen();
    _waveWorker.postMessage({ type: 'init_tl',  canvas: tlOff  }, [tlOff]);
    _waveWorker.postMessage({ type: 'init_mod', canvas: modOff }, [modOff]);
    _workerTlReady  = true;
    _workerModReady = true;
    jlog('info', 'Waveform: OffscreenCanvas worker active');
  } catch(e) {
    _waveWorker = null;
    jlog('warn', `Waveform worker init failed (${e.message}) — falling back to main thread`);
  }
})();

function drawWaveformModal(frames) {
  const c = document.getElementById('waveCanvas');
  const W = c.offsetWidth || 480;
  const H = c.offsetHeight || 70;
  if (_waveWorker && _workerModReady) {
    _waveWorker.postMessage({ type: 'draw_mod', frames, W, H });
    return;
  }
  // Main-thread fallback
  const ctx = c.getContext('2d');
  c.width = W; c.height = H;
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#0f0f12';
  ctx.fillRect(0, 0, W, H);
  const maxRms = Math.max(...frames.map(f => f.rms)) || 1;
  const bw = W / frames.length;
  frames.forEach((f, i) => {
    const h = (f.rms / maxRms) * (H * 0.8);
    ctx.fillStyle = 'rgba(78,205,196,0.7)';
    ctx.fillRect(i * bw, H / 2 - h / 2, Math.max(bw - 0.5, 0.5), h);
  });
}

function drawTimelineWaveform() {
  const c   = document.getElementById('tlWaveCanvas');
  const row = document.getElementById('waveformRow');
  const H   = 50;
  const W   = row.clientWidth || 600;

  let totalPx = W;
  if (S.segments.length) {
    const last = S.segments[S.segments.length - 1];
    totalPx = Math.max((last.timelineStart + last.duration) * S.zoom, W);
  } else if (S.waveformData) {
    totalPx = Math.max(S.waveformData.dur * S.zoom, W);
  }

  const hasSlices = S.segments.some(seg => seg.waveformSlice);

  if (_waveWorker && _workerTlReady) {
    // Worker owns the canvas — send data, it draws
    c.style.width = totalPx + 'px';
    _waveWorker.postMessage({
      type:           'draw_tl',
      frames:         S.waveformData?.frames || [],
      slicedSegments: hasSlices ? S.segments.map(s => ({
        timelineStart: s.timelineStart,
        sourceStart:   s.sourceStart,
        waveformSlice: s.waveformSlice,
      })) : null,
      zoom:    S.zoom,
      totalPx,
      H,
    });
    return;
  }

  // Main-thread fallback
  c.style.width = totalPx + 'px';
  c.width = totalPx; c.height = H;
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, totalPx, H);

  if (hasSlices) {
    S.segments.forEach(seg => {
      const slice = seg.waveformSlice;
      if (!slice || !slice.length) return;
      const maxRms = Math.max(...slice.map(f => f.rms)) || 1;
      const offsetPx = seg.timelineStart * S.zoom;
      slice.forEach(f => {
        const x = offsetPx + (f.t - seg.sourceStart) * S.zoom;
        const h = (f.rms / maxRms) * (H * 0.75);
        ctx.fillStyle = 'rgba(78,205,196,0.55)';
        ctx.fillRect(x, H / 2 - h / 2, Math.max(S.zoom * 0.05 - 0.5, 0.5), h);
      });
    });
    return;
  }

  if (!S.waveformData) return;
  const frames = S.waveformData.frames;
  const maxRms = Math.max(...frames.map(f => f.rms)) || 1;
  frames.forEach(f => {
    const x = f.t * S.zoom;
    const h = (f.rms / maxRms) * (H * 0.75);
    ctx.fillStyle = 'rgba(78,205,196,0.55)';
    ctx.fillRect(x, H / 2 - h / 2, Math.max(S.zoom * 0.05 - 0.5, 0.5), h);
  });
}

function detectSilences(frames){
  const ss=getSilenceSettings();
  const threshold=ss.threshold;
  const minDur=ss.minDuration;
  const padBefore=ss.padBefore;
  const padAfter=ss.padAfter;
  // Convert dB threshold to linear
  const linThresh=Math.pow(10,threshold/20)*0.1;
  const segs=[];
  let inSil=false,silStart=0;
  frames.forEach((f,i)=>{
    if(f.rms<linThresh && !inSil){inSil=true;silStart=f.t;}
    else if(f.rms>=linThresh && inSil){
      const dur2=f.t-silStart;
      if(dur2>=minDur){
        segs.push({start:Math.max(0,silStart-padBefore),end:Math.min(S.duration,f.t+padAfter),rms:linThresh,aiNote:'',cut:true});
      }
      inSil=false;
    }
  });
  if(inSil&&(frames[frames.length-1].t-silStart)>=minDur){
    segs.push({start:Math.max(0,silStart-padBefore),end:S.duration,rms:linThresh,aiNote:'',cut:true});
  }
  return segs;
}

function sliceWaveforms(){
  if(!S.waveformData) return;
  const frames=S.waveformData.frames;
  S.segments.forEach(seg=>{
    seg.waveformSlice=frames.filter(f=>
      f.t>=seg.sourceStart && f.t<=seg.sourceEnd
    );
  });
  // Do NOT call drawTimelineWaveform() here — the caller must call renderTimeline()
  // or drawTimelineWaveform() afterward. Calling it here sends a worker message with
  // stale tracksInner dimensions, then renderTimeline sends another with the resized
  // dimensions but a mismatched CSS width — causing the canvas to display squished.
}
