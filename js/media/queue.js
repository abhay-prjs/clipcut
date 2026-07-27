// ═══════════════════════════════════════
// RENDER QUEUE — Adobe Media Encoder style batch export
// ═══════════════════════════════════════
// Different from "📦 Process All" (js/media/batch.js): that pipeline runs
// Auto/Deep Mode + a template unattended across every checked clip — no
// per-clip tweaking, on the assumption the pipeline gets every clip right
// on its own. It doesn't, always — a retake gets missed, an overlay needs
// nudging, a caption needs a manual split. The queue instead lets you set
// up ONE clip exactly the way you want it (cuts applied, captions edited,
// text/image layers placed, export settings chosen), "+ Add to Queue" it
// as a frozen snapshot from the Export modal, move to the next clip and
// repeat, then hit "Render Queue" once everything is queued — same shape
// as Premiere/Media Encoder's render queue.
//
// Each job is a plain JSON-cloned snapshot, not a reference into live
// state — tweaking clip B after queueing clip A can't retroactively change
// A's already-queued job.

let _renderQueue = [];
let _queueRunning = false;
let _queueCancelled = false;

function _updateQueueBadge(){
  const btn = document.getElementById('queueBadgeBtn');
  if(!btn) return;
  btn.textContent = _renderQueue.length ? `🎬 Queue (${_renderQueue.length})` : '🎬 Queue';
}

// Captures the same set of export params _doPywebviewExport() (export.js)
// would send, just frozen into a job object instead of sent immediately.
// Reads the same _export* globals (preset/transition/etc.) the direct
// export path uses, so "what you'd get from Export right now" is exactly
// what gets queued.
function addExportToQueue(){
  if(!S.current){ toast('No clip loaded'); return; }
  if(!S.current.sourcePath){ toast('Queue requires a real file path (open via 📂, not drag-drop)'); return; }

  const outputName = document.getElementById('exportFilename').value.trim()
    || `clipcut_${S.current.name.replace(/\.[^.]+$/,'')}_${Date.now()}.mp4`;
  const segs = S.segments.length
    ? S.segments.map(s=>({start:s.sourceStart, end:s.sourceEnd}))
    : [{start:S.trimIn||0, end:S.trimOut||S.duration}];
  const segMeta = S.segments.length ? gaplessSegmentMeta() : [];
  const visibleTextLayers  = S.textLayers.filter(l=>!l.hidden);
  const visibleImageLayers = S.imageLayers.filter(l=>!l.hidden);
  const burnCap = _exportBurnCap || visibleTextLayers.length>0 || visibleImageLayers.length>0;

  const job = {
    id: crypto.randomUUID(),
    clipName: S.current.name,
    sourcePath: S.current.sourcePath,
    outputName,
    status: 'queued',
    statusMsg: '',
    // JSON round-tripped so this is a real frozen copy, not a reference
    // into S that keeps changing as the user moves on to the next clip.
    segs: JSON.parse(JSON.stringify(segs)),
    preset: _exportPreset,
    flipH: S.flipH, flipV: S.flipV,
    burnCap,
    captions: burnCap ? JSON.parse(JSON.stringify(S.captions)) : [],
    segMeta: burnCap ? JSON.parse(JSON.stringify(segMeta)) : [],
    aspect: S.aspect, aspectMode: S.aspectMode,
    textStyle: burnCap ? JSON.parse(JSON.stringify(S.textStyle)) : {},
    previewHeight: burnCap ? (video.clientHeight||0) : 0,
    captionMode: S.captionMode,
    textLayers: burnCap ? JSON.parse(JSON.stringify(visibleTextLayers)) : [],
    imageLayers: burnCap ? visibleImageLayers.map(l=>({path:l.path, start:l.start, end:l.end, posX:l.style.posX, posY:l.style.posY, posZ:l.style.posZ})) : [],
    transitionType: _exportTransitionType,
    transitionDur: _exportTransitionDur,
    colorFilter: S.colorFilter,
  };
  _renderQueue.push(job);
  _updateQueueBadge();
  renderQueueList();
  toast(`✓ Added to queue (${_renderQueue.length})`);
}

function removeFromQueue(id){
  if(_queueRunning){ toast('Queue is rendering — cancel first'); return; }
  _renderQueue = _renderQueue.filter(j=>j.id!==id);
  _updateQueueBadge();
  renderQueueList();
}

