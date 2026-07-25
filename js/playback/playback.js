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

function skipTime(d){if(!video.src)return;video.currentTime=clamp(video.currentTime+d,S.trimIn,S.trimOut||S.duration);}
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

function _onVideoFrame(now, metadata) {
  // Re-register first so the loop continues without gaps
  _rVFCHandle = video.requestVideoFrameCallback(_onVideoFrame);

  const t = metadata.mediaTime;

  // While seeking (programmatic or user scrub) skip all jump logic to prevent oscillation
  if(video.seeking) return;

  // Loop region
  if(S.looping && S.loopA !== null && S.loopB !== null){
    if(t >= S.loopB){ video.currentTime = S.loopA; return; }
  }
  // Segment boundary — jump to next segment (handles both applied cuts and skip-mode cuts)
  if(S.playSegments.length && S.playing){
    // If before first segment (applied cut at start) — jump to it
    if(t < S.playSegments[0].start - 0.05){
      S.currentSegmentIdx = 0;
      video.currentTime = S.playSegments[0].start;
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
    if(curSeg && t >= curSeg.end - 0.05){
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
  // Fallback: skip cuts the video seeked into directly (inline seek into a cut region)
  if(S.skipCuts && S.cuts.length){
    const hit = S.cuts.find(s => s.selected && s.skipEnabled !== false && s.scriptPart !== true && t >= s.start && t < s.end);
    if(hit && S.playing){ video.currentTime = hit.end; return; }
  }
  // Trim out
  if(S.trimOut && t >= S.trimOut){
    _pauseVideo();
  }
  updateTimecode();
  updatePlayhead();
  updateCaptionOverlay();
  updateTranscriptHighlight(t);
  updateTrimPlayhead();
}

function _onVideoFrameFallback() {
  // timeupdate fallback — same logic using video.currentTime
  const t = video.currentTime;
  // timeupdate fires during seeking — skip all jump logic to prevent oscillation
  if(video.seeking) return;
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
function updateTimecode(){document.getElementById('timecodeDisplay').textContent=tc(video.currentTime);}
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
  const out = [sorted[0]];
  for(let i = 1; i < sorted.length; i++){
    const prev = out[out.length - 1];
    const cur  = sorted[i];
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

// Returns the playhead's pixel position on the snapped timeline.
// Translates raw source time into timeline position using the active segment's timelineStart.
function getPlayheadPosition(){
  const tl = sourceTimeToTimeline(video.currentTime);
  if(tl !== null) return tl * S.zoom;
  return video.currentTime * S.zoom;
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
