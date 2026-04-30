# ClipCut — CLAUDE.md

## Git Commit Rule — MANDATORY
After every change session, commit all modified files with a clear, descriptive message and push to origin:
```bash
git add <changed files>
git commit -m "short description of what changed and why"
git push
```
- One commit per logical change — don't batch unrelated edits into one commit
- Message format: `area: what changed` (e.g. `export: rename vexxefx_ prefix to clipcut_`)
- Always push after committing — the remote should stay in sync

## Restore Points — System

Restore point snapshots live in `_backups/`. Each folder is a full copy of all source files at a point in time.

### How to revert to a restore point
```bash
# Replace working files with a snapshot (run from home_editor/)
cp -r _backups/restore_2026-04-12/js ./js
cp _backups/restore_2026-04-12/ugc-editor-v2.html .
cp _backups/restore_2026-04-12/editor.css .
cp _backups/restore_2026-04-12/serve.py .
cp _backups/restore_2026-04-12/waveform.worker.js .
```

### When to create a new restore point (MANDATORY)
**Before starting any non-trivial change**, create a new dated snapshot:
```bash
mkdir -p _backups/restore_YYYY-MM-DD
cp -r js _backups/restore_YYYY-MM-DD/js
cp ugc-editor-v2.html editor.css serve.py waveform.worker.js _backups/restore_YYYY-MM-DD/
```
- One snapshot per session/day is enough — don't spam them
- Never edit files inside `_backups/` — they are read-only references
- Name format: `restore_YYYY-MM-DD` (add `-b` suffix for a second snapshot same day)

---

## Change Log
Log entries moved to `CHANGELOG.md`. Append new one-liners there. Format: `date · file · what changed`.

---

## Project Overview
Browser-based UGC video editor focused on dead space removal, 
AI script analysis, and caption generation. Built for fast 
talking-head video editing workflow. Single operator tool — 
not a general purpose editor.

## File Structure
home_editor/
├── ugc-editor-v2.html      # HTML structure only
├── editor.css              # All styles
├── editor.js               # LEGACY MONOLITH — kept as backup, not loaded by HTML
├── waveform.worker.js      # OffscreenCanvas Web Worker — owns both waveform canvas contexts
├── serve.py                # pywebview desktop app — HTTP server + Python API (NO Flask)
├── whisper_server.py       # UNUSED — kept for reference only (Flask was removed)
├── config.json             # API keys and settings (never commit)
├── CLAUDE.md               # This file
└── js/                     # Split JS modules — loaded in order by ugc-editor-v2.html
    ├── core/
    │   ├── logger.js       # jlog(), window.onerror, console.error override — LOAD FIRST
    │   ├── state.js        # S object, _clipRegistry, video/ph/tArea DOM refs — LOAD SECOND
    │   └── history.js      # saveHistory(), undo(), redo(), _applySnapshot()
    ├── config/
    │   └── config.js       # loadConfig(), updateConfigStatus(), setAiSource()
    ├── captions/
    │   ├── captions.js     # caption list, overlay, exportCaptions(), styles
    │   └── whisper.js      # transcribeWithWhisper(), checkWhisperServer()
    ├── detection/
    │   ├── waveform.js     # extractAudioData(), drawWaveformModal(), drawTimelineWaveform(), sliceWaveforms(), _initWaveWorker IIFE
    │   ├── silence.js      # detectDeadSpaces(), detectFillers(), renderAllFindings(), applyCuts(), selectCut(), seekToCut()
    │   └── ai.js           # AI chat, script analysis, model selector, token guard, provider switcher
    ├── media/
    │   ├── import.js       # loadClip(), selectClip(), loadClipFromPath(), openFileNative()
    │   └── export.js       # startExport(), _doPywebviewExport(), _doFlaskExport(), exportFrame()
    ├── playback/
    │   └── playback.js     # togglePlay(), rVFC loop, buildPlaySegments(), getPlayheadPosition(), sourceTimeToTimeline(), tc(), fmt(), clamp()
    ├── timeline/
    │   ├── trim.js         # trim handles, mousemove/mouseup drag, applyTrim(), trimBefore(), trimAfter(), splitAtPlayhead()
    │   └── timeline.js     # renderTimeline(), buildRuler(), snapGaps(), renderClipList(), handleTLClick(), zoomTL()
    ├── ui/
    │   ├── ui.js           # tools, modals, tabs, toast(), keyboard shortcuts, markers, loop, toggleSkipCuts()
    │   └── settings.js     # loadSettings(), saveSettings(), toggleSetting(), setCombineMode(), updateSettingsUI()
    └── main.js             # Init: renderTimeline(), loadConfig(), loadSettings(), FFmpeg shim, welcome toast

### Script load order in ugc-editor-v2.html
```
js/core/logger.js       ← must be first (jlog used everywhere)
js/core/state.js        ← must be second (S, video, ph, tArea used everywhere)
js/config/config.js
js/captions/captions.js
js/captions/whisper.js
js/detection/waveform.js
js/detection/silence.js
js/detection/ai.js
js/media/import.js
js/media/export.js
js/playback/playback.js
js/timeline/trim.js
js/timeline/timeline.js
js/core/history.js
js/ui/ui.js
js/main.js              ← must be last (calls renderTimeline etc.)
```

