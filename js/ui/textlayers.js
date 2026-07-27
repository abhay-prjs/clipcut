// ═══════════════════════════════════════
// TEXT LAYERS — "Add Text" (freeform text objects, independent of captions)
// ═══════════════════════════════════════
// Data model: S.textLayers[] = {id, text, start, end (source time), style}.
// style is the same shape as S.textStyle but per-object — each text layer
// carries its own font/size/color/position instead of sharing one global
// style the way captions do, since these are meant to be independent
// on-screen objects (title card, callout, etc.), not one running transcript.
//
// Position/scale can be set two ways, kept in sync: numeric X/Y/Z sliders
// in the Text inspector tab, or dragging the layer/its corner handle
// directly on the preview (see _bindLayerOverlayDrag/_bindLayerScaleHandle
// below) — the on-canvas drag snaps to 0/50/100 on each axis (magnet, not a
// hard grid), overridable by holding Alt for fully free placement.

function _defaultTextLayerStyle(){
  return {
    fontSize: 32, fontFamily: 'Outfit', fontWeight: '800', color: '#ffffff', background: '',
    strokeEnabled: true, strokeThickness: 2, strokeColor: '#000000',
    posX: 50, posY: 50, posZ: 1,
  };
}

function addTextLayer(){
  if(!S.current){ toast('Load a video first'); return; }
  const dur = S.duration || 10;
  const start = Math.min(video.currentTime||0, Math.max(0, dur-0.5));
  const end   = Math.min(start + 3, dur);
  saveHistory();
  const layer = {
    id: crypto.randomUUID(),
    text: 'Text',
    start, end,
    style: _defaultTextLayerStyle(),
  };
  S.textLayers.push(layer);
  S.selectedTextLayerId = layer.id;
  S.selectedImageLayerId = null;
  renderTimeline();
  updateTextLayerOverlays(video.currentTime||0);
  switchInspTab('text');
  renderTextLayerInspector();
  renderImageLayerInspector();
  toast('✓ Text added — edit it in the Text tab');
}

function deleteTextLayer(id){
  id = id || S.selectedTextLayerId;
  if(!id) return;
  saveHistory();
  S.textLayers = S.textLayers.filter(l=>l.id!==id);
  if(S.selectedTextLayerId===id) S.selectedTextLayerId=null;
  renderTimeline();
  updateTextLayerOverlays(video.currentTime||0);
  renderTextLayerInspector();
  renderImageLayerInspector();
  toast('✕ Text layer removed');
}

function selectTextLayer(id){
  S.selectedTextLayerId = id;
  S.selectedImageLayerId = null; // mutually exclusive — the Text tab shows one editor at a time
  document.querySelectorAll('.tl-textlayer').forEach(el=>el.classList.toggle('selected', el.dataset.textId===id));
  switchInspTab('text');
  renderTextLayerInspector();
  renderImageLayerInspector();
  const layer = S.textLayers.find(l=>l.id===id);
  if(layer && video.src) video.currentTime = layer.start;
}

function _selectedTextLayer(){
  return S.textLayers.find(l=>l.id===S.selectedTextLayerId) || null;
}

function updateTextLayerContent(text){
  const layer = _selectedTextLayer();
  if(!layer) return;
  layer.text = text;
  renderTimeline();
  updateTextLayerOverlays(video.currentTime||0);
}

