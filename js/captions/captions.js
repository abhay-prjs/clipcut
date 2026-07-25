// ═══════════════════════════════════════
// CAPTIONS
// ═══════════════════════════════════════

// FPS used for frame-snapping caption timestamps. CapCut and most editors floor/ceil
// to frame boundaries — two timestamps that differ by <1 frame become a visible gap.
// Snapping both sides of adjacent blocks to the same frame eliminates that gap.
let _captionFps = 30;

function _snapToFrame(s, fps) {
  fps = fps != null ? fps : _captionFps;
  if (fps <= 0) return s;
  return Math.round(s * fps) / fps;
}

// Chunk flat word list into subtitle blocks. Closes a block on .!? or when
// maxWords is hit. Uses rawText for boundary detection so strip-punctuation
// mode doesn't break sentence splitting.
function _chunkWordsByPunct(words, maxWords) {
  const chunks = [], current = [];
  for (const w of words) {
    current.push(w);
    const last = (w.rawText || w.text || '').slice(-1);
    if (last === '.' || last === '!' || last === '?' || current.length >= maxWords) {
      chunks.push(current.slice());
      current.length = 0;
    }
  }
  if (current.length) chunks.push(current.slice());
  return chunks;
}

function buildDemoCaptions(dur){
  const lines=["Welcome back to the channel!","Today's content is gonna be crazy.","I literally couldn't believe this worked.","Step one — let me break it down for you.","No cap this is the best one yet.","Make sure you stick around till the end.","Drop a comment if this helped you out.","Like and subscribe for more content!"];
  const seg=dur/Math.min(lines.length,Math.ceil(dur/3));
  S.captions=lines.slice(0,Math.ceil(dur/seg)).map((text,i)=>({id:i,text,start:i*seg,end:(i+1)*seg-.15}));
  updateCaptionList(); renderTimeline();
}

function updateCaptionList(){
  renderTranscriptEditor();
}

// ── Transcript Editor ────────────────────────────────────────────────────────
let _txWords        = null;   // cached NodeList of .word-span elements
let _lastActiveEl   = null;   // span currently carrying word-active
let _txSelStart     = null;   // timestamp of selection start
let _txSelEnd       = null;   // timestamp of selection end
let _txSelText      = '';     // text content of selection
let _txListenerBound = false;

function renderTranscriptEditor() {
  const el = document.getElementById('transcriptEditor');
  if (!el) return;
  _txWords = null;
  _lastActiveEl = null;

  if (!S.captions.length) {
    el.innerHTML = '<div class="empty-state" style="padding:18px 10px">No transcript yet<br>'
      + '<button class="act-btn ai" style="margin-top:10px;width:auto;padding:4px 14px" '
      + 'onclick="transcribeWithWhisper()">✦ Transcribe</button></div>';
    return;
  }

  el.innerHTML = S.captions.map(c =>
    `<span class="word-span" data-id="${c.id}" data-start="${c.start}" data-end="${c.end}">${_escTx(c.text)}</span>`
  ).join(' ');

  _txWords = el.querySelectorAll('.word-span');

  // Click-to-seek — only fires when no text is being selected and not mid-edit
  _txWords.forEach(span => {
    span.addEventListener('click', () => {
      if (span.isContentEditable) return;
      if (window.getSelection().toString().length > 0) return;
      const t = parseFloat(span.dataset.start);
      if (!isNaN(t) && video.src) video.currentTime = t;
    });
    span.addEventListener('dblclick', e => {
      e.stopPropagation();
      _startEditWord(span);
    });
  });

  _applyWordCuts();
  _setupTxSelection();
}

