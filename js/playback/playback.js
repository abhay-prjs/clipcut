// ═══════════════════════════════════════
// PLAYBACK
// ═══════════════════════════════════════
// Tracks the Promise returned by video.play() so pause() can be safely chained.
// Calling video.pause() while a play() Promise is still pending throws AbortError.
let _playPromise = null;

const _ICON_PLAY  = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff" style="margin-left:2px"><path d="M8 5v14l11-7z"/></svg>';
const _ICON_PAUSE = '<svg width="16" height="16" viewBox="0 0 24 24" fill="#fff"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
function _setPlayIcon(isPlaying){
  const btn=document.getElementById('playBtn');
  if(btn) btn.innerHTML = isPlaying ? _ICON_PAUSE : _ICON_PLAY;
}

function _playVideo() {
  _playPromise = video.play();
  S.playing = true;
  _setPlayIcon(true);
  if (_playPromise !== undefined) {
    _playPromise.then(() => {
      _playPromise = null;
    }).catch(() => {
      // play() was aborted (e.g. rapid toggle) — sync UI to actual video state
      _playPromise = null;
      if (video.paused) {
        S.playing = false;
        _setPlayIcon(false);
      }
    });
  }
}

function _pauseVideo() {
  S.playing = false;
  _setPlayIcon(false);
  if (_playPromise !== null) {
    // Chain pause after the pending play resolves to avoid AbortError
    _playPromise.then(() => video.pause()).catch(() => {});
    _playPromise = null;
  } else {
    video.pause();
  }
}

function togglePlay() {
  if(!S.current){toast('No clip loaded');return;}
  if(S.playing){
    _pauseVideo();
  } else {
    if(S.proxyActive){
      // Proxy is already gapless — no S.playSegments lookup needed, just
      // restart from 0 if past the end (proxy-space, not source-space).
      if(video.currentTime >= (video.duration||0) - 0.03) video.currentTime = 0;
      _playVideo();
      return;
    }
    const firstStart = S.playSegments.length ? S.playSegments[0].start : (S.trimIn||0);
    if(video.currentTime >= (S.trimOut||S.duration)){
      // Past end — restart from first segment
      video.currentTime = firstStart;
    } else if(video.currentTime < firstStart){
      // Before first segment (e.g. in an applied cut gap) — jump to it
      video.currentTime = firstStart;
    }
    _playVideo();
  }
}

function skipTime(d){
  if(!video.src)return;
  if(S.proxyActive){
    // Proxy has no gaps to route around — plain clamp within the file.
    video.currentTime = clamp(video.currentTime+d, 0, video.duration||99999);
    return;
  }
  let target=clamp(video.currentTime+d,S.trimIn,S.trimOut||S.duration);
  if(S.playSegments && S.playSegments.length){
    const inSeg=S.playSegments.some(s=>target>=s.start&&target<=s.end);
    if(!inSeg){
      if(d>=0){
        const next=S.playSegments.find(s=>s.start>target);
        target=next?next.start:S.playSegments[S.playSegments.length-1].end;
      } else {
        const prevSegs=S.playSegments.filter(s=>s.end<target);
        target=prevSegs.length?prevSegs[prevSegs.length-1].end:S.playSegments[0].start;
      }
    }
  }
  video.currentTime=target;
}
function setSpeed(v){video.playbackRate=parseFloat(v);document.getElementById('speedSelect').value=v;}
const _ICON_VOL_MUTE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M17 9l5 6M22 9l-5 6" stroke-linecap="round"/></svg>';
const _ICON_VOL_LOW  = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16.5 10a3 3 0 0 1 0 4" stroke-linecap="round"/></svg>';
const _ICON_VOL_HIGH = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4 9v6h4l5 5V4L8 9H4z"/><path d="M16.5 8.5a5 5 0 0 1 0 7" stroke-linecap="round"/></svg>';
function setVolume(v){video.volume=v;document.getElementById('volIcon').innerHTML=v==0?_ICON_VOL_MUTE:v<.5?_ICON_VOL_LOW:_ICON_VOL_HIGH;}

