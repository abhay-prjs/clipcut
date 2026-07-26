// ═══════════════════════════════════════
// BATCH EXPORT — "Process All" factory pipeline (Part F3)
// ═══════════════════════════════════════
// Runs template apply (optional) → Auto/Deep Mode (optional) → edit-lint
// (advisory, doesn't block) → export, sequentially, across every checked
// clip in the Media library. One destination folder chosen up front
// (pick_folder()) instead of a native Save dialog per clip —
// export_video_batch_one() (serve.py) writes directly to a computed path,
// reusing the exact same encode core as the interactive single-clip export.

let _batchRunning = false;
let _batchCancelled = false;

async function openBatchModal(){
  if(!S.clips.length){ toast('Import at least one clip first'); return; }
  renderBatchClipList();
  await refreshTemplateList();
  const sel = document.getElementById('batchTemplateSelect');
  if(sel){
    sel.innerHTML = '<option value="">— No template —</option>' +
      Object.keys(_templatesCache).sort().map(n => `<option value="${_escTx(n)}">${_escTx(n)}</option>`).join('');
  }
  openModal('batchModal');
}

function renderBatchClipList(){
  const el = document.getElementById('batchClipList');
  if(!el) return;
  el.innerHTML = S.clips.map(c => `
    <div class="sil-result-item" style="cursor:default">
      <label style="display:flex;align-items:center;gap:8px;flex:1;min-width:0;cursor:pointer">
        <input type="checkbox" class="batch-clip-chk" data-clip-id="${c.id}" ${c.sourcePath ? 'checked' : 'disabled'} style="flex-shrink:0">
        <span style="font-size:10px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escTx(c.name)}${c.sourcePath ? '' : ' (no file path)'}</span>
      </label>
      <span class="batch-clip-status" data-status-for="${c.id}" style="font-size:9px;color:var(--text3);flex-shrink:0">queued</span>
    </div>
  `).join('');
}

function _batchSelectedClipIds(){
  return [...document.querySelectorAll('.batch-clip-chk:checked')].map(el => el.dataset.clipId);
}

function _setBatchStatus(clipId, text, color){
  const el = document.querySelector(`[data-status-for="${clipId}"]`);
  if(el){ el.textContent = text; el.style.color = color || 'var(--text3)'; }
}

function _batchOutputName(clip, templateName){
  const base  = clip.name.replace(/\.[^.]+$/, '');
  const date  = new Date().toISOString().slice(0, 10);
  const tag   = templateName || 'clipcut';
  return `${base}_${tag}_${date}.mp4`.replace(/[<>:"/\\|?*]/g, '_');
}

function _joinPath(folder, name){
  const sep = folder.includes('\\') ? '\\' : '/';
  return folder.replace(/[\\/]+$/, '') + sep + name;
}

async function runBatchExport(){
  if(_batchRunning){ toast('Batch already running'); return; }
  if(!window.pywebview){ toast('Batch export requires the desktop app'); return; }
  const ids = _batchSelectedClipIds();
  if(!ids.length){ toast('Check at least one clip'); return; }

  const outputFolder = await window.pywebview.api.pick_folder();
  if(!outputFolder) return;

  const deep          = !!document.getElementById('batchDeepMode')?.checked;
  const runAuto       = document.getElementById('batchRunAuto')?.checked !== false;
  const templateName  = document.getElementById('batchTemplateSelect')?.value || '';

  _batchRunning   = true;
  _batchCancelled = false;
  const startBtn  = document.getElementById('batchStartBtn');
  const cancelBtn = document.getElementById('batchCancelBtn');
  if(startBtn)  startBtn.disabled  = true;
  if(cancelBtn) cancelBtn.disabled = false;

  let done = 0, failed = 0;

  for(const id of ids){
    if(_batchCancelled){ _setBatchStatus(id, 'cancelled'); continue; }
    const clip = S.clips.find(c => c.id === id);
    if(!clip || !clip.sourcePath){ _setBatchStatus(id, 'no file path', 'var(--red)'); failed++; continue; }

    try{
      _setBatchStatus(id, 'loading…', 'var(--text2)');
      selectClip(id);
      // selectClip() swaps video.src and waits on onloadedmetadata internally
      // for preview purposes only — give it a moment before reading S.duration
      // /S.segments elsewhere in this loop rather than threading a callback
      // through selectClip() itself.
      await new Promise(r => setTimeout(r, 300));

      if(templateName){
        _setBatchStatus(id, 'template…', 'var(--text2)');
        await applyTemplate(templateName);
      }
      if(runAuto){
        _setBatchStatus(id, 'auto mode…', 'var(--teal)');
        await runAutoMode(deep);
      }

      // Advisory only — batch doesn't block or auto-fix on findings, just
      // leaves them computed (S_lintFindings) in case of later review; the
      // whole point of batch is unattended operation.
      runEditLint();

      _setBatchStatus(id, 'exporting…', 'var(--blue-soft)');
      const outputName = _batchOutputName(clip, templateName);
      const savePath    = _joinPath(outputFolder, outputName);

      const segs = S.segments.length
        ? S.segments.map(s => ({start: s.sourceStart, end: s.sourceEnd}))
        : [{start: S.trimIn||0, end: S.trimOut||S.duration}];
      // Forced on when text layers exist — same reasoning as _doPywebviewExport():
      // "Add Text" only reaches the export through the ASS burn-in path.
      const burnCap  = (typeof _exportBurnCap !== 'undefined' && _exportBurnCap) || S.textLayers.length>0;
      const segMeta  = (burnCap && S.segments.length) ? gaplessSegmentMeta() : [];

      const result = await window.pywebview.api.export_video_batch_one(
        clip.sourcePath,
        JSON.stringify(segs),
        savePath,
        typeof _exportPreset !== 'undefined' ? _exportPreset : 'fast',
        S.flipH,
        S.flipV,
        burnCap,
        burnCap ? JSON.stringify(S.captions) : '[]',
        burnCap ? JSON.stringify(segMeta) : '[]',
        S.aspect,
        S.aspectMode,
        burnCap ? JSON.stringify(S.textStyle) : '{}',
        burnCap ? (video.clientHeight||0) : 0,
        S.captionMode,
        burnCap ? JSON.stringify(S.textLayers) : '[]'
      );

      if(!result?.success){
        _setBatchStatus(id, `✕ ${result?.error || 'failed'}`, 'var(--red)');
        failed++;
      } else {
        _setBatchStatus(id, '✓ done', 'var(--teal)');
        done++;
      }
    } catch(e){
      _setBatchStatus(id, `✕ ${e.message}`, 'var(--red)');
      failed++;
    }
  }

  _batchRunning = false;
  if(startBtn)  startBtn.disabled  = false;
  if(cancelBtn) cancelBtn.disabled = true;
  toast(`⚡ Batch done — ${done} exported${failed ? `, ${failed} failed` : ''}`);
}

function cancelBatch(){
  _batchCancelled = true;
  toast('Cancelling after the current clip finishes…');
}
