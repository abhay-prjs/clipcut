// ═══════════════════════════════════════
// IMAGE / STICKER LAYERS ("+ Image")
// ═══════════════════════════════════════
// Data model: S.imageLayers[] = {id, path, url, text? (unused), start, end
// (source time), style:{posX,posY,posZ}}. Much lighter than text layers —
// no font/color/stroke, just position + scale — since the content is a
// fixed image file, not something styled in-app.
//
// Export is NOT the ASS pipeline (ASS is text/subtitle-only) — it's real
// ffmpeg compositing via the overlay filter (_make_filter_complex in
// serve.py), which needs the image as its own -i input. See js/media/export.js.

function _defaultImageLayerStyle(){
  return { posX: 50, posY: 50, posZ: 1 };
}

// Shared by both add paths (native picker, or clicking an Asset Library
// thumbnail) so the actual layer-creation logic only lives in one place.
function _createImageLayerAtPlayhead(path, url){
  const dur = S.duration || 10;
  const start = Math.min(video.currentTime||0, Math.max(0, dur-0.5));
  const end   = Math.min(start + 3, dur);
  saveHistory();
  const layer = {
    id: crypto.randomUUID(),
    path, url,
    start, end,
    hidden: false,
    style: _defaultImageLayerStyle(),
  };
  S.imageLayers.push(layer);
  S.selectedImageLayerId = layer.id;
  S.selectedTextLayerId = null;
  renderTimeline();
  updateImageLayerOverlays(video.currentTime||0);
  switchInspTab('overlay');
  renderImageLayerInspector();
  renderTextLayerInspector();
}

async function addImageLayer(){
  if(!S.current){ toast('Load a video first'); return; }
  if(!window.pywebview){ toast('Image overlays require the desktop app'); return; }
  let path = await window.pywebview.api.pick_image();
  if(!path) return;

  // Copy the picked file into <video>_assets/ so the project's assets stay
  // self-contained next to the source video instead of scattered wherever
  // the user originally had it — see the Asset Library section below.
  if(S.current.sourcePath){
    try { path = await window.pywebview.api.import_asset(S.current.sourcePath, path); }
    catch(e){ jlog('warn', `import_asset failed, using original path: ${e.message}`); }
  }

  const url = `${window.location.origin}/video?path=${encodeURIComponent(path)}`;
  _createImageLayerAtPlayhead(path, url);
  toast('✓ Image added — edit it in the Overlay tab');
  refreshAssetLibrary();
}

function addImageLayerFromAsset(path){
  if(!S.current){ toast('Load a video first'); return; }
  const url = `${window.location.origin}/video?path=${encodeURIComponent(path)}`;
  _createImageLayerAtPlayhead(path, url);
  toast('✓ Added from asset library');
}

// ── Asset Library ("working folder") — every image previously used on this
// video lives in a sibling <video>_assets/ folder (serve.py's
// ensure_assets_folder/list_assets/import_asset); this grid shows it as
// click-to-add thumbnails instead of native-picking the same sticker again
// on every clip that reuses it. Lazy-loaded the same way _loadWhisperConfig-
// FromServer() is — only fetched when the Overlay tab is actually opened. ──
let _assetLibraryPaths = [];

async function refreshAssetLibrary(){
  const grid = document.getElementById('assetLibraryGrid');
  if(!grid) return;
  if(!S.current || !S.current.sourcePath || !window.pywebview){
    _assetLibraryPaths = [];
    grid.innerHTML = '<div class="empty-state" style="padding:8px 0;font-size:9.5px">Load a video first</div>';
    return;
  }
  try { _assetLibraryPaths = await window.pywebview.api.list_assets(S.current.sourcePath); }
  catch(e){ jlog('warn', `list_assets failed: ${e.message}`); _assetLibraryPaths = []; }

  if(!_assetLibraryPaths.length){
    grid.innerHTML = '<div class="empty-state" style="padding:8px 0;font-size:9.5px">No assets yet — Import one</div>';
    return;
  }
  grid.innerHTML = _assetLibraryPaths.map((p,i)=>{
    const url = `${window.location.origin}/video?path=${encodeURIComponent(p)}`;
    const name = p.split(/[/\\]/).pop();
    return `<div class="asset-thumb" data-idx="${i}" title="${_escTx(name)}">
      <img src="${url}" loading="lazy">
    </div>`;
  }).join('');
  grid.querySelectorAll('.asset-thumb').forEach(el=>{
    el.addEventListener('click', ()=> addImageLayerFromAsset(_assetLibraryPaths[+el.dataset.idx]));
  });
}

async function importAssetToLibrary(){
  if(!S.current || !S.current.sourcePath){ toast('Load a video first'); return; }
  if(!window.pywebview){ toast('Requires the desktop app'); return; }
  const path = await window.pywebview.api.pick_image();
  if(!path) return;
  try {
    await window.pywebview.api.import_asset(S.current.sourcePath, path);
    toast('✓ Asset imported');
    refreshAssetLibrary();
  } catch(e){
    jlog('error', `importAssetToLibrary: import_asset failed: ${e.message}`);
    toast('✕ Import failed');
  }
}