// ── Playback frame loop ───────────────────────────────────────────────────────
// Uses requestVideoFrameCallback (rVFC) when available — fires on every rendered
// video frame, perfectly synced to display rate. Falls back to timeupdate.
let _rVFCHandle = null;

function _stopRVFC() {
  if (_rVFCHandle !== null) {
    video.cancelVideoFrameCallback(_rVFCHandle);
    _rVFCHandle = null;
  }
}

function _startRVFC() {
  _stopRVFC();
  _rVFCHandle = video.requestVideoFrameCallback(_onVideoFrame);
}

// Guards against seek-storm double-jumps: between assigning video.currentTime
// and video.seeking actually flipping true, 1-2 rVFC callbacks can still fire
// with the stale pre-seek mediaTime. Track the pending target and ignore
// frames until mediaTime has caught up to it.
let _seekTarget = null, _seekTargetSetAt = 0;
function _jumpTo(t){ _seekTarget = t; _seekTargetSetAt = performance.now(); video.currentTime = t; }

// Segment-boundary jump threshold, scaled to the real source fps. At 24fps a
// frame is 0.042s — a fixed 0.05s threshold sometimes includes and sometimes
// drops the last frame of a segment depending on frame phase, reading as
// inconsistent cut timing. One full frame (or 0.05s, whichever is larger)
// keeps the boundary check aligned to actual frame boundaries.
function _boundaryThresh(){ return Math.max(0.05, 1/(S.fps||30)); }

// ═══════════════════════════════════════
// PREVIEW PROXY (Part A3 Option 3) — background-rendered gapless concat of
// kept segments, swapped into video.src for perfectly gapless scrub-anywhere
// playback. While active, video.currentTime is in PROXY space (the rendered
// file's own timeline, always gapless — the same layout gaplessSegmentMeta()
// already computes for export), not source-file space, so anything reading
// video.currentTime elsewhere needs the source-time mapping below rather than
// using it directly.
// ═══════════════════════════════════════

// source time <-> proxy time, via the same gapless cursor layout export uses.
function _sourceToProxyTime(srcTime){
  const meta = gaplessSegmentMeta();
  for(const seg of meta){
    if(srcTime >= seg.sourceStart && srcTime <= seg.sourceEnd)
      return seg.timelineStart + (srcTime - seg.sourceStart);
  }
  return null;
}
function _proxyToSourceTime(proxyTime){
  const meta = gaplessSegmentMeta();
  if(!meta.length) return proxyTime;
  for(const seg of meta){
    const segEndTl = seg.timelineStart + (seg.sourceEnd - seg.sourceStart);
    if(proxyTime >= seg.timelineStart && proxyTime <= segEndTl)
      return seg.sourceStart + (proxyTime - seg.timelineStart);
  }
  const last = meta[meta.length - 1];
  return proxyTime < meta[0].timelineStart ? meta[0].sourceStart : last.sourceEnd;
}

function _updateProxyBtn(){
  const btn = document.getElementById('proxyBtn');
  const label = document.getElementById('proxyBtnLabel');
  if(!btn || !label) return;
  if(S.proxyActive){
    label.textContent = 'PROXY';
    btn.classList.add('act');
    btn.title = 'Playing the rendered gapless proxy — click to switch back to live editing playback';
  } else {
    label.textContent = (S.proxyUrl && !S.proxyDirty) ? 'LIVE ●' : 'LIVE';
    btn.classList.remove('act');
    btn.title = S.proxyUrl
      ? (S.proxyDirty ? 'Proxy is stale (segments/cuts changed) — click to re-render' : 'Click to switch to the rendered gapless proxy')
      : 'Render a gapless preview proxy for smooth scrubbing';
  }
}

// Swap into the rendered proxy, preserving playhead position (mapped from
// source time into the proxy's own gapless time).
function _enterProxyMode(){
  if(!S.proxyUrl) return;
  const proxyTime = _sourceToProxyTime(video.currentTime) ?? 0;
  _stopRVFC();
  _pauseVideo();
  S.proxyActive = true;
  video.onerror = null;
  video.src = S.proxyUrl;
  video.onloadedmetadata = () => { video.currentTime = Math.max(0, proxyTime); };
  _updateProxyBtn();
}

