// ═══════════════════════════════════════
// TEXT LAYERS — "Add Text" (freeform text objects, independent of captions)
// ═══════════════════════════════════════
// Data model: S.textLayers[] = {id, text, start, end (source time), style}.
// style is the same shape as S.textStyle but per-object — each text layer
// carries its own font/size/color/position instead of sharing one global
// style the way captions do, since these are meant to be independent
// on-screen objects (title card, callout, etc.), not one running transcript.
//
// v1 scope: position via numeric X/Y/Z sliders in the Text inspector tab
// (same pattern captions already use), not drag-in-preview — that's a
// separate, not-yet-built feature (see CLAUDE.md Pending Features).

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
      el.onclick = (e)=>{ e.stopPropagation(); selectTextLayer(layer.id); };
      container.appendChild(el);
    }
    const st = layer.style;
    el.textContent = layer.text;
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
