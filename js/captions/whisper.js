// ═══════════════════════════════════════
// WHISPER SERVER
// ═══════════════════════════════════════
S.whisperPort = localStorage.getItem('vexxe_whisper_port') || S.whisperPort;
S.whisperMode = localStorage.getItem('vexxe_whisper_mode') || S.whisperMode;

function setWhisperMode(m){
  S.whisperMode=m;
  localStorage.setItem('vexxe_whisper_mode', m);
  ['modeCapBtn','modeWordBtn','modeSegBtn'].forEach(id=>document.getElementById(id)?.classList.remove('active'));
  const map={captions:'modeCapBtn',words:'modeWordBtn',segments:'modeSegBtn'};
  document.getElementById(map[m])?.classList.add('active');
}

async function checkWhisperServer(){
  const el=document.getElementById('whisperStatus');
  el.textContent='⏳ Loading model...'; el.style.color='var(--text2)';
  try{
    if(!window.pywebview) throw new Error('Not running in pywebview — launch via serve.py');
    const d=await window.pywebview.api.ping();
    if(!d.online) throw new Error(d.error||'Model failed to load');
    const backendLabel = d.backend==='parakeet' ? 'Parakeet' : d.backend==='whisperx' ? 'WhisperX' : 'faster-whisper';
    const backendColor = d.backend==='parakeet' ? 'var(--teal)' : d.backend==='whisperx' ? 'var(--blue-soft)' : 'var(--text2)';
    el.textContent=`✓ Ready — ${backendLabel} · ${d.model} · ${d.device}`;
    el.style.color='var(--accent)';
    // Update settings tab backend badge if present
    const badge=document.getElementById('settingsBackendBadge');
    if(badge){ badge.textContent=backendLabel; badge.style.color=backendColor; }
    toast(`✓ ${backendLabel} ready`);
  } catch(e){
    el.textContent=`✕ ${e.message}`;
    el.style.color='var(--red)';
  }
}

async function transcribeWithWhisper(){
  if(!S.current){toast('Load a video first');return;}
  if(!window.pywebview){toast('Transcription requires the pywebview app — launch via serve.py');return;}
  if(!S.current.sourcePath){toast('Use 📂 Open File to import clips for transcription');return;}

  const el=document.getElementById('whisperStatus');
  el.textContent='⏳ Transcribing... (hang tight)';
  el.style.color='var(--teal)';
  const _badge=document.getElementById('settingsBackendBadge');
  toast(`⏳ Running ${_badge?.textContent||'Whisper'}...`);

  try{
    const data=await window.pywebview.api.transcribe(S.current.sourcePath);
    if(data.error) throw new Error(data.error);

    const backendLabel = data.backend === 'parakeet' ? 'Parakeet'
                       : data.backend === 'whisperx'  ? 'WhisperX'
                       : 'faster-whisper';

    // Use real video FPS from ffprobe for accurate frame-snapping; fall back to 30
    if (data.fps && data.fps > 0) _captionFps = data.fps;

    // Build word objects — preserve rawText for sentence-boundary detection so that
    // strip-punctuation mode doesn't break .!? chunk splitting
    const rawWords = (data.words || []);
    const words = rawWords.map(w => {
      const raw  = w.word;
      const disp = S.stripPunct ? raw.replace(/[^\w\s'%]/g, '').trim() : raw;
      return disp ? { rawText: raw, text: disp, start: w.start, end: w.end } : null;
    }).filter(Boolean);

    // Chunk by sentence-ending punctuation (.!?) or max word count
    const chunks = _chunkWordsByPunct(words, S.wordsPerCap);
    const fps    = _captionFps;
    const LEAD   = 0.05; // 50 ms lead-in before first spoken word

    // Pre-compute all snapped starts so strict-mode ends use the exact same float
    // → same frame number → zero gap in CapCut / Premiere / DaVinci
    const starts = chunks.map(chunk =>
      Math.max(0, _snapToFrame(chunk[0].start - LEAD, fps))
    );

    const captions = chunks.map((chunk, i) => {
      const start  = starts[i];
      const isLast = i === chunks.length - 1;
      // Strict gapless: end of block N = start of block N+1 (same float, same frame)
      const end = isLast
        ? Math.max(_snapToFrame(chunk[chunk.length - 1].end, fps), start + 0.001)
        : Math.max(starts[i + 1], start + 0.001);
      return { id: i, text: chunk.map(w => w.text).join(' '), start, end };
    });

    saveHistory();
    S.captions=captions;

    // Absorb retake cuts if WhisperX detected them and the setting is on
    if(data.retake_cuts?.length && S.settings.detectRetakes){
      const ts=Date.now();
      const newRetakes=data.retake_cuts.map((c,i)=>({
        id:`retake-${ts}-${i}`, start:c.start, end:c.end,
        type:'retake', selected:true, skipEnabled:true, scriptPart:false,
        text:'', aiNote:'whisperx retake', _src:'retake'
      }));
      S.cuts=[...S.cuts.filter(c=>c._src!=='retake'),...newRetakes];
      jlog('info',`WhisperX: ${newRetakes.length} retakes added to cuts`);
    }

    updateCaptionList(); renderAllFindings(); renderTimeline(); buildPlaySegments();
    const retakeNote = (data.retake_cuts?.length && S.settings.detectRetakes)
      ? ` · ${data.retake_cuts.length} retake${data.retake_cuts.length!==1?'s':''}` : '';
    el.textContent=`✓ ${captions.length} captions · ${backendLabel} · ${data.language}`;
    el.style.color='var(--accent)';
    toast(`✦ ${captions.length} captions (${backendLabel})${retakeNote}`);
    _updateDeadSpacesBtn();
    _updateFillerBtn();
  } catch(e){
    el.textContent=`✕ ${e.message}`;
    el.style.color='var(--red)';
    toast('✕ '+e.message);
  }
}

// legacy stub — captionModal's Generate button still calls this
function generateAICaptions(){ transcribeWithWhisper(); }