// Swap back to the live source file, mapping the proxy's playhead back to a
// source timestamp so the position is preserved across the switch.
function _exitProxyMode(){
  if(!S.current) return;
  const srcTime = _proxyToSourceTime(video.currentTime) ?? (S.trimIn||0);
  _stopRVFC();
  _pauseVideo();
  S.proxyActive = false;
  video.onerror = null;
  video.src = S.current.url;
  video.onloadedmetadata = () => { video.currentTime = Math.max(0, srcTime); };
  _updateProxyBtn();
}

function toggleProxyMode(){
  if(!S.current){ toast('Load a video first'); return; }
  if(S.proxyActive){ _exitProxyMode(); return; }
  if(S.proxyUrl && !S.proxyDirty){ _enterProxyMode(); return; }
  renderPreviewProxy();
}

// Called by Python via evaluate_js() during the proxy render
function _onProxyProgress(pct){
  const label = document.getElementById('proxyBtnLabel');
  if(label) label.textContent = `⏳${Math.round(pct)}%`;
}

async function renderPreviewProxy(){
  if(!S.current?.sourcePath){ toast('Preview proxy needs a real file path — reload via 📂 Open File, not drag-drop'); return; }
  if(!window.pywebview){ toast('Preview proxy requires the desktop app'); return; }
  if(!S.segments.length){ toast('Nothing to render yet'); return; }

  const btn = document.getElementById('proxyBtn');
  if(btn) btn.disabled = true;
  _onProxyProgress(0);
  toast('⚡ Rendering preview proxy...');

  // Same shape as export's fast path — kept segments only, in source time.
  const segs = S.segments.map(s => ({start: s.sourceStart, end: s.sourceEnd}));

  try{
    const result = await window.pywebview.api.render_preview_proxy(S.current.sourcePath, JSON.stringify(segs));
    if(!result || !result.success){
      toast(`✕ Proxy render failed: ${result?.error || 'unknown error'}`);
      return;
    }
    S.proxyUrl = `${window.location.origin}/video?path=${encodeURIComponent(result.path)}`;
    S.proxyDirty = false;
    _enterProxyMode();
    toast('✓ Preview proxy ready — gapless scrubbing enabled');
  } catch(e){
    toast(`✕ Proxy render failed: ${e.message}`);
  } finally {
    if(btn) btn.disabled = false;
    _updateProxyBtn();
  }
}