## Tech Stack
- **Frontend:** Vanilla HTML/CSS/JS — no React, no build system
- **Fonts:** Outfit (UI) + JetBrains Mono (timecodes/mono) via Google Fonts
- **Desktop wrapper:** pywebview — exposes Python API to JS via `window.pywebview.api.*`
- **Transcription:** Two backends, switchable via config.json `whisper_backend`:
  - `faster-whisper` (default) — fast, word timestamps via beam search, may drift in long silences
  - `whisperx` (opt-in) — faster-whisper transcription + Wav2Vec2 forced alignment → ms-accurate word boundaries + retake detection
- **AI Analysis:** OpenRouter API (free models) + Ollama local fallback
- **Video Export:** Native ffmpeg (h264_nvenc GPU encoding) — two-pass for multi-segment
- **Audio Analysis:** Web Audio API (RMS waveform)
- **Waveform rendering:** OffscreenCanvas + Web Worker (`waveform.worker.js`) — main thread fallback if unsupported
- **Playback loop:** `requestVideoFrameCallback` (rVFC) — fires per rendered frame via `metadata.mediaTime`; falls back to `timeupdate` if unsupported
- **Silence Detection:** ffmpeg `silencedetect` filter — runs in serve.py API class
- **VAD Detection:** Silero VAD (`silero-vad`) — lazy singleton, used by `detectDeadSpaces()`
- **Visual Detection:** MediaPipe FaceMesh (`mediapipe` + `opencv-contrib-python`) — lip aperture landmarks 13/14 normalised by face height, used by `mediapipe_detect()`
- **Flask:** REMOVED — all backend logic is in serve.py API class

## Python Dependencies
```
faster-whisper       # transcription (always loaded)
whisperx             # forced alignment backend (opt-in)
silero-vad           # VAD dead-air detection
mediapipe            # visual lip detection
opencv-contrib-python # video frame reading for mediapipe (pulled by mediapipe)
torch 2.11+cu128     # GPU — CUDA 12.8, RTX 4070
torchaudio 2.11+cu128
torchvision          # matched to torch version
pywebview            # desktop app wrapper
ffmpeg               # system install (export, silence detect, audio extract)
```
Install CUDA torch: `pip install torch torchaudio torchvision --index-url https://download.pytorch.org/whl/cu128`
Install WhisperX: `pip install whisperx --no-deps && pip install transformers ctranslate2`

## How to Run
```bash
python serve.py
# Opens pywebview desktop window at 1920×1080
# HTTP server runs at localhost:8080 (serves static files + /video streaming endpoint)
# All Python APIs exposed via window.pywebview.api.*
```

## Video URL Handling — CRITICAL
- Video files are NOT loaded via `file:///` URLs — browsers block cross-origin file:// from HTTP pages
- `loadClipFromPath(sourcePath)` builds: `http://localhost:8080/video?path=<encoded path>`
- The HTTP server's `/video` endpoint streams arbitrary local files with full Range request support
- `clip.sourcePath` stores the real filesystem path — used for ffmpeg export/transcription
- `clip.url` stores the HTTP streaming URL — used for browser video preview
- `clip.browserPlayable`: `true` if `onloadedmetadata` fired, `false` if codec unsupported (ProRes etc.)
- For unplayable formats: `onerror` probes duration via `pywebview.api.probe_duration()` (ffprobe), shows "preview N/A"

## config.json Structure
```json
{
  "openrouter_key": "sk-or-...",
  "openrouter_model": "meta-llama/llama-4-scout:free",
  "ollama_url": "http://localhost:11434",
  "ollama_model": "llama3",
  "whisper_model": "base",
  "whisper_backend": "faster-whisper",
  "whisperx_model": "distil-large-v3",
  "whisperx_batch_size": 16,
  "silence_threshold": -35,
  "silence_min_duration": 0.5
}
```
- `whisper_backend`: `"faster-whisper"` (default) | `"whisperx"` — switchable live from Settings tab, no restart needed
- `whisperx_model`: model for `whisperx.load_model()` — `"distil-large-v3"` (fast+accurate), `"large-v3"` (max accuracy), `"medium"`, `"small"`
- `whisperx_batch_size`: GPU parallel chunks — `16` for 4070 12GB; drop to `8` on OOM
- `whisper_port` and `whisper_mode` are no longer used (Flask removed)
- distil-large-v3 + Wav2Vec2 alignment model auto-download from HuggingFace on first use (~1.5GB + ~100MB, cached)