// ── Style setters for the selected layer — mirrors captions.js's setCaptionFont()
// /syncFontSize()/etc. pattern, just targeting the selected text layer's own
// style object instead of the shared S.textStyle. ──────────────────────────
function setTextLayerFont(v){
  const l=_selectedTextLayer(); if(!l) return;
  l.style.fontFamily=v; updateTextLayerOverlays(video.currentTime||0);
}
function setTextLayerWeight(w,btn){
  const l=_selectedTextLayer(); if(!l) return;
  l.style.fontWeight=String(w);
  document.querySelectorAll('#textLayerWeightRow .act-btn').forEach(b=>b.classList.remove('primary'));
  btn?.classList.add('primary');
  updateTextLayerOverlays(video.currentTime||0);
}
function syncTextLayerFontSize(src,v){
  const l=_selectedTextLayer(); if(!l) return;
  v=Math.max(6,parseInt(v)||32);
  l.style.fontSize=v;
  const slider=document.getElementById('textLayerFontSizeSlider'), input=document.getElementById('textLayerFontSizeInput');
  if(slider) slider.value=Math.min(v,200);
  if(input) input.value=v;
  updateTextLayerOverlays(video.currentTime||0);
}
function setTextLayerColor(v){
  const l=_selectedTextLayer(); if(!l) return;
  l.style.color=v; updateTextLayerOverlays(video.currentTime||0);
}
function toggleTextLayerStroke(){
  const l=_selectedTextLayer(); if(!l) return;
  l.style.strokeEnabled=!l.style.strokeEnabled;
  document.getElementById('textLayerStrokeToggleBtn').textContent=l.style.strokeEnabled?'ON':'OFF';
  document.getElementById('textLayerStrokeControls').style.display=l.style.strokeEnabled?'':'none';
  updateTextLayerOverlays(video.currentTime||0);
}
function syncTextLayerStroke(src,v){
  const l=_selectedTextLayer(); if(!l) return;
  v=Math.max(0,parseFloat(v)||0);
  l.style.strokeThickness=v;
  const slider=document.getElementById('textLayerStrokeSlider'), input=document.getElementById('textLayerStrokeInput');
  if(slider) slider.value=Math.min(v,20);
  if(input) input.value=v;
  updateTextLayerOverlays(video.currentTime||0);
}
function setTextLayerStrokeColor(v){
  const l=_selectedTextLayer(); if(!l) return;
  l.style.strokeColor=v; updateTextLayerOverlays(video.currentTime||0);
}
function syncTextLayerPos(axis,v){
  const l=_selectedTextLayer(); if(!l) return;
  v=parseFloat(v)||0;
  const key = axis==='x'?'posX':axis==='y'?'posY':'posZ';
  l.style[key]=v;
  const sfx = axis==='x'?'X':axis==='y'?'Y':'Z';
  const slider=document.getElementById('textLayerPos'+sfx), input=document.getElementById('textLayerPos'+sfx+'Input');
  if(slider) slider.value=v;
  if(input) input.value=v;
  updateTextLayerOverlays(video.currentTime||0);
}

// ── Preview overlay — one DOM element per text layer, reused across renders
// (unlike the single captionOverlay div, multiple text layers can be on
// screen at once, so this pool-manages a div per layer id). ────────────────
function updateTextLayerOverlays(srcTime){
  const container = document.getElementById('videoContainer');
  if(!container) return;
  const activeIds = new Set();
  S.textLayers.forEach(layer=>{
    if(srcTime < layer.start || srcTime > layer.end) return;
    activeIds.add(layer.id);
    let el = document.getElementById('textlayer-'+layer.id);
    if(!el){
      el = document.createElement('div');
      el.id = 'textlayer-'+layer.id;
      el.className = 'text-layer-overlay';
      // Label lives in its own span — el.textContent would wipe the resize
      // handle child every update, so only the span's text ever gets replaced.
      const span = document.createElement('span');
      span.className = 'tlo-text';
      el.appendChild(span);
      const handle = document.createElement('div');
      handle.className = 'layer-resize-handle';
      el.appendChild(handle);
      el.onclick = (e)=>{ e.stopPropagation(); selectTextLayer(layer.id); };
      _bindLayerOverlayDrag(el, layer.id, 'text');
      _bindLayerScaleHandle(handle, layer.id, 'text');
      container.appendChild(el);
    }
    const st = layer.style;
    el.querySelector('.tlo-text').textContent = layer.text;
    el.style.fontSize = st.fontSize+'px';
    el.style.fontFamily = st.fontFamily;
    el.style.fontWeight = st.fontWeight;
    el.style.color = st.color;
    el.style.background = st.background || 'transparent';
    el.style.webkitTextStroke = st.strokeEnabled && st.strokeThickness>0 ? `${st.strokeThickness}px ${st.strokeColor}` : '';
    el.style.left = st.posX+'%';
    el.style.top = st.posY+'%';
    el.style.transform = `translate(-50%,-50%) scale(${st.posZ})`;
    el.classList.toggle('selected', layer.id===S.selectedTextLayerId);
  });
  // Hide overlays for layers not active at this time; fully remove ones
  // whose layer no longer exists at all (deleted, or undone away) — avoids
  // an ever-growing set of orphaned hidden divs across add/delete/undo cycles.
  const allIds = new Set(S.textLayers.map(l=>l.id));
  container.querySelectorAll('.text-layer-overlay').forEach(el=>{
    const id = el.id.replace('textlayer-','');
    if(!allIds.has(id)){ el.remove(); return; }
    el.style.display = activeIds.has(id) ? 'block' : 'none';
  });
}