function _onVideoFrame(now, metadata) {
  // Re-register first so the loop continues without gaps
  _rVFCHandle = video.requestVideoFrameCallback(_onVideoFrame);

  const t = metadata.mediaTime;

  // While seeking (programmatic or user scrub) skip all jump logic to prevent oscillation
  if(video.seeking) return;

  // Proxy is a gapless concat of kept segments already — no boundary/skip
  // logic needed at all, just loop-region + trim-out + UI sync, mapped back
  // to source time for everything that reads S.captions/S.segments (which
  // are keyed by source time, not proxy time).
  if(S.proxyActive){
    const srcTime = _proxyToSourceTime(t);
    if(S.looping && S.loopA !== null && S.loopB !== null){
      const loopBProxy = _sourceToProxyTime(S.loopB);
      if(loopBProxy !== null && t >= loopBProxy){ _jumpTo(_sourceToProxyTime(S.loopA) ?? 0); return; }
    }
    if(video.duration && t >= video.duration - 0.03 && S.playing){ _pauseVideo(); }
    updateTimecode(srcTime);
    updatePlayhead(srcTime);
    updateCaptionOverlay(srcTime);
    updateTextLayerOverlays(srcTime);
    updateImageLayerOverlays(srcTime);
    updateTranscriptHighlight(srcTime);
    updateTrimPlayhead(srcTime);
    return;
  }

  if(_seekTarget !== null){
    // Give up waiting after 500ms so a seek that never quite lands (clamped
    // target, external interruption) can't permanently freeze the loop.
    if(Math.abs(t - _seekTarget) > 0.03 && performance.now() - _seekTargetSetAt < 500) return;
    _seekTarget = null;
  }

  // Loop region
  if(S.looping && S.loopA !== null && S.loopB !== null){
    if(t >= S.loopB){ _jumpTo(S.loopA); return; }
  }
  // Segment boundary — jump to next segment (handles both applied cuts and skip-mode cuts)
  if(S.playSegments.length && S.playing){
    // If before first segment (applied cut at start) — jump to it
    if(t < S.playSegments[0].start - 0.05){
      S.currentSegmentIdx = 0;
      _jumpTo(S.playSegments[0].start);
      return;
    }
  }
  if(S.playSegments.length > 1 && S.playing){
    // Correct currentSegmentIdx if playhead is outside current segment (e.g. after a manual seek)
    let curSeg = S.playSegments[S.currentSegmentIdx];
    if(!curSeg || t < curSeg.start - 0.2 || t > curSeg.end + 0.1){
      let idx = -1;
      for(let i = S.playSegments.length - 1; i >= 0; i--){
        if(S.playSegments[i].start <= t + 0.05){ idx = i; break; }
      }
      S.currentSegmentIdx = Math.max(0, idx === -1 ? 0 : idx);
      curSeg = S.playSegments[S.currentSegmentIdx];
    }
    if(curSeg && t >= curSeg.end - _boundaryThresh()){
      if(S.currentSegmentIdx < S.playSegments.length - 1){
        S.currentSegmentIdx++;
        _jumpTo(S.playSegments[S.currentSegmentIdx].start);
        return;
      } else {
        _pauseVideo();
        return;
      }
    }
  }
  // Fallback: skip cuts the video seeked into directly (inline seek into a cut region)
  if(S.skipCuts && S.cuts.length){
    const hit = S.cuts.find(s => s.selected && s.skipEnabled !== false && s.scriptPart !== true && t >= s.start && t < s.end);
    if(hit && S.playing){ _jumpTo(hit.end); return; }
  }
  // Trim out
  if(S.trimOut && t >= S.trimOut){
    _pauseVideo();
  }
  updateTimecode();
  updatePlayhead();
  updateCaptionOverlay();
  updateTextLayerOverlays(t);
  updateImageLayerOverlays(t);
  updateTranscriptHighlight(t);
  updateTrimPlayhead();
}

function _onVideoFrameFallback() {
  // timeupdate fallback — same logic using video.currentTime
  const t = video.currentTime;
  // timeupdate fires during seeking — skip all jump logic to prevent oscillation
  if(video.seeking) return;

  // See the rVFC path's proxy branch above for why this bypasses everything else.
  if(S.proxyActive){
    const srcTime = _proxyToSourceTime(t);
    if(S.looping && S.loopA !== null && S.loopB !== null){
      const loopBProxy = _sourceToProxyTime(S.loopB);
      if(loopBProxy !== null && t >= loopBProxy){ video.currentTime = _sourceToProxyTime(S.loopA) ?? 0; return; }
    }
    if(video.duration && t >= video.duration - 0.03 && S.playing){ _pauseVideo(); }
    updateTimecode(srcTime);
    updatePlayhead(srcTime);
    updateCaptionOverlay(srcTime);
    updateTextLayerOverlays(srcTime);
    updateImageLayerOverlays(srcTime);
    updateTranscriptHighlight(srcTime);
    updateTrimPlayhead(srcTime);
    return;
  }

  if(S.looping && S.loopA !== null && S.loopB !== null){
    if(t >= S.loopB){ video.currentTime = S.loopA; return; }
  }
  if(S.playSegments.length && S.playing){
    if(t < S.playSegments[0].start - 0.05){
      S.currentSegmentIdx = 0;
      video.currentTime = S.playSegments[0].start;
      return;
    }
  }
  if(S.playSegments.length > 1 && S.playing){
    let curSeg = S.playSegments[S.currentSegmentIdx];
    if(!curSeg || t < curSeg.start - 0.2 || t > curSeg.end + 0.1){
      let idx = -1;
      for(let i = S.playSegments.length - 1; i >= 0; i--){
        if(S.playSegments[i].start <= t + 0.05){ idx = i; break; }
      }
      S.currentSegmentIdx = Math.max(0, idx === -1 ? 0 : idx);
      curSeg = S.playSegments[S.currentSegmentIdx];
    }
    if(curSeg && t >= curSeg.end - 0.15){
      if(S.currentSegmentIdx < S.playSegments.length - 1){
        S.currentSegmentIdx++;
        video.currentTime = S.playSegments[S.currentSegmentIdx].start;
        return;
      } else {
        _pauseVideo();
        return;
      }
    }
  }
  if(S.skipCuts && S.cuts.length){
    const hit = S.cuts.find(s => s.selected && s.skipEnabled !== false && s.scriptPart !== true && t >= s.start && t < s.end);
    if(hit && S.playing){ video.currentTime = hit.end; return; }
  }
  if(S.trimOut && t >= S.trimOut){
    _pauseVideo();
  }
  updateTimecode();
  updatePlayhead();
  updateCaptionOverlay();
  updateTextLayerOverlays(t);
  updateImageLayerOverlays(t);
  updateTranscriptHighlight(t);
  updateTrimPlayhead();
}