## serve.py — pywebview API class
All Python functionality exposed to JS via `window.pywebview.api.*`:
- `open_file()` → native file picker (`webview.FileDialog.OPEN`), returns absolute path
- `pick_folder()` → native folder picker (`webview.FileDialog.FOLDER`), returns path
- `probe_duration(source_path)` → ffprobe duration in seconds (for unplayable containers)
- `ping()` → loads transcription model (backend-dependent) + Silero VAD (lazy singletons), returns `{online, model, device, backend}`
- `transcribe(source_path)` → ffmpeg audio extract + transcription. Returns `{words, language, duration, backend}` + optional `retake_cuts` when backend=whisperx
- `detect_silence(source_path, threshold, min_duration, pad_before, pad_after)` → `{cuts, count, duration}`
- `vad_detect(source_path, threshold, min_speech_ms, min_silence_ms)` → `{speech_segments, cuts, count, duration}` — Silero VAD; inverts speech to produce dead_air cuts; same response shape as `detect_silence()`
- `mediapipe_detect(source_path, lip_threshold, min_speaking_ms, frame_skip)` → `{speaking_segments, cuts, count, duration}` — MediaPipe FaceMesh lip aperture; inverts speaking → dead_air cuts
- `get_whisper_config()` → returns `{whisper_backend, whisperx_model, whisperx_batch_size}` for Settings UI
- `save_whisper_config(backend, model, batch_size)` → writes to config.json + applies globals live (no restart needed), returns `{ok, backend, model, batch_size}`
- `export_video(...)` → opens `FileDialog.SAVE`, two-pass GPU encode, returns `{success, path}`
- `cancel_export()` → sets `_export_cancelled = True`
- `log_js(level, msg)` → routes JS logs to terminal with `[HH:MM:SS] [JS/LEVEL]` prefix

### HTTP server `/video` endpoint
- Streams arbitrary local files over HTTP with Range request support (seeking works)
- Route: `GET /video?path=<url-encoded-absolute-path>`
- Handles `206 Partial Content` for Range requests — required for video scrubbing

### VAD model (serve.py)
- `_get_vad_model()` — lazy singleton, same lock pattern as whisper. Loads `silero_vad.load_silero_vad()` on first call.
- Warmed up inside `ping()` so both whisper and VAD are ready before first use.

### WhisperX models (serve.py)
- `_get_whisperx_model()` — lazy singleton for the transcription model (`WHISPERX_MODEL`, default `distil-large-v3`)
- `_get_whisperx_align(language)` — per-language alignment model cache `{lang: (model_a, metadata)}` — reloads only when a new language appears
- `_detect_retakes(segments)` — module-level helper: Jaccard word overlap (≥70%, 10-seg window) marks earlier occurrence of repeated sentence as retake
- WhisperX path in `transcribe()`: load_audio → model.transcribe → align → extract words → `_detect_retakes` → return `{..., retake_cuts, backend:'whisperx'}`
- Falls back to faster-whisper if whisperx import fails

### Daemon threads (serve.py)
- **Whisper auto-ping:** starts 2s after window open; warms correct model based on `WHISPER_BACKEND`; updates `#whisperStatus` and `#settingsBackendBadge` via `evaluate_js`
- **Config hot-reload:** polls `config.json` mtime every 2s; calls `evaluate_js("loadConfig()")` on change — no restart required

### Desktop app extras (serve.py)
- `webview.settings['REMOTE_DEBUGGING_PORT'] = 9222` — Chrome DevTools via `chrome://inspect`
- `shadow=True` on `create_window`
- Native menu via `webview.Menu` / `webview.MenuAction` (wrapped in try/except — availability varies by platform):
  - **File:** Open Video, Import from Path, Save Project, Export…
  - **Edit:** Undo, Redo, Apply Cuts, Snap Gaps
  - **View:** Zoom In, Zoom Out, Reset Zoom
  - **Help:** About

### Export system (serve.py)
- GPU path: `h264_nvenc` + `PRESET_MAP` with nvenc presets (p2/p4/p6) + vbr bitrate
- CPU fallback: `libx264` + crf
- Single segment: one-pass hwaccel encode direct to save_path
- Multi-segment: extract each segment (GPU encode) → `ffmpeg concat -c copy` (no re-encode)
- Progress: ffmpeg `-progress pipe:1`, parsed for `out_time_us`; pushed to JS via `evaluate_js('_onExportProgress(N)')`
- stderr always fully logged (not just on failure)
- `_export_cancelled` flag checked between segments and during ffmpeg loop
- PRESET_MAP:
  - fast: nvenc p2, 6M bitrate
  - balanced: nvenc p4, tune hq, 8M bitrate
  - quality: nvenc p6, tune hq, 15M bitrate

## JS → Terminal Logging
```js
jlog(level, msg)  // 'info' | 'warn' | 'error'
// → pywebview.api.log_js(level, msg) → terminal as [HH:MM:SS] [JS/LEVEL] msg
```
- `window.onerror` → jlog('error', ...)
- `unhandledrejection` → jlog('error', ...)
- `console.error` overridden → jlog('error', ...) with proper Error serialization (message + stack)
- Keyboard shortcuts log: `keyStr → action()  [undoStack=N redoStack=N]`