function clearRenderQueue(){
  if(_queueRunning){ toast('Queue is rendering — cancel first'); return; }
  _renderQueue = [];
  _updateQueueBadge();
  renderQueueList();
}

function openQueueModal(){
  renderQueueList();
  openModal('queueModal');
}

function _queueSummary(job){
  const parts = [`${job.segs.length} seg${job.segs.length!==1?'s':''}`, job.preset];
  if(job.burnCap) parts.push('burn-in');
  if(job.transitionType!=='none') parts.push(job.transitionType);
  if(job.colorFilter!=='none') parts.push(job.colorFilter);
  return parts.join(' · ');
}

function renderQueueList(){
  const list = document.getElementById('queueList');
  const empty = document.getElementById('queueEmpty');
  if(!list) return;
  if(empty) empty.style.display = _renderQueue.length ? 'none' : '';
  list.innerHTML = _renderQueue.map(job=>{
    const statusColor = job.status==='done' ? 'var(--teal)' : job.status==='error' ? 'var(--red)' : job.status==='running' ? 'var(--blue-soft)' : 'var(--text3)';
    return `<div class="sil-result-item" style="cursor:default">
      <div style="flex:1;min-width:0">
        <div style="font-size:11px;color:var(--text);white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${_escTx(job.clipName)}</div>
        <div style="font-size:9px;color:var(--text3)">${_escTx(_queueSummary(job))}</div>
      </div>
      <span style="font-size:9.5px;color:${statusColor};flex-shrink:0;margin-right:8px">${_escTx(job.statusMsg||job.status)}</span>
      <span class="layer-row-del" style="opacity:1" onclick="removeFromQueue('${job.id}')" title="Remove">✕</span>
    </div>`;
  }).join('');
}

function _setQueueJobStatus(job, status, msg){
  job.status = status;
  job.statusMsg = msg || status;
  renderQueueList();
}

// Reuses _joinPath() (js/media/batch.js) for building each job's save path
// from the one output folder picked up front — same "one folder, not N
// dialogs" reasoning as Process All.
async function renderQueueAll(){
  if(_queueRunning){ toast('Already rendering'); return; }
  if(!_renderQueue.length){ toast('Queue is empty'); return; }
  if(!window.pywebview){ toast('Render queue requires the desktop app'); return; }

  const outputFolder = await window.pywebview.api.pick_folder();
  if(!outputFolder) return;

  _queueRunning = true;
  _queueCancelled = false;
  const renderBtn = document.getElementById('queueRenderBtn');
  const cancelBtn = document.getElementById('queueCancelBtn');
  if(renderBtn){ renderBtn.disabled = true; renderBtn.textContent = 'Rendering…'; }
  if(cancelBtn) cancelBtn.disabled = false;

  let done=0, failed=0;
  for(const job of _renderQueue){
    if(_queueCancelled){ _setQueueJobStatus(job, 'queued', 'cancelled'); continue; }
    _setQueueJobStatus(job, 'running', 'exporting…');
    const savePath = _joinPath(outputFolder, job.outputName);
    try{
      const result = await window.pywebview.api.export_video_batch_one(
        job.sourcePath,
        JSON.stringify(job.segs),
        savePath,
        job.preset,
        job.flipH, job.flipV,
        job.burnCap,
        JSON.stringify(job.captions),
        JSON.stringify(job.segMeta),
        job.aspect, job.aspectMode,
        JSON.stringify(job.textStyle),
        job.previewHeight,
        job.captionMode,
        JSON.stringify(job.textLayers),
        JSON.stringify(job.imageLayers),
        job.transitionType,
        job.transitionDur,
        job.colorFilter
      );
      if(!result?.success){
        _setQueueJobStatus(job, 'error', `✕ ${result?.error||'failed'}`);
        failed++;
      } else {
        _setQueueJobStatus(job, 'done', '✓ done');
        done++;
      }
    } catch(e){
      _setQueueJobStatus(job, 'error', `✕ ${e.message}`);
      failed++;
    }
  }

  _queueRunning = false;
  if(renderBtn){ renderBtn.disabled = false; renderBtn.textContent = '▶ Render Queue'; }
  if(cancelBtn) cancelBtn.disabled = true;
  toast(`🎬 Queue rendered — ${done} done${failed?`, ${failed} failed`:''}`);
}

function cancelRenderQueue(){
  _queueCancelled = true;
  toast('Cancelling after the current job finishes…');
}