if(video.requestVideoFrameCallback){
  video.addEventListener('play',  _startRVFC);
  video.addEventListener('pause', _stopRVFC);
  video.addEventListener('ended', _stopRVFC);
} else {
  jlog('warn', 'Playback loop: timeupdate fallback (rVFC not supported)');
  video.addEventListener('timeupdate', _onVideoFrameFallback);
}

// ═══════════════════════════════════════
// TIMECODE + UTILITIES
// ═══════════════════════════════════════
// overrideSrcTime: see updateCaptionOverlay() in captions.js — proxy playback
// passes the mapped source time explicitly since video.currentTime is
// proxy-space there, not source-file space.
function updateTimecode(overrideSrcTime){
  const t=overrideSrcTime!==undefined?overrideSrcTime:video.currentTime;
  document.getElementById('timecodeDisplay').textContent=tc(t);
}
function tc(t){const h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=Math.floor(t%60);return[h,m,s].map(n=>String(n).padStart(2,'0')).join(':');}
function fmt(t){if(!t)return'—';return t>=60?`${Math.floor(t/60)}m${(t%60).toFixed(1)}s`:`${t.toFixed(2)}s`;}
function clamp(v,mn,mx){return Math.max(mn,Math.min(mx||99999,v));}

// ═══════════════════════════════════════
// FLIP
// ═══════════════════════════════════════
function toggleFlip(d){
  if(d==='h') S.flipH=!S.flipH;
  else S.flipV=!S.flipV;
  video.style.transform=`scaleX(${S.flipH?-1:1}) scaleY(${S.flipV?-1:1})`;
  document.getElementById('flipH').classList.toggle('active',S.flipH);
  document.getElementById('flipV').classList.toggle('active',S.flipV);
}

// ═══════════════════════════════════════
// PLAY SEGMENTS
// ═══════════════════════════════════════

// Merge cuts that overlap by more than 50% of the shorter interval.
// Prevents double-gaps when ffmpeg silence and VAD both flag the same region.
function _deduplicateCuts(cuts){
  if(cuts.length < 2) return cuts;
  const sorted = [...cuts].sort((a, b) => a.start - b.start);
  const out = [{...sorted[0]}];
  for(let i = 1; i < sorted.length; i++){
    const prev = out[out.length - 1];
    const cur  = {...sorted[i]};
    const overlap = Math.min(prev.end, cur.end) - Math.max(prev.start, cur.start);
    if(overlap > 0){
      const shorter = Math.min(prev.end - prev.start, cur.end - cur.start);
      if(shorter > 0 && overlap / shorter > 0.5){
        // Merge: expand prev to cover both
        prev.end = Math.max(prev.end, cur.end);
        if(cur.selected) prev.selected = true;
        continue;
      }
    }
    out.push(cur);
  }
  return out;
}