// ── Direct on-canvas manipulation — drag to move, corner handle to scale,
// magnetic snap-to-middle. Shared between text and image layers (kind:
// 'text'|'image') since the only difference is which S.*Layers array/setter
// they touch; the drag/snap math itself is identical. Always looks the
// layer up FRESH by id inside handlers rather than closing over the layer
// object — undo/redo replaces S.textLayers/S.imageLayers wholesale via a
// JSON round-trip, so a captured object reference would go stale (same id,
// different object) the moment the user undoes anything mid-session. ─────
function _layerKindAPI(kind){
  return kind==='text'
    ? { list:()=>S.textLayers, select:selectTextLayer, update:updateTextLayerOverlays, renderInsp:renderTextLayerInspector }
    : { list:()=>S.imageLayers, select:selectImageLayer, update:updateImageLayerOverlays, renderInsp:renderImageLayerInspector };
}

function _bindLayerOverlayDrag(el, layerId, kind){
  const api = _layerKindAPI(kind);
  const container = document.getElementById('videoContainer');
  let dragging=false, startX=0, startY=0, startPosX=0, startPosY=0, historySaved=false;

  el.addEventListener('pointerdown', e=>{
    if(e.button!==0 || e.target.classList.contains('layer-resize-handle')) return;
    e.stopPropagation();
    const l = api.list().find(x=>x.id===layerId); if(!l) return;
    api.select(layerId);
    dragging=true; historySaved=false;
    startX=e.clientX; startY=e.clientY;
    startPosX=l.style.posX; startPosY=l.style.posY;
    el.setPointerCapture(e.pointerId);
  });

  el.addEventListener('pointermove', e=>{
    if(!dragging) return;
    const l = api.list().find(x=>x.id===layerId); if(!l) return;
    if(!historySaved){ saveHistory(); historySaved=true; }
    const rect = container.getBoundingClientRect();
    let x = startPosX + (e.clientX-startX)/rect.width*100;
    let y = startPosY + (e.clientY-startY)/rect.height*100;
    x = Math.max(0, Math.min(100, x));
    y = Math.max(0, Math.min(100, y));
    const snapped = _applyLayerSnap(x, y, e.altKey);
    l.style.posX = snapped.x; l.style.posY = snapped.y;
    api.update(video.currentTime||0);
    api.renderInsp();
  });

  el.addEventListener('pointerup', e=>{
    if(!dragging) return;
    dragging=false;
    _hideLayerGuides();
    el.releasePointerCapture(e.pointerId);
  });
}

function _bindLayerScaleHandle(handle, layerId, kind){
  const api = _layerKindAPI(kind);
  let dragging=false, startDist=1, startPosZ=1, historySaved=false;

  handle.addEventListener('pointerdown', e=>{
    if(e.button!==0) return;
    e.stopPropagation();
    const l = api.list().find(x=>x.id===layerId); if(!l) return;
    dragging=true; historySaved=false;
    const rect = handle.parentElement.getBoundingClientRect();
    const cx=rect.left+rect.width/2, cy=rect.top+rect.height/2;
    startDist = Math.hypot(e.clientX-cx, e.clientY-cy) || 1;
    startPosZ = l.style.posZ;
    handle.setPointerCapture(e.pointerId);
  });

  handle.addEventListener('pointermove', e=>{
    if(!dragging) return;
    const l = api.list().find(x=>x.id===layerId); if(!l) return;
    if(!historySaved){ saveHistory(); historySaved=true; }
    const rect = handle.parentElement.getBoundingClientRect();
    const cx=rect.left+rect.width/2, cy=rect.top+rect.height/2;
    const dist = Math.hypot(e.clientX-cx, e.clientY-cy) || 1;
    let scale = startPosZ * (dist/startDist);
    scale = Math.max(0.2, Math.min(5, Math.round(scale*100)/100));
    l.style.posZ = scale;
    api.update(video.currentTime||0);
    api.renderInsp();
  });

  handle.addEventListener('pointerup', e=>{
    dragging=false;
    handle.releasePointerCapture(e.pointerId);
  });
}