## State Object (S) — js/core/state.js
All app state lives in `const S = {...}`. Key fields:
```js
S.clips            // imported video files
S.current          // active clip
S.selectedClipId   // selected clip in timeline
S.segments         // kept video segments after cuts/trim applied
S.cuts             // ALL detected issues [{id, start, end, type, selected, skipEnabled, scriptPart, aiNote, text}]
S.playSegments     // derived from S.segments for virtual playback
S.currentSegmentIdx // which segment is playing
S.skipCuts         // boolean — whether playback skips cuts (default true)
S.captions         // word-level caption array [{id, text, start, end}]
S.waveformData     // {frames, dur, sr} from Web Audio API
S.markers          // manual timeline markers
S.loopA / S.loopB  // A/B loop points
S.looping          // loop on/off
S.undoStack        // two-stack undo (array of JSON snapshots)
S.redoStack        // two-stack redo (array of JSON snapshots)
S.orKey            // OpenRouter API key (from config.json)
S.orModel          // selected model id
S.selectedModel    // full model object {id, name, context_length}
S.availableModels  // fetched from OpenRouter /api/v1/models
S.aiProvider       // 'openrouter' | 'ollama'
S.ollamaUrl        // default 'http://localhost:11434'
S.ollamaModel      // selected ollama model id
S.chatHistory      // AI chat message history
S.whisperMode      // words | captions | segments
S.wordsPerCap      // words per caption chunk (default 2)
S.settings         // pipeline + auto mode config (persisted to localStorage via settings.js)
  // Detection: useVAD, useMediapipe, combineMode ('and'|'or'), vadThreshold, vadMinSpeechMs, vadMinSilenceMs
  // MediaPipe: mpLipThreshold, mpMinSpeakingMs, mpFrameSkip
  // Auto Mode: autoTranscribe, autoWaveform, autoSilence, autoDeadSpaces, autoMediapipe, autoFillers
  // Deep AI:   deepAI, deepMediapipe
  // Transcription: detectRetakes
S.stripPunct       // strip punctuation from captions (default true)
S.captionLayout    // single | stack | grid
S.flipH / S.flipV  // video flip state
S.trimIn / S.trimOut // current trim points
S.selectedCutId    // currently selected cut in timeline
S.selectedSegmentId // currently selected segment
S.snapped          // whether gaps have been closed
S.zoom             // timeline zoom level (px per second)
```

## Clip Object Shape
```js
{
  id: crypto.randomUUID(),
  file: null,            // File object (browser drag-drop) or null (native open)
  url: 'http://localhost:8080/video?path=...',  // HTTP streaming URL for preview
  sourcePath: 'C:\\...',  // absolute filesystem path — used by ffmpeg
  name: 'video.mp4',
  duration: 0,
  trimIn: 0,
  trimOut: null,         // null = use duration
  silCuts: [],
  browserPlayable: null, // true=onloadedmetadata fired, false=codec unsupported
  segments: [...]        // clip-level segment array (copied to S.segments on selectClip)
}
```

## Cut Object Shape
Every detected issue uses this shape — do NOT deviate:
```js
{
  id: crypto.randomUUID(),
  start: 0.00,          // seconds in source file
  end: 0.00,            // seconds in source file
  type: 'dead_air' | 'filler' | 'retake' | 'weak' | 'silence' | 'highlight',
  text: '',             // spoken word if available
  aiNote: '',           // AI reasoning
  selected: true,       // included in next Apply Cuts
  skipEnabled: true,    // skipped during playback
  scriptPart: false     // marked as intentional — never cut
}
```

## Segment Object Shape
```js
{
  id: crypto.randomUUID(),
  sourceStart: 0.0,     // position in original file
  sourceEnd: 0.0,
  timelineStart: 0.0,   // position on timeline (recalc after snap)
  duration: 0.0,        // sourceEnd - sourceStart
  waveformSlice: null   // assigned by sliceWaveforms()
}
```

## Key Functions — by file
**js/core/state.js** — S object, _clipRegistry, video/ph/tArea

**js/core/history.js**
- `saveHistory()` — call BEFORE every destructive action. Snapshots: clips, captions, trimIn, trimOut, cuts, segments, markers
- `undo()` / `redo()` — two-stack undo/redo system

**js/config/config.js**
- `loadConfig()` — fetches config.json, populates S.orKey, S.orModel etc.
- `updateConfigStatus()` — updates config status badge in UI

**js/captions/captions.js**
- `exportCaptions(fmt)` — SRT/VTT export with post-cut timestamp remapping; `fmt` is `'srt'` or `'vtt'`
- `updateCaptionList()`, `updateCaptionOverlay()` — caption UI

**js/captions/whisper.js**
- `transcribeWithWhisper()` — calls pywebview.api.transcribe(sourcePath), requires clip.sourcePath
- `checkWhisperServer()` — calls pywebview.api.ping() to load model