// Derives ordered play regions from S.segments (or S.clips as fallback)
// with selected S.cuts removed.
function buildPlaySegments(){
  // Anything that reaches here changed segments/cuts (or a clip/undo swap) —
  // the rendered proxy no longer matches, if one exists.
  S.proxyDirty = true;
  const activeCuts = _deduplicateCuts(
    S.cuts.filter(c => c.selected && c.skipEnabled !== false && c.scriptPart !== true && c.type !== 'highlight')
  ).sort((a, b) => a.start - b.start);
  const hasAppliedSegments = S.segments.length > 1;
  const hasSkippableCuts   = S.skipCuts && activeCuts.length > 0;

  if(!hasAppliedSegments && !hasSkippableCuts){
    // Nothing to skip, no applied cuts — play full clip
    S.playSegments = [{start: S.trimIn||0, end: S.trimOut||S.duration, timelineStart: 0}];
    S.currentSegmentIdx = 0;
    return S.playSegments;
  }

  // Build play regions: take each source segment, subtract active (unapplied) cuts
  const rawRegions = [];
  for(const seg of S.segments){
    let cursor = seg.sourceStart;
    if(hasSkippableCuts){
      for(const cut of activeCuts){
        if(cut.end <= cursor || cut.start >= seg.sourceEnd) continue;
        const cutStart = Math.max(cut.start, seg.sourceStart);
        const cutEnd   = Math.min(cut.end,   seg.sourceEnd);
        if(cutStart - cursor > 0.001) rawRegions.push({start: cursor, end: cutStart});
        cursor = cutEnd;
      }
    }
    if(seg.sourceEnd - cursor > 0.001) rawRegions.push({start: cursor, end: seg.sourceEnd});
  }

  let tl = 0;
  S.playSegments = rawRegions.map(r => {
    const ps = {start: r.start, end: r.end, timelineStart: tl};
    tl += r.end - r.start;
    return ps;
  });
  S.currentSegmentIdx = 0;
  return S.playSegments;
}

// Returns the playhead's pixel position on the (live, possibly gap-hatched)
// timeline. Translates source time into timeline position using the active
// segment's timelineStart. overrideSrcTime: see updateCaptionOverlay().
function getPlayheadPosition(overrideSrcTime){
  const srcTime = overrideSrcTime!==undefined?overrideSrcTime:video.currentTime;
  const tl = sourceTimeToTimeline(srcTime);
  if(tl !== null) return tl * S.zoom;
  return srcTime * S.zoom;
}

// Returns S.segments-shaped {sourceStart,sourceEnd,timelineStart} laid out
// with a contiguous (gapless) cursor — independent of the live S.snapped
// display state. Export always produces a gapless concatenation of kept
// segments (ffmpeg concat, no gaps), so anything computing caption-sync
// timestamps for export/burn-in must use this instead of trusting
// S.segments[].timelineStart directly, which now holds real gaps pre-snap
// (see _relayoutSegments() in trim.js / the gap-hatching timeline render).
function gaplessSegmentMeta(){
  let cursor=0;
  return S.segments.map(s=>{
    const m={sourceStart:s.sourceStart, sourceEnd:s.sourceEnd, timelineStart:cursor};
    cursor+=(s.sourceEnd-s.sourceStart);
    return m;
  });
}

// Maps a source-file timestamp to its position on the (potentially cut) timeline.
// Returns null if the time falls inside a removed region.
function sourceTimeToTimeline(t){
  if(!S.segments.length) return t; // no cuts applied — 1:1 mapping
  for(const seg of S.segments){
    if(t >= seg.sourceStart && t <= seg.sourceEnd){
      return seg.timelineStart + (t - seg.sourceStart);
    }
  }
  return null; // inside a removed cut
}

// Inverse of sourceTimeToTimeline() — maps a timeline position back to a
// source-file timestamp. Clamps to the nearest segment edge if the position
// falls outside all segments (before the first / after the last).
function timelineToSourceTime(tl){
  if(!S.segments.length) return tl; // no cuts applied — 1:1 mapping
  for(const seg of S.segments){
    const segEndTl = seg.timelineStart + seg.duration;
    if(tl >= seg.timelineStart && tl <= segEndTl){
      return seg.sourceStart + (tl - seg.timelineStart);
    }
  }
  const first = S.segments[0], last = S.segments[S.segments.length-1];
  if(tl < first.timelineStart) return first.sourceStart;
  return last.sourceEnd;
}