function _escTx(s) {
  return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

// Called from the rVFC loop — never does querySelector
function updateTranscriptHighlight(t) {
  if (!_txWords) return;
  if (_lastActiveEl) { _lastActiveEl.classList.remove('word-active'); _lastActiveEl = null; }
  for (let i = 0; i < _txWords.length; i++) {
    const w = _txWords[i];
    if (t >= parseFloat(w.dataset.start) && t <= parseFloat(w.dataset.end)) {
      w.classList.add('word-active');
      _lastActiveEl = w;
      break;
    }
  }
}

let _txSuggestionsOn = false;

function toggleTxSuggestions() {
  _txSuggestionsOn = !_txSuggestionsOn;
  const btn = document.getElementById('txSuggestBtn');
  if (btn) {
    btn.classList.toggle('act', _txSuggestionsOn);
    btn.style.opacity = _txSuggestionsOn ? '1' : '0.5';
  }
  _applyWordCuts();
}

// Marks spans whose time range overlaps a selected cut — only when suggestions are visible
function _applyWordCuts() {
  if (!_txWords) return;
  _txWords.forEach(span => {
    if (!_txSuggestionsOn) { span.classList.remove('word-cut'); return; }
    const ws = parseFloat(span.dataset.start);
    const we = parseFloat(span.dataset.end);
    const wmid = (ws + we) / 2;
    span.classList.toggle('word-cut', S.cuts.some(c => c.selected && c.skipEnabled !== false && c.scriptPart !== true && c.start < wmid && c.end > wmid));
  });
}

function _setupTxSelection() {
  if (_txListenerBound) return;
  _txListenerBound = true;

  document.addEventListener('mouseup', _onTxMouseUp);

  // Hide toolbar when clicking outside editor + toolbar
  document.addEventListener('mousedown', e => {
    const tb = document.getElementById('transcriptToolbar');
    if (!tb || tb.contains(e.target)) return;
    if (e.target.closest('#transcriptEditor') === null) _hideTxToolbar();
  });
}

// Double-click a caption span to fix a mis-transcribed word/phrase in place.
// Enter or blur commits; Escape reverts. Edits S.captions[].text directly —
// the timeline caption track and export both read from that same array.
function _startEditWord(span) {
  if (span.isContentEditable) return;
  _hideTxToolbar();
  const cap = S.captions.find(c => String(c.id) === span.dataset.id);
  if (!cap) return;
  const originalText = cap.text;

  span.contentEditable = 'true';
  span.classList.add('word-editing');
  span.focus();
  document.execCommand('selectAll', false, null);

  const finish = commit => {
    span.contentEditable = 'false';
    span.classList.remove('word-editing');
    span.removeEventListener('blur', onBlur);
    span.removeEventListener('keydown', onKeydown);
    if (commit) {
      const newText = span.textContent.trim();
      if (newText && newText !== originalText) {
        saveHistory(); // snapshot pre-edit state only when something actually changed
        cap.text = newText;
        span.textContent = newText;
        renderTimeline();
        toast('✓ Caption updated');
      } else {
        span.textContent = originalText; // unchanged or blanked out — revert
      }
    } else {
      span.textContent = originalText; // Escape — revert
    }
  };
  const onBlur = () => finish(true);
  const onKeydown = e => {
    if (e.key === 'Enter') { e.preventDefault(); span.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  span.addEventListener('blur', onBlur);
  span.addEventListener('keydown', onKeydown);
}

function _onTxMouseUp() {
  if (document.activeElement && document.activeElement.isContentEditable) return;
  const editor = document.getElementById('transcriptEditor');
  if (!editor || !_txWords) return;
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || sel.toString().trim() === '') return;
  if (!editor.contains(sel.anchorNode)) return;

  const range = sel.getRangeAt(0);
  let minStart = Infinity, maxEnd = -Infinity, parts = [];

  _txWords.forEach(span => {
    // Compare the span's text node character positions against the range.
    // containsNode(span, true) has a known partial-containment false-positive with
    // adjacent text nodes (spaces between spans) — comparePoint on the text node itself
    // gives character-level precision and avoids those false positives.
    const tn = span.firstChild;
    if (!tn || tn.nodeType !== Node.TEXT_NODE) return;
    const posStart = range.comparePoint(tn, 0);           // -1 before, 0 inside, 1 after range
    const posEnd   = range.comparePoint(tn, tn.length);
    // Span overlaps range unless it's entirely after (posStart===1) or entirely before (posEnd===-1)
    const selected = posStart !== 1 && posEnd !== -1;

    if (selected) {
      const ws = parseFloat(span.dataset.start);
      const we = parseFloat(span.dataset.end);
      if (ws < minStart) minStart = ws;
      if (we > maxEnd)   maxEnd   = we;
      parts.push(span.textContent);
      span.classList.add('word-selected');
    } else {
      span.classList.remove('word-selected');
    }
  });

  if (minStart === Infinity) return;
  _txSelStart = minStart;
  _txSelEnd   = maxEnd;
  _txSelText  = parts.join(' ');

  // Position toolbar centred above the selection rect
  const rect = range.getBoundingClientRect();
  const tb   = document.getElementById('transcriptToolbar');
  if (!tb) return;
  const tbW = 150;
  tb.style.left = `${Math.max(4, rect.left + rect.width / 2 - tbW / 2)}px`;
  tb.style.top  = `${rect.top + window.scrollY - 44}px`;
  tb.classList.add('visible');
}

function _hideTxToolbar() {
  const tb = document.getElementById('transcriptToolbar');
  if (tb) tb.classList.remove('visible');
  _txSelStart = _txSelEnd = null;
  _txSelText  = '';
  if (_txWords) _txWords.forEach(w => w.classList.remove('word-selected'));
  window.getSelection()?.removeAllRanges();
}

function _txCut() {
  if (_txSelStart === null || _txSelEnd === null) return;
  const dur = _txSelEnd - _txSelStart;
  saveHistory();
  S.cuts.push({
    id: crypto.randomUUID(),
    start: _txSelStart,
    end: _txSelEnd,
    type: 'retake',
    text: _txSelText,
    aiNote: 'text selection',
    selected: true,
    skipEnabled: true,
    scriptPart: false
  });
  renderAllFindings();   // also calls _applyWordCuts via silence.js hook
  buildPlaySegments();
  renderTimeline();
  _hideTxToolbar();
  toast(`✕ Cut added — ${fmt(dur)}`);
}

function _txUncut() {
  if (_txSelStart === null || _txSelEnd === null) return;
  const before = S.cuts.length;
  saveHistory();
  S.cuts = S.cuts.filter(c => !(c.start < _txSelEnd && c.end > _txSelStart));
  const removed = before - S.cuts.length;
  if (!removed) { toast('No cuts overlap that selection'); return; }
  renderAllFindings();
  buildPlaySegments();
  renderTimeline();
  _hideTxToolbar();
  toast(`⊘ Removed ${removed} cut${removed !== 1 ? 's' : ''}`);
}

function _txJump() {
  if (_txSelStart !== null && video.src) video.currentTime = _txSelStart;
  _hideTxToolbar();
}

function _onTranscriptSearch(q) {
  if (!_txWords) return;
  const query = q.trim().toLowerCase();
  let firstHit = null;
  _txWords.forEach(span => {
    const hit = query && span.textContent.toLowerCase().includes(query);
    span.classList.toggle('word-search-hit', hit);
    if (hit && !firstHit) firstHit = span;
  });
  if (firstHit && video.src) {
    video.currentTime = parseFloat(firstHit.dataset.start);
    firstHit.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }
}

function deleteCaption(id){saveHistory();S.captions=S.captions.filter(c=>c.id!==id);updateCaptionList();renderTimeline();}
function seekTo(t){if(!video.src)return;video.currentTime=t;}

function exportCaptions(fmt) {
  if(!S.captions.length){ toast('No captions to export'); return; }

  // Map a source timestamp to the post-cut timeline position.
  // Returns null if the timestamp falls inside a removed cut region.
  const segs = S.segments.length
    ? S.segments
    : [{sourceStart:0, sourceEnd:S.duration, timelineStart:0}];

  function srcToTl(t) {
    for(const seg of segs){
      if(t >= seg.sourceStart && t <= seg.sourceEnd)
        return seg.timelineStart + (t - seg.sourceStart);
    }
    return null;
  }

  function pad(n, len){ return String(n).padStart(len, '0'); }

  function fmtTime(s, vtt) {
    s = _snapToFrame(s);               // snap to frame boundary before writing
    const totalMs = Math.round(s * 1000); // integer ms — avoids float millis-rollover
    const ms      = totalMs % 1000;
    const totalS  = Math.floor(totalMs / 1000);
    const secs    = totalS % 60;
    const totalM  = Math.floor(totalS / 60);
    const minutes = totalM % 60;
    const hours   = Math.floor(totalM / 60);
    const sep     = vtt ? '.' : ',';
    return `${pad(hours,2)}:${pad(minutes,2)}:${pad(secs,2)}${sep}${pad(ms,3)}`;
  }

  const isSRT = fmt === 'srt';
  const lines = isSRT ? [] : ['WEBVTT', ''];
  let idx = 1;

  for(const cap of S.captions){
    const ts = srcToTl(cap.start);
    if(ts === null) continue; // caption sits inside a cut — skip
    let te = srcToTl(cap.end);
    if(te === null) te = ts + (cap.end - cap.start); // end clipped — use original duration
    te = Math.max(te, ts + 0.001); // safety: end must be after start

    if(isSRT) lines.push(String(idx));
    lines.push(`${fmtTime(ts, !isSRT)} --> ${fmtTime(te, !isSRT)}`);
    lines.push(cap.text);
    lines.push('');
    idx++;
  }

  if(idx === 1){ toast('All captions fall in cut regions — nothing to export'); return; }

  const content  = lines.join('\n');
  const filename = (S.current?.name || 'export').replace(/\.[^.]+$/, '') + '.' + fmt;
  const blob     = new Blob([content], {type: 'text/plain'});
  const a        = document.createElement('a');
  a.href         = URL.createObjectURL(blob);
  a.download     = filename;
  a.click();
  URL.revokeObjectURL(a.href);
  toast(`✓ ${fmt.toUpperCase()} exported — ${idx - 1} captions`);
}

function addManualCaption(){
  const text=prompt('Caption text:');
  if(!text)return;
  saveHistory();
  const t=video.currentTime;
  S.captions.push({id:Date.now(),text,start:t,end:t+3});
  updateCaptionList(); renderTimeline();
}

function formatCaptionText(text){
  const words=text.split(' ');
  if(S.captionLayout==='stack'){
    const mid=Math.ceil(words.length/2);
    return words.slice(0,mid).join(' ')+'<br>'+words.slice(mid).join(' ');
  }
  if(S.captionLayout==='grid') return words.join('<br>');
  return text;
}

function updateCaptionOverlay(){
  const t=video.currentTime;
  const c=S.captions.find(x=>t>=x.start&&t<=x.end);
  const el=document.getElementById('captionOverlay');
  if(c){
    el.innerHTML=formatCaptionText(c.text);
    el.style.lineHeight=S.captionLayout==='grid'?'1.2':'';
    el.classList.add('on');
  } else {
    el.classList.remove('on');
  }
}

function syncFontSize(src,v){
  v=Math.max(8,parseInt(v)||15);
  document.getElementById('fontSizeSlider').value=Math.min(v,120);
  document.getElementById('fontSizeInput').value=v;
  document.getElementById('captionOverlay').style.fontSize=v+'px';
}

function setCaptionStyle(style){
  S.captionStyle=style;
  ['styleUGC','styleWord','stylePhrase'].forEach(id=>document.getElementById(id)?.classList.remove('primary'));
  const map={ugc:'styleUGC',word:'styleWord',phrase:'stylePhrase'};
  document.getElementById(map[style])?.classList.add('primary');
}

function setCaptionLayout(layout,btn){
  S.captionLayout=layout;
  ['layoutSingle','layoutStack','layoutGrid'].forEach(id=>document.getElementById(id).classList.remove('primary'));
  btn.classList.add('primary');
}

function setCaptionSize(v){document.getElementById('captionOverlay').style.fontSize=v+'px';}
function setCaptionBg(v){document.getElementById('captionOverlay').style.background=v;}

// Legacy stub — old dropdown used bottom % strings like "14%"
function setCaptionPos(v){
  const pct=parseFloat(v)||14;
  document.getElementById('captionPosY').value=pct;
  document.getElementById('captionPosYInput').value=pct;
  _applyCaptionTransform();
}

function syncCaptionPos(axis, val){
  val=parseFloat(val)||0;
  const overlay=document.getElementById('captionOverlay');
  if(axis==='x'){
    val=Math.max(-50,Math.min(150,val));
    document.getElementById('captionPosX').value=Math.max(0,Math.min(100,val));
    document.getElementById('captionPosXInput').value=val;
  } else if(axis==='y'){
    val=Math.max(0,Math.min(100,val));
    document.getElementById('captionPosY').value=val;
    document.getElementById('captionPosYInput').value=val;
  } else if(axis==='z'){
    val=Math.max(0.1,Math.min(10,val));
    document.getElementById('captionPosZ').value=Math.min(val,3);
    document.getElementById('captionPosZInput').value=val;
  }
  _applyCaptionTransform();
}

function _applyCaptionTransform(){
  const x=parseFloat(document.getElementById('captionPosXInput')?.value??50);
  const y=parseFloat(document.getElementById('captionPosYInput')?.value??14);
  const z=parseFloat(document.getElementById('captionPosZInput')?.value??1);
  const overlay=document.getElementById('captionOverlay');
  overlay.style.left=x+'%';
  overlay.style.bottom=y+'%';
  overlay.style.transform=`translateX(-50%) scale(${z})`;
}
function updateWPCDisplay(){document.getElementById('wpcDisplay').textContent=S.wordsPerCap;}
function toggleStripPunct(){
  S.stripPunct=!S.stripPunct;
  const btn=document.getElementById('stripPunctBtn');
  btn.textContent=S.stripPunct?'ON':'OFF';
  btn.classList.toggle('primary',S.stripPunct);
}
function setCaptionWeight(w,btn){
  document.getElementById('captionOverlay').style.fontWeight=w;
  btn.closest('div').querySelectorAll('button').forEach(b=>b.classList.remove('primary'));
  btn.classList.add('primary');
}

function toggleStroke(){
  const btn=document.getElementById('strokeToggleBtn');
  const controls=document.getElementById('strokeControls');
  const on=btn.textContent==='OFF';
  btn.textContent=on?'ON':'OFF';
  btn.classList.toggle('primary',on);
  controls.style.display=on?'block':'none';
  if(on) applyStroke(); else document.getElementById('captionOverlay').style.webkitTextStroke='';
}

function syncStrokeThickness(src, val){
  val=Math.max(0,parseFloat(val)||0);
  const slider=document.getElementById('strokeThickness');
  const input=document.getElementById('strokeThickInput');
  if(src==='slider'){ input.value=val; }
  else { slider.value=Math.min(val,20); }
  applyStroke();
}

function applyStroke(){
  const t=parseFloat(document.getElementById('strokeThickInput')?.value||document.getElementById('strokeThickness').value)||0;
  const c=document.getElementById('strokeColor').value;
  document.getElementById('captionOverlay').style.webkitTextStroke=t>0?`${t}px ${c}`:'';
}

async function loadCustomFont(file){
  const url=URL.createObjectURL(file);
  const fontName=file.name.split('.')[0];
  try{
    const font=new FontFace(fontName,`url(${url})`);
    await font.load();
    document.fonts.add(font);
    const opt=document.createElement('option');
    opt.value=fontName;
    opt.textContent=fontName+' (custom)';
    const sel=document.getElementById('fontSelect');
    sel.appendChild(opt);
    sel.value=fontName;
    document.getElementById('captionOverlay').style.fontFamily=fontName;
    toast(`✓ Font loaded: ${fontName}`);
  } catch(e){
    toast(`✕ Font load failed: ${e.message}`);
  }
}