**js/detection/waveform.js**
- `extractAudioData()` — Web Audio API waveform analysis (fetches clip.url over HTTP)
- `sliceWaveforms()` — slices waveform data per segment. Does NOT call `drawTimelineWaveform()` — caller must call `renderTimeline()` afterward
- `drawTimelineWaveform()` — posts `draw_tl` to worker if available; otherwise draws on main thread
- `drawWaveformModal()` — posts `draw_mod` to worker if available; otherwise draws on main thread
- `_initWaveWorker()` IIFE — transfers both waveform canvas controls via `transferControlToOffscreen()` to waveform.worker.js

**js/detection/silence.js**
- `detectDeadSpaces()` — reads `S.settings.useVAD` + `S.settings.useMediapipe`; runs enabled engines, combines with `_combineCuts(mode)`, falls back to RMS if all fail
- `_combineCuts(cutsA, cutsB, mode)` — 'and': intersection ≥0.1s overlap; 'or': union/merge with 0.05s gap tolerance
- `detectFillers()` — local filler word detection from S.captions
- `applyCuts()` — splits S.segments at selected cut points, calls `buildPlaySegments()`, `sliceWaveforms()`, then `renderTimeline()`
- `renderAllFindings()` — renders all cuts/findings across AI and Silence tabs
- `renderSilenceFindings()` — renders audio-based cuts (dead_air, silence) in Silence tab
- `seekToCut(cutId)` — seeks video to cut start, selects cut in UI
- `selectCut(cutId)` — highlights cut on timeline, updates trim panel via S.selectedCutId
- `updateTrimContext()` — updates trimContextLabel/trimContextDur based on selectedCutId/selectedSegmentId
- `toggleCutSelected(cutId)` — toggles cut.selected, rebuilds play segments
- `runAutoMode(deep)` — chains steps controlled by S.settings flags (see Auto Mode section below)

**js/detection/ai.js**
- `runAIScriptAnalysis()` — sends transcript to OpenRouter/Ollama, populates S.cuts
- `runAIAnalysis()` — audio analysis + OpenRouter silence review
- `sendChat()` — AI chat with system prompt + SRT context
- `_parseActionBlocks(text)` — tolerant line-by-line parser for AI chat action blocks
- `_execAIAction(block)` — executes a parsed AI action on the timeline
- `_buildChatSRT()` — builds sentence-grouped SRT from S.captions for AI chat context
- `checkTokenLimit(prompt)` — checks prompt against model context_length before every AI call
- `setProvider(p)` — switches AI provider between 'openrouter' and 'ollama'
- `fetchOllamaModels()` — discovers installed Ollama models via /api/tags
- `fetchOpenRouterModels()` — fetches free models from OpenRouter API

**js/media/import.js**
- `loadClip(file)` — loads a File object into the editor
- `selectClip(id)` — loads clip into preview, sets S.current + S.selectedClipId. Skips video.src for browserPlayable===false
- `loadClipFromPath(sourcePath)` — native import path. Builds HTTP URL, probes duration via ffprobe if browser can't decode
- `onUploadZoneClick()` — routes to openFileNative() in pywebview, fileInput.click() in browser
- `openFileNative()` — calls pywebview.api.open_file(), passes path to loadClipFromPath()

**js/media/export.js**
- `startExport()` — routes to pywebview or Flask export based on context
- `_doPywebviewExport()` — export via pywebview API (no upload/download, direct ffmpeg)
- `_onExportProgress(pct)` — global, called by Python via evaluate_js() during export
- `exportFrame()` — exports current frame as PNG

**js/playback/playback.js**
- `togglePlay()`, `skipTime()`, `setSpeed()`, `setVolume()`
- `buildPlaySegments()` — derives S.playSegments from S.segments for virtual playback
- `getPlayheadPosition()` — returns pixel position of playhead on timeline
- `sourceTimeToTimeline(t)` — maps source timestamp to timeline position; returns null if inside a cut
- `tc(t)`, `fmt(t)`, `clamp(v,mn,mx)` — utility functions used across all modules

**js/timeline/trim.js**
- `updateTrimUI()` — updates trim bar display (handles cut-mode vs clip-mode)
- `applyTrim()` — commits trim bar handles: calls `_applyTrimToSegments` → `sliceWaveforms` → `renderTimeline`
- `resetTrim()` — restores full clip duration
- `trimBefore()` — immediately chops everything before playhead: sets S.trimIn, calls `_applyTrimToSegments` → `sliceWaveforms` → `renderTimeline`
- `trimAfter()` — immediately chops everything after playhead: sets S.trimOut, calls `_applyTrimToSegments` → `sliceWaveforms` → `renderTimeline`
- `splitAtPlayhead()` — splits selected clip at current playhead position
- `_applyTrimToSegments(tIn, tOut)` — clamps S.segments to [tIn, tOut], recalculates timelineStart offsets