// Magnetic snap — pulls to 0/50/100 (edge/middle/edge) on each axis
// independently within a small threshold, like a magnet rather than a hard
// grid: close to the middle, it grabs; anywhere else, it leaves the value
// alone. Holding Alt bypasses it entirely for fully free placement.
function _applyLayerSnap(x, y, altKey){
  if(altKey){ _hideLayerGuides(); return {x,y}; }
  const T = 3; // percentage-point magnet radius
  const targets = [0,50,100];
  let sx=x, sy=y, snappedX=null, snappedY=null;
  for(const t of targets){ if(Math.abs(x-t)<=T){ sx=t; snappedX=t; break; } }
  for(const t of targets){ if(Math.abs(y-t)<=T){ sy=t; snappedY=t; break; } }
  _showLayerGuides(snappedX, snappedY);
  return {x:sx, y:sy};
}

function _showLayerGuides(xPct, yPct){
  const gv=document.getElementById('layerGuideV'), gh=document.getElementById('layerGuideH');
  if(gv) gv.style.display = xPct===null ? 'none' : 'block';
  if(gv && xPct!==null) gv.style.left = xPct+'%';
  if(gh) gh.style.display = yPct===null ? 'none' : 'block';
  if(gh && yPct!==null) gh.style.top = yPct+'%';
}

function _hideLayerGuides(){
  const gv=document.getElementById('layerGuideV'), gh=document.getElementById('layerGuideH');
  if(gv) gv.style.display='none';
  if(gh) gh.style.display='none';
}

// ── Inspector panel sync ────────────────────────────────────────────────
// Shared empty-state block (both text and image layer editors live in the
// same "Text" inspector tab) — visible only when neither kind is selected.
function _updateLayersEmptyState(){
  const empty = document.getElementById('textLayerEmpty');
  if(!empty) return;
  empty.style.display = (_selectedTextLayer() || _selectedImageLayer()) ? 'none' : '';
}

function renderTextLayerInspector(){
  const editor = document.getElementById('textLayerEditor');
  const layer = _selectedTextLayer();
  _updateLayersEmptyState();
  if(!layer){
    if(editor) editor.style.display='none';
    return;
  }
  if(editor) editor.style.display='';

  const set=(id,val)=>{const el=document.getElementById(id); if(el) el.value=val;};
  document.getElementById('textLayerContent').value = layer.text;
  document.getElementById('textLayerStart').textContent = fmt(layer.start);
  document.getElementById('textLayerEnd').textContent = fmt(layer.end);

  const st = layer.style;
  set('textLayerFontSelect', st.fontFamily);
  set('textLayerFontSizeSlider', Math.min(st.fontSize,200));
  set('textLayerFontSizeInput', st.fontSize);
  set('textLayerColorInput', st.color);
  set('textLayerStrokeSlider', Math.min(st.strokeThickness,20));
  set('textLayerStrokeInput', st.strokeThickness);
  set('textLayerStrokeColorInput', st.strokeColor);
  set('textLayerPosX', st.posX); set('textLayerPosXInput', st.posX);
  set('textLayerPosY', st.posY); set('textLayerPosYInput', st.posY);
  set('textLayerPosZ', st.posZ); set('textLayerPosZInput', st.posZ);

  const strokeBtn = document.getElementById('textLayerStrokeToggleBtn');
  if(strokeBtn) strokeBtn.textContent = st.strokeEnabled ? 'ON' : 'OFF';
  const strokeControls = document.getElementById('textLayerStrokeControls');
  if(strokeControls) strokeControls.style.display = st.strokeEnabled ? '' : 'none';

  document.querySelectorAll('#textLayerWeightRow .act-btn').forEach(b=>b.classList.remove('primary'));
  const weightBtn = document.getElementById('textLayerWeight'+st.fontWeight);
  weightBtn?.classList.add('primary');
}