function deleteImageLayer(id){
  id = id || S.selectedImageLayerId;
  if(!id) return;
  saveHistory();
  S.imageLayers = S.imageLayers.filter(l=>l.id!==id);
  if(S.selectedImageLayerId===id) S.selectedImageLayerId=null;
  renderTimeline();
  updateImageLayerOverlays(video.currentTime||0);
  renderImageLayerInspector();
  renderTextLayerInspector();
  toast('✕ Image removed');
}

function selectImageLayer(id){
  S.selectedImageLayerId = id;
  S.selectedTextLayerId = null; // separate tabs now, but keep selection state mutually exclusive
  document.querySelectorAll('.tl-imagelayer').forEach(el=>el.classList.toggle('selected', el.dataset.imgId===id));
  switchInspTab('overlay');
  renderImageLayerInspector();
  renderTextLayerInspector();
  const layer = S.imageLayers.find(l=>l.id===id);
  if(layer && video.src) video.currentTime = layer.start;
}

function _selectedImageLayer(){
  return S.imageLayers.find(l=>l.id===S.selectedImageLayerId) || null;
}

// Eye toggle — see toggleTextLayerHidden() in textlayers.js for the full
// rationale (not saveHistory()'d, skipped by both preview and export).
function toggleImageLayerHidden(id){
  const l = S.imageLayers.find(x=>x.id===id); if(!l) return;
  l.hidden = !l.hidden;
  renderTimeline();
  updateImageLayerOverlays(video.currentTime||0);
  renderLayerOutliner();
}

function syncImageLayerPos(axis,v){
  const l=_selectedImageLayer(); if(!l) return;
  v=parseFloat(v)||0;
  const key = axis==='x'?'posX':axis==='y'?'posY':'posZ';
  l.style[key]=v;
  const sfx = axis==='x'?'X':axis==='y'?'Y':'Z';
  const slider=document.getElementById('imageLayerPos'+sfx), input=document.getElementById('imageLayerPos'+sfx+'Input');
  if(slider) slider.value=v;
  if(input) input.value=v;
  updateImageLayerOverlays(video.currentTime||0);
}

// ── Preview overlay — one <img> per layer, same pool-management pattern as
// text layers (js/ui/textlayers.js). ────────────────────────────────────
function updateImageLayerOverlays(srcTime){
  const container = document.getElementById('videoContainer');
  if(!container) return;
  const activeIds = new Set();
  S.imageLayers.forEach(layer=>{
    if(layer.hidden || srcTime < layer.start || srcTime > layer.end) return;
    activeIds.add(layer.id);
    let el = document.getElementById('imagelayer-'+layer.id);
    if(!el){
      // A wrapper div (not the <img> itself) so a resize-handle child can
      // sit alongside the image — an <img> can't have DOM children.
      el = document.createElement('div');
      el.id = 'imagelayer-'+layer.id;
      el.className = 'image-layer-overlay';
      const img = document.createElement('img');
      img.src = layer.url;
      img.draggable = false;
      el.appendChild(img);
      const handle = document.createElement('div');
      handle.className = 'layer-resize-handle';
      el.appendChild(handle);
      el.onclick = (e)=>{ e.stopPropagation(); selectImageLayer(layer.id); };
      _bindLayerOverlayDrag(el, layer.id, 'image');
      _bindLayerScaleHandle(handle, layer.id, 'image');
      container.appendChild(el);
    }
    const st = layer.style;
    el.style.left = st.posX+'%';
    el.style.top = st.posY+'%';
    el.style.transform = `translate(-50%,-50%) scale(${st.posZ})`;
    el.classList.toggle('selected', layer.id===S.selectedImageLayerId);
  });
  const allIds = new Set(S.imageLayers.map(l=>l.id));
  container.querySelectorAll('.image-layer-overlay').forEach(el=>{
    const id = el.id.replace('imagelayer-','');
    if(!allIds.has(id)){ el.remove(); return; }
    el.style.display = activeIds.has(id) ? 'block' : 'none';
  });
}

// ── Inspector panel sync — shares the "Text" inspector tab with text layers,
// each showing/hiding its own editor block depending on which kind of
// object is selected (a layer can't be both). ───────────────────────────
function renderImageLayerInspector(){
  const editor = document.getElementById('imageLayerEditor');
  const layer = _selectedImageLayer();
  _updateLayersEmptyState();
  if(!layer){
    if(editor) editor.style.display='none';
    return;
  }
  if(editor) editor.style.display='';

  document.getElementById('imageLayerPreview').src = layer.url;
  document.getElementById('imageLayerStart').textContent = fmt(layer.start);
  document.getElementById('imageLayerEnd').textContent = fmt(layer.end);

  const set=(id,val)=>{const el=document.getElementById(id); if(el) el.value=val;};
  const st = layer.style;
  set('imageLayerPosX', st.posX); set('imageLayerPosXInput', st.posX);
  set('imageLayerPosY', st.posY); set('imageLayerPosYInput', st.posY);
  set('imageLayerPosZ', st.posZ); set('imageLayerPosZInput', st.posZ);
}