**js/timeline/timeline.js**
- `renderTimeline()` — redraws entire timeline. ALWAYS re-appends playhead (`ph`) as last child of `tracksInner` at end
- `buildRuler(totalDur, totalW, zoom)` — renders ruler ticks and markers
- `snapGaps()` — recalculates timelineStart for all segments to close gaps
- `renderClipList()` — renders clip library in Media tab
- `handleTLClick(e)` — maps timeline pixel position to source time via segment offsets (NOT raw `x/zoom`); critical after trim ops
- `zoomTL(d)` — adjusts S.zoom and re-renders

**js/timeline/trim.js**
- `splitAtPlayhead()` — splits the segment containing `video.currentTime` into two segments in `S.segments` (NOT S.clips); rebuilds timelineStart, calls `buildPlaySegments` → `sliceWaveforms` → `renderTimeline`

**js/ui/ui.js**
- `toast(msg)` — shows toast notification
- `switchTab(name)` — switches left panel tab; calls `_loadWhisperConfigFromServer()` when switching to 'settings'
- `openModal(id)` / `closeModal(id)` — modal open/close
- `deleteClip()`, `setAspect()`, `addMarker()`, `toggleLoop()`, `toggleSkipCuts()`, `toggleScriptPart()`, `toggleCutSkip()`
- Keyboard shortcut handler (Space, arrows, Q/W/H/V, Ctrl+Z, Delete, +/-)
- Body drag-drop handler

**js/ui/settings.js**
- `loadSettings()` — loads from localStorage, merges with SETTINGS_DEFAULTS, calls `updateSettingsUI()` + `_loadWhisperConfigFromServer()` after 800ms
- `saveSettings()` — persists S.settings to localStorage
- `toggleSetting(key)` — flips boolean, syncs checkbox, saves
- `setCombineMode(mode)` — sets 'and'/'or', updates button UI, saves
- `updateMPSetting(key, val)` — updates numeric setting, saves
- `resetSettings()` — restores all SETTINGS_DEFAULTS
- `setWhisperBackend(backend)` — updates pill UI, calls `_saveWhisperConfig()`
- `updateWhisperXSetting()` — reads model/batch from DOM, calls `_saveWhisperConfig()`
- `_saveWhisperConfig()` — calls `pywebview.api.save_whisper_config()`, updates badge + status line
- `_loadWhisperConfigFromServer()` — calls `pywebview.api.get_whisper_config()`, populates backend pills + model select + batch slider
- `updateSettingsUI()` — syncs all DOM controls from S.settings

## handleTLClick — Source Time Mapping (CRITICAL)
After `trimBefore`/`trimAfter`, segments have `timelineStart ≠ sourceStart`. Raw `x/zoom` gives wrong source time.
Always map through segments:
```js
const tlPos = (e.clientX - tArea.getBoundingClientRect().left + tArea.scrollLeft) / S.zoom;
let srcTime = tlPos;
if (S.segments.length) {
  for (const seg of S.segments) {
    const segEndTl = seg.timelineStart + seg.duration;
    if (tlPos >= seg.timelineStart && tlPos <= segEndTl) {
      srcTime = seg.sourceStart + (tlPos - seg.timelineStart);
      break;
    }
    srcTime = S.segments[S.segments.length - 1].sourceEnd;
  }
}
```

## OffscreenCanvas Waveform Worker (waveform.worker.js)
- `init_tl` → takes `msg.canvas` (OffscreenCanvas), stores 2D context as `tlCtx`
- `init_mod` → takes `msg.canvas` (OffscreenCanvas), stores 2D context as `modCtx`
- `draw_tl` → `{ frames, segments, slicedSegments, zoom, totalPx, H }` — draws pre-cut or post-cut timeline waveform
- `draw_mod` → `{ frames, W, H }` — draws modal waveform (fills background, then bars)
- Main thread fallback: if `canvas.transferControlToOffscreen` is undefined, draws directly

### Waveform draw ordering — CRITICAL
The OffscreenCanvas worker draws asynchronously. The main thread sets `c.style.width` synchronously, while the worker sets `canvas.width` asynchronously via postMessage. If two draw messages are posted with different `totalPx` values (e.g. one from `sliceWaveforms` before `renderTimeline` resizes `tracksInner`, and one from inside `renderTimeline` after), the CSS width changes to the second value while the canvas is still the first size → squished/compressed waveform visible for one or more frames.

**Rule:** `sliceWaveforms()` must NOT call `drawTimelineWaveform()`. Only `renderTimeline()` triggers the draw, after `tracksInner` has already been resized. One message per operation. Order in all trim/cut/undo paths: `sliceWaveforms()` → `renderTimeline()`.

## Drag-Drop — pywebviewFullPath
When a file is dragged onto the app window via pywebview, the `File` object gets an extra property:
```js
file.pywebviewFullPath  // real Windows absolute path, e.g. "C:\Users\Vexxe\Videos\clip.mp4"
```
`loadClip(file)` reads `file.pywebviewFullPath || file.path` as `sourcePath` before falling back to browser-only mode.

## pywebview.state Sync
After `applyCuts()` and `snapGaps()`:
```js
if (window.pywebview?.state) window.pywebview.state.segments = S.segments;
```
Keeps Python-side state in sync for potential future native features.

## UI Layout Changes (vs original)
- **Topbar:** Select, Trim mode, Split, Trim Before, Trim After buttons REMOVED from topbar
- **Timeline header row:** now contains: `↖ Select · ✂ Trim · ⊘ Split | ◁ Trim Before · Trim After ▷ | ↯ Snap · ⊞ Snap Gaps | 👁 Silence`
- **Media tab:** upload zone `onclick` → `onUploadZoneClick()`. No separate native open button.
- **Captions tab:** port input + Ping button replaced with single `⚡ Load Whisper Model` button
- **Export modal:** Save folder row removed (native Save dialog handles folder+filename)

## Tab Structure — Left Panel
**Media tab:** video import (click or drag-drop), clip library, silence cuts list
**Captions tab:** Load Whisper Model button, words-per-cap stepper, strip punctuation toggle, transcribe button, caption list
**Silence tab:** threshold/duration/padding sliders (cached to localStorage), Run AI Silence Removal, Detect Dead Spaces, silence findings list (dead_air + silence types only)
**AI tab:** provider pills (OpenRouter / Ollama), model selector, ping status, script textarea, Analyse Script, Detect Fillers, findings list (filler + retake + weak + highlight types), Apply Selected Cuts, AI Chat panel
**Settings tab (⚙):** Transcription backend (faster-whisper/WhisperX pills, model select, batch size slider, retake detection toggle) · Detection Pipeline (VAD toggle, MediaPipe toggle, combine mode AND/OR, VAD tuning sliders, MediaPipe tuning sliders) · Auto Mode Steps (checkboxes per step) · Deep AI Mode Extras (AI analysis, MediaPipe pass) · Reset to Defaults

## Auto Mode & Deep AI Mode
`runAutoMode(deep)` in `js/detection/silence.js` — all steps gated by `S.settings` flags:

| Step | Setting flag | Auto | Deep |
|------|-------------|------|------|
| Transcribe (Whisper/WhisperX) | `autoTranscribe` | ✓ | ✓ |
| Waveform analysis | `autoWaveform` | ✓ | ✓ |
| Silence detection (ffmpeg) | `autoSilence` | ✓ | ✓ |
| Dead spaces (VAD/MediaPipe) | `autoDeadSpaces` | ✓ | ✓ |
| MediaPipe visual check | `autoMediapipe` | ✓ (only if `useMediapipe` on) | ✓ |
| Filler words | `autoFillers` | ✓ | ✓ |
| AI script analysis | `deepAI` | ✗ | ✓ |
| MediaPipe visual pass (Deep) | `deepMediapipe` | ✗ | ✓ (only if `useMediapipe` also on) |

- `detectDeadSpaces()` inside Auto/Deep respects `S.settings.useVAD`, `S.settings.useMediapipe`, and `S.settings.combineMode`
- WhisperX retake cuts absorbed during transcription step only if `S.settings.detectRetakes` is on
- All settings persist to localStorage via `saveSettings()`

## AI Chat
- Uses same provider/model as script analysis (S.aiProvider)
- Sends sentence-grouped SRT as context (not word-per-line)
- Parses AI responses for ACTION blocks (tolerant line-by-line parser)
- Actions: add_cut, add_highlight, seek, trim_before, trim_after, split, select_cut, deselect_cut
- Auto-apply toggle: applies all parsed actions immediately when ON
- Chat history maintained in S.chatHistory

## Trim Bar
- Horizontal bar between playback controls and timeline (id="trimBar")
- Track is 10px tall, centered/capped at 420px max-width — handles are 5×20px pills extending above/below via `overflow:visible`
- Elements: trimContext, trimContextLabel, trimContextDur, trimInLbl, trimOutLbl, trimTrack, trimFill, trimHL, trimHR, trimPlayPos
- `trimBefore()` — immediate: chops before playhead, updates segments + waveform + timeline
- `trimAfter()` — immediate: chops after playhead, updates segments + waveform + timeline
- `applyTrim()` — commits dragged trim handles to segments + waveform + timeline
- `resetTrim()` — restores full clip duration, calls `_applyTrimToSegments` + `sliceWaveforms` + `renderTimeline`

## Split at Playhead
- `splitAtPlayhead()` in `js/timeline/trim.js` — operates on `S.segments` only, NOT `S.clips`
- Finds segment where `video.currentTime` falls (with 0.05s margin from boundaries)
- Splits into segA (sourceStart→t) and segB (t→sourceEnd), both with correct timelineStart
- Recalculates timelineStart for all segments after the split, nulls waveformSlice on both halves
- Calls `buildPlaySegments` → `sliceWaveforms` → `renderTimeline`

## Critical Rules — Never Break These
1. **Nothing auto-removes** — detection only flags, user always applies manually
2. **saveHistory() BEFORE every destructive action** — delete, trim, apply cuts, split
3. **Playhead always last** — re-append `ph` element at end of every renderTimeline() call
4. **No hardcoded model strings** — always use `S.selectedModel?.id || S.orModel`
5. **S.cuts is the single source of truth** — never maintain separate silenceSegments or fillers arrays
6. **buildPlaySegments() after any cut/trim change** — otherwise playback won't reflect edits
7. **renderTimeline() only on zoom change or structural change** — never inside mousemove/timeupdate
8. **checkTokenLimit() before every OpenRouter fetch**
9. **config.json is source of truth for keys** — never hardcode API keys
10. **Never auto-fallback to WebM export** — WebM is manual only, errors show toast and stop
11. **clip.sourcePath required for transcribe/export** — always check it exists before calling pywebview API
12. **Video URLs must use HTTP** — never use file:// for video.src; always `http://localhost:8080/video?path=...`
13. **_applyTrimToSegments() after any trim change** — trimBefore/trimAfter/applyTrim/resetTrim all call it
14. **pywebview dialog constants** — use `webview.FileDialog.OPEN/FOLDER/SAVE` (not deprecated `webview.OPEN_DIALOG` etc.)
15. **sliceWaveforms() before renderTimeline()** — always in this order after any segment change; sliceWaveforms must NOT call drawTimelineWaveform (see Waveform draw ordering section)
16. **sliceWaveforms() after every segment structural change** — trim, apply cuts, undo/redo all call it before renderTimeline()

## rVFC Playback Loop
`requestVideoFrameCallback` fires on every decoded+rendered frame with `metadata.mediaTime` (more precise than `timeupdate`'s ~250ms polling). Pattern:
```js
let _rVFCHandle = null;
function _startRVFC() { _rVFCHandle = video.requestVideoFrameCallback(_onVideoFrame); }
function _stopRVFC()  { if (_rVFCHandle !== null) { video.cancelVideoFrameCallback(_rVFCHandle); _rVFCHandle = null; } }
function _onVideoFrame(now, metadata) {
  _rVFCHandle = video.requestVideoFrameCallback(_onVideoFrame); // re-register each frame
  const t = metadata.mediaTime;
  // ... segment boundary checks, skipCuts, loop, trimOut logic ...
}
// Feature detection
if (video.requestVideoFrameCallback) {
  video.addEventListener('play', _startRVFC);
  video.addEventListener('pause', _stopRVFC);
  video.addEventListener('ended', _stopRVFC);
} else {
  video.addEventListener('timeupdate', _onVideoFrameFallback);
}
```
Segment boundary threshold: `0.05s` (tight — rVFC is called every frame, not every 250ms).

## Pending Features

### Easy
- [x] AI chat: `add_marker` action — drop a named marker at a timestamp
- [x] AI chat: `delete_cut` action — remove cuts overlapping a time range
- [x] AI chat: `apply_cuts` action — trigger applyCuts() from chat
- [x] AI chat: `snap_gaps` action — trigger snapGaps() from chat
- [x] AI chat: `set_speed` action — change playback rate (SPEED: field)
- [x] AI chat: bulk commands — select_type, deselect_type, select_all, deselect_all

### Medium
- [ ] AI chat: richer context — pass segment durations, cut counts, total removable time alongside SRT so AI can reason about pacing
- [ ] AI chat: "find and cut" — AI searches word-level timestamps for a phrase, returns time range, adds cut automatically
- [ ] AI chat: cut review mode — AI explains each suggested cut before applying, user approves/rejects per cut
- [ ] AI chat: re-cut suggestions — feed current S.cuts to AI, ask it to adjust padding or merge nearby cuts

### Hard
- [ ] Speaker diarization — WhisperX has diarization hooks, wire them up; AI can then cut/filter by speaker
- [x] Script conforming — word-level LCS diff pre-computed client-side; AI receives [ON-SCRIPT/AD-LIB/SKIPPED] blocks with timestamps already mapped
- [ ] Frame sampling (PAID — skipped) — extract keyframes via ffmpeg, send to vision model for visual context

### Other
- [ ] AE plugin version (future project)

## Design System
```css
--bg: #08090f
--s1: #0d0f1a      /* panels, topbar */
--s2: #111320      /* cards, inputs */
--s3: #171a2e      /* hover states */
--s4: #1d2038      /* deep inset */
--b1: #1e2240      /* primary borders */
--b2: #242848      /* secondary borders */
--blue: #3d7fff    /* primary accent */
--blue-soft: #6b9fff
--blue-dim: rgba(61,127,255,0.13)
--accent: #c8ff47  /* trim handles only */
--red: #ff5461     /* cuts, delete, dead_air */
--teal: #38e8c8    /* captions, waveform, whisper */
--text: #e8eaf8
--text2: #7880a8
--text3: #3d4468
```
Fonts: Outfit (UI) + JetBrains Mono (mono/timecodes)
Target resolution: 1920×1080 at 100% browser zoom

## Hardware Context
- CPU: Ryzen 5 7600X
- GPU: RTX 4070 (use h264_nvenc for export, cuda for whisper)
- RAM: 16GB DDR5-6000
- OS: Windows 11
- faster-whisper model: base (GPU/CUDA)
