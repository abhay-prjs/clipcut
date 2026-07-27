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
# Replace working files with a snapshot (run from the repo root)
cp -r _backups/restore_2026-07-26/js ./js
cp _backups/restore_2026-07-26/clipcut.html .
cp _backups/restore_2026-07-26/clipcut.css .
cp _backups/restore_2026-07-26/serve.py .
cp _backups/restore_2026-07-26/waveform.worker.js .
```
(Snapshots older than 2026-07-26 predate the clipcut.html/clipcut.css rename and still contain ugc-editor-v2.html/editor.css instead — check the folder contents before copying.)

### When to create a new restore point (MANDATORY)
**Before starting any non-trivial change**, create a new dated snapshot:
```bash
mkdir -p _backups/restore_YYYY-MM-DD
cp -r js _backups/restore_YYYY-MM-DD/js
cp clipcut.html clipcut.css serve.py waveform.worker.js _backups/restore_YYYY-MM-DD/
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
Files live at the repo root (not under a `home_editor/` subdirectory — older
docs/backups predating the 2026-07-26 rename may still say otherwise).
```
├── clipcut.html            # HTML structure only
├── clipcut.css             # All styles
├── editor.js               # LEGACY MONOLITH — kept as backup, not loaded by HTML
├── waveform.worker.js      # OffscreenCanvas Web Worker — owns both waveform canvas contexts
├── serve.py                # pywebview desktop app — HTTP server + Python API (NO Flask)
├── whisper_server.py       # UNUSED — kept for reference only (Flask was removed)
├── config.json             # API keys and settings (never commit)
├── CLAUDE.md               # This file
└── js/                     # Split JS modules — loaded in order by clipcut.html
    ├── core/
    │   ├── logger.js       # jlog(), window.onerror, console.error override — LOAD FIRST
    │   ├── state.js        # S object, _clipRegistry, video/ph/tArea DOM refs — LOAD SECOND
    │   ├── history.js      # saveHistory(), undo(), redo(), _applySnapshot()
    │   └── project.js      # serializeProject(), saveProject(), openProject(), autosave + startup recovery
    ├── config/
    │   └── config.js       # loadConfig(), updateConfigStatus(), setAiSource()
    ├── captions/
    │   ├── captions.js     # caption list, overlay, exportCaptions(), styles
    │   └── whisper.js      # transcribeWithWhisper(), checkWhisperServer()
    ├── detection/
    │   ├── waveform.js     # extractAudioData(), drawWaveformModal(), drawTimelineWaveform(), sliceWaveforms(), _initWaveWorker IIFE
    │   ├── silence.js      # detectDeadSpaces(), detectFillers(), renderAllFindings(), applyCuts(), selectCut(), seekToCut()
    │   ├── linter.js       # runEditLint() — Tier-1 deterministic pre-apply checks (Part F2), renderLintFindings()
    │   └── ai.js           # AI chat, script analysis, model selector, token guard, provider switcher
    ├── media/
    │   ├── import.js       # loadClip(), selectClip(), loadClipFromPath(), openFileNative()
    │   ├── export.js       # startExport(), _doPywebviewExport(), _doWebMExport(), exportFrame()
    │   └── batch.js        # Batch export / "Process All" (Part F3)
    ├── playback/
    │   └── playback.js     # togglePlay(), rVFC loop, buildPlaySegments(), getPlayheadPosition(), sourceTimeToTimeline(), tc(), fmt(), clamp()
    ├── timeline/
    │   ├── trim.js         # trim handles, mousemove/mouseup drag, applyTrim(), trimBefore(), trimAfter(), splitAtPlayhead()
    │   └── timeline.js     # renderTimeline(), buildRuler(), snapGaps(), renderClipList(), handleTLClick(), zoomTL()
    ├── ui/
    │   ├── ui.js           # tools, modals, tabs, toast(), keyboard shortcuts, markers, loop, toggleSkipCuts()
    │   ├── settings.js     # loadSettings(), saveSettings(), toggleSetting(), setCombineMode(), updateSettingsUI()
    │   ├── templates.js    # UGC Templates CRUD/apply (Part F4)
    │   ├── textlayers.js   # "Add Text" freeform text layers (addTextLayer(), updateTextLayerOverlays(), etc.)
    │   ├── imagelayers.js  # "+ Image" sticker/image overlays (addImageLayer(), updateImageLayerOverlays(), etc.)
    │   └── colorfilters.js # Color filter presets (setColorFilter(), CSS preview approximation)
    └── main.js             # Init: renderTimeline(), loadConfig(), loadSettings(), FFmpeg shim, welcome toast

### Script load order in clipcut.html
```
js/core/logger.js       ← must be first (jlog used everywhere)
js/core/state.js        ← must be second (S, video, ph, tArea used everywhere)
js/config/config.js
js/captions/captions.js
js/captions/whisper.js
js/ui/textlayers.js
js/ui/imagelayers.js
js/ui/colorfilters.js
js/detection/waveform.js
js/detection/silence.js
js/detection/linter.js
js/detection/ai.js
js/media/import.js
js/media/export.js
js/media/batch.js
js/playback/playback.js
js/timeline/trim.js
js/timeline/timeline.js
js/core/history.js
js/core/project.js
js/ui/ui.js
js/ui/settings.js
js/ui/templates.js
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
- `list_video_files(folder_path)` → top-level-only scan (no subfolder recursion) for video files, returns sorted absolute paths — backs the "📁 Import Folder" button (`onImportFolderClick()` in `js/media/import.js`), which links every file in the folder via the normal `loadClipFromPath()` pipeline (real `sourcePath`, no upload)
- `pick_image()` → native image file picker (mirrors `open_file()`), backs the "+ Image" sticker/overlay button (`js/ui/imagelayers.js`)
- `probe_duration(source_path)` → ffprobe duration in seconds (for unplayable containers)
- `ping()` → loads transcription model (backend-dependent) + Silero VAD (lazy singletons), returns `{online, model, device, backend}`
- `transcribe(source_path)` → ffmpeg audio extract + transcription. Returns `{words, language, duration, backend}` + optional `retake_cuts` when backend=whisperx
- `detect_silence(source_path, threshold, min_duration, pad_before, pad_after)` → `{cuts, count, duration}`
- `vad_detect(source_path, threshold, min_speech_ms, min_silence_ms)` → `{speech_segments, cuts, count, duration}` — Silero VAD; inverts speech to produce dead_air cuts; same response shape as `detect_silence()`
- `mediapipe_detect(source_path, lip_threshold, min_speaking_ms, frame_skip)` → `{speaking_segments, cuts, count, duration}` — MediaPipe FaceMesh lip aperture; inverts speaking → dead_air cuts
- `get_whisper_config()` → returns `{whisper_backend, whisperx_model, whisperx_batch_size}` for Settings UI
- `save_whisper_config(backend, model, batch_size)` → writes to config.json + applies globals live (no restart needed), returns `{ok, backend, model, batch_size}`
- `export_video(..., text_style_json='{}', preview_height_px=0, caption_mode='static', text_layers_json='[]', image_layers_json='[]', transition_type='none', transition_duration=0.5, color_filter='none')` → opens `FileDialog.SAVE`, two-pass GPU encode, returns `{success, path}`. `text_style_json`/`preview_height_px`/`caption_mode`/`text_layers_json`/`image_layers_json` only matter when `burn_captions=True` — see `_generate_ass()` below and `js/ui/imagelayers.js`'s CLAUDE.md entry for `image_layers_json`. Thin wrapper: resolves the Save dialog then delegates to `_export_video_core(..., save_path, ...)`, the actual encode logic. **`_export_video_core()` checks `transition_type` first, before `burn_captions`** — if set (and not `'none'`) it routes to `_export_with_transitions()` instead, skipping ASS/text/image burn-in entirely for that export even if `burn_captions` was also true (logged as a warning) — see `_make_xfade_filter_complex()`'s docstring for why the two don't combine yet. `color_filter` (a preset name, resolved via `_color_filter_ffmpeg()`) applies regardless of which of the three export paths (fast/burn-in/transitions) is used — it's threaded into all of them the same way `aspect_filter`/`flip_filter` are
- `_export_with_transitions(...)` / `_make_xfade_filter_complex(segments, transition_type, transition_dur)` — chains kept segments with ffmpeg's `xfade`/`acrossfade` instead of a hard-cut concat. `XFADE_TYPES` maps UI-friendly names (`crossfade`,`wipeleft`,`wiperight`,`zoom`,`glitch`,`dissolve`) to ffmpeg's actual transition names (`glitch`→`pixelize` — xfade has no literal glitch effect). Each junction's duration is clamped to the shorter of its two adjacent segments' own durations (not compounded across a long chain — an edge case for pathologically short segments, not handled). Total output duration shrinks by `transition_duration` per junction, since adjacent clips overlap during the crossfade instead of playing back to back — `_export_with_transitions()` computes this before starting `_run_ffmpeg()`'s progress tracking. **Scope cut, not an oversight:** no ASS/text-layer/image-overlay support in this path — those assume a plain gapless concat via `seg_meta`, which doesn't account for xfade shrinkage, so mixing both would desync caption/text/sticker timing from the real output
- `export_video_batch_one(source_path, segments_json, save_path, ...)` → same params/encode core as `export_video()` (calls the same `_export_video_core()`) but takes `save_path` directly instead of opening a native Save dialog — backs batch export (`js/media/batch.js`), where N clips need one destination folder, not N dialogs
- `_generate_ass(captions, seg_meta, text_style, preview_height_px, out_w, out_h, caption_mode='static')` — builds a styled ASS subtitle file from `S.textStyle` (font/size/weight/color/stroke/background/position) for burn-in export, replacing the old plain-SRT path. `preview_height_px` (the live preview `<video>` element's `clientHeight`, sent from `_doPywebviewExport()`) scales font size/stroke thickness proportionally from "px in the browser preview" to "px in the actual exported frame" (`out_w`/`out_h`, from `_compute_output_dims()`); posX/posY are already percentages so they map directly. Position uses `\an2\pos(x,y)` (bottom-center anchor) per caption line, matching the live overlay's `left:X%/bottom:Y%`. **Known limitation:** `fontFamily` only renders correctly if that font is installed on the machine running ffmpeg — bundling an uploaded custom font via the `subtitles` filter's `fontsdir=` option is a separate follow-up, not done here. `caption_mode='word-highlight'` (Part F4) renders ASS karaoke (`\k` tags per word, from `cap['words']` — per-word timestamps preserved at transcription time in whisper.js, cleared by manual edit/split in captions.js since they'd no longer match) instead of static text; falls back to static per-caption if `words` is missing
- `list_templates()` / `save_template(name, template_json)` / `delete_template(name)` → CRUD over `templates.json` (next to config.json) — backs the Settings tab's UGC Templates section (`js/ui/templates.js`)
- `_compute_output_dims(source_path, aspect, aspect_mode)` / `_probe_dimensions(source_path)` — ffprobes source resolution and replicates `_aspect_filter()`'s crop/pad math to get the actual exported frame size (needed for ASS `PlayResX/Y`)
- `_hex_to_ass_color()` / `_parse_bg_color()` — CSS hex/rgba → ASS `&HAABBGGRR` color string conversion (note ASS reverses RGB byte order and inverts alpha vs CSS)
- `cancel_export()` → sets `_export_cancelled = True`
- `render_preview_proxy(source_path, segments_json)` → background nvenc render (p1, CQ32, downscaled to 1280px wide) of the kept segments only, concatenated gaplessly — not the final export, purely for the gapless scrub-anywhere preview proxy (see `js/playback/playback.js`'s PREVIEW PROXY section). Returns `{success, path, duration}`. Reuses `_run_ffmpeg()`'s progress reporting via the new `progress_fn` param (`_push_progress(pct, js_fn=...)`), routed to `_onProxyProgress(pct)` instead of the export modal's `setProgress(pct,label)`. Deletes the previous proxy temp file (`_last_proxy_path`) before rendering a new one — no cancel button in v1, unlike `cancel_export()`
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
S.proxyUrl         // preview proxy HTTP URL once rendered, else null
S.proxyActive      // true while video.src IS the proxy (video.currentTime is proxy-space, not source-space)
S.proxyDirty       // true if segments/cuts changed since the proxy was rendered — set by buildPlaySegments()
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
S.captionMode      // 'static' | 'word-highlight' (karaoke ASS export only) — see setCaptionMode()
S.safeZonesVisible // platform UI safe-zone guide overlay toggle (9:16 only) — see toggleSafeZones()
S.textLayers       // [{id,text,start,end,style}] — freeform "Add Text" objects, independent of captions. style is the same shape as S.textStyle but per-object (js/ui/textlayers.js)
S.selectedTextLayerId // currently selected text layer, drives the Text inspector tab
S.imageLayers      // [{id,path,url,start,end,style:{posX,posY,posZ}}] — sticker/image overlays (js/ui/imagelayers.js). Exported via real ffmpeg overlay compositing, NOT the ASS pipeline (ASS is text-only)
S.selectedImageLayerId // currently selected image layer — mutually exclusive with S.selectedTextLayerId, both share the Text inspector tab
S.flipH / S.flipV  // video flip state
S.colorFilter      // 'none'|'vivid'|'warm'|'cool'|'bw'|'vintage'|'moody' — CapCut-style one-tap color grade preset (js/ui/colorfilters.js). Preview is a CSS filter: approximation; export applies the real ffmpeg eq/colorbalance filter (COLOR_FILTER_PRESETS in serve.py) server-side
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

## Text Layer Object Shape
```js
{
  id: crypto.randomUUID(),
  text: 'Text',          // freeform content, user-edited
  start: 0.00,           // seconds in source file
  end: 0.00,             // seconds in source file
  style: {                // same shape as S.textStyle, but per-object — NOT shared like captions
    fontSize: 32, fontFamily: 'Outfit', fontWeight: '800', color: '#ffffff', background: '',
    strokeEnabled: true, strokeThickness: 2, strokeColor: '#000000',
    posX: 50, posY: 50, posZ: 1,   // percentage of frame, middle-center anchored (unlike captions' bottom-center)
  }
}
```

## Image Layer Object Shape
```js
{
  id: crypto.randomUUID(),
  path: 'C:\\...',        // absolute local file path — used directly as an ffmpeg -i input on export
  url: 'http://localhost:8080/video?path=...',  // HTTP streaming URL for the live preview <img>
  start: 0.00,            // seconds in source file
  end: 0.00,              // seconds in source file
  style: { posX: 50, posY: 50, posZ: 1 }  // percentage of frame, middle-center anchored, posZ = scale — no font/color/stroke, content is a fixed image
}
```

## Segment Object Shape
```js
{
  id: crypto.randomUUID(),
  sourceStart: 0.0,     // position in original file
  sourceEnd: 0.0,
  timelineStart: 0.0,   // position on timeline — see _relayoutSegments() below
  duration: 0.0,        // sourceEnd - sourceStart
  waveformSlice: null   // assigned by sliceWaveforms()
}
```

**`timelineStart` layout rule — `_relayoutSegments()` (`js/timeline/trim.js`):**
the single place that decides where each segment sits on the timeline.
- `S.snapped === true` → contiguous cursor layout, no gaps (matches the
  exported video, which is always a gapless concat of kept segments)
- `S.snapped === false` → each segment's `timelineStart = sourceStart`, so a
  removed cut leaves a real gap — `renderTimeline()` draws it as a hatched
  `.tl-gap` block (gap hatching)

Every segment-mutating function (`applyCuts()`, `snapGaps()`,
`splitAtPlayhead()`, `deleteSegment()`, `_applyTrimToSegments()`) calls
`_relayoutSegments()` after mutating `S.segments` instead of hand-rolling its
own cursor math — do not reintroduce a local cursor loop in a new one.

**`gaplessSegmentMeta()` (`js/playback/playback.js`)** — returns
`S.segments`-shaped data with a contiguous cursor layout regardless of the
live `S.snapped` state. Anything computing caption-sync timestamps for
export/burn-in (`exportCaptions()` in captions.js, `_doPywebviewExport()`'s
`segMeta` in export.js) **must** use this, never `S.segments[].timelineStart`
directly — the exported video has no gaps even when the on-screen timeline
is currently showing gap-hatched cuts pre-snap.

## Key Functions — by file
**js/core/state.js** — S object, _clipRegistry, video/ph/tArea

**js/core/history.js**
- `saveHistory()` — call BEFORE every destructive action. Snapshots: clips, captions, trimIn, trimOut, cuts, segments, markers, aspect, aspectMode, textStyle. No-ops while `_historySuppressed` is true.
- `withHistoryBatch(async fn)` — snapshots once, suppresses nested `saveHistory()` calls for the duration of `fn`, restores in `finally`. Used by `runAutoMode()` so Auto/Deep Mode's whole chain (transcribe → detect → AI analysis, each of which also calls `saveHistory()` when triggered standalone) is one undo checkpoint, not one per internal step.
- `undo()` / `redo()` — two-stack undo/redo system. Every action that mutates `S.cuts`/`S.captions`/`S.segments` must call `saveHistory()` first — `detectDeadSpaces`, `detectFillers`, `analyzeAudio`, `runAIScriptAnalysis`, `runAIAnalysis`, `toggleCutSelected`, `toggleCutSkip`, `toggleScriptPart` all do. Skipping this on any mutating action is the bug class that made Undo appear to "skip" straight past a manual edit back to an earlier state — the popped snapshot is always whatever the *last* `saveHistory()` call captured, so a silent mutator leaves stale snapshots on top of the stack.

**js/core/project.js**
- `serializeProject()` — builds a `.ccproj`-shaped object: clip sourcePaths + per-clip segments/cuts/captions/markers, aspect/aspectMode/textStyle, zoom. Skips clips without `sourcePath` and `waveformData` (re-extracted on load)
- `saveProject()` / `openProject()` — native Save/Open dialogs via `pywebview.api.save_project()`/`open_project()`
- `_loadProjectData(data)` — shared rebuild-and-select logic used by `openProject()` and autosave recovery
- `_startAutosave()` — 30s `setInterval` calling `pywebview.api.autosave_project()`
- `_checkAutosaveRecovery()` — called once at startup; offers to restore a found autosave via `confirm()`

**js/config/config.js**
- `loadConfig()` — fetches config.json, populates S.orKey, S.orModel etc.
- `updateConfigStatus()` — updates config status badge in UI

**js/captions/captions.js**
- `exportCaptions(fmt)` — SRT/VTT export with post-cut timestamp remapping; `fmt` is `'srt'` or `'vtt'`
- `updateCaptionList()`, `updateCaptionOverlay()` — caption UI
- `_startEditWord(span)` — double-click a transcript-tab caption block to edit its text. Enter with the cursor placed mid-text (not on the auto-select-all state) **splits the block into two captions** at that character position — time split is a character-length proportion of the original span's duration (word-level timestamps don't survive chunking, so this is a proxy, not frame-exact). Enter with everything still selected, or at a text edge, falls through to the old commit-on-Enter behavior. Escape reverts, blur commits.
- `_mergeCaptionsIntoStrip(caps)` — merges adjacent captions (gap <0.3s) into a solid no-text strip; only used by the timeline caption track below ~15px/s zoom (readability fallback, not editable)

**js/captions/whisper.js**
- `transcribeWithWhisper()` — calls pywebview.api.transcribe(sourcePath), requires clip.sourcePath. Each `S.captions` entry also gets a `words: [{text,start,end}]` array (the chunk's constituent words, individually timestamped) — used by word-highlight karaoke ASS export (`_generate_ass` in serve.py); manual edit/split in captions.js's transcript editor deletes `.words` on the affected caption(s) since the text no longer matches it 1:1
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

**js/detection/linter.js** — Tier-1 deterministic edit linter (Part F2)
- `runEditLint()` — checks currently *selected* (pending, not-yet-applied) cuts against 6 rules: mid-word cut, audio-pop risk, orphan sliver, machine-gun pacing, sentence amputation, unflagged dead start/end. Deliberately pre-apply, not post-apply — once `applyCuts()` runs, cuts no longer exist as S.cuts objects to fix/merge, only committed S.segments. Populates `S_lintFindings`, called from the "🔍 Check Edit" button in the Silence tab (right before "Apply Selected Cuts")
- Each finding has an optional `fix` closure — mid-word/audio-pop snap the cut edge (word boundary or nearest RMS valley within ±0.15s), orphan-sliver/pacing call the existing `mergeCuts()`, dead-start/end push a new `dead_air` cut. Sentence amputation is flag-only (content judgment, no safe auto-fix). Every fix calls `saveHistory()` first and re-runs `runEditLint()` to refresh the list
- `renderLintFindings()` — reuses the `.sil-result-item` card style from `_buildCutCard()`

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
- `runTier2EditReview()` — Tier-2 AI edit review (Part F2): sends the *planned* edit (kept-segment durations, the full cut list with type/selected/reason, script-transcript diff if a script was pasted) and asks for review only — pacing verdict, hook check, meaning-changing cuts, wrong-retake-kept — never new cut detection. Reuses `_aiScriptFetch()` for provider routing/retry and the chat panel's existing `_parseActionBlocks()`/`appendChatMsg()` action-card UI for any concrete fixes the model suggests, so "approve/reject per suggestion" needed no new UI. Gated behind Deep Mode's new `S.settings.deepEditReview` (opt-in, default off — extra model call on top of `deepAI`) in `runAutoMode(true)`, and separately triggerable via the AI Tools tab's "✦ Tier-2 Edit Review" button

**js/media/import.js**
- `loadClip(file)` — loads a File object into the editor
- `selectClip(id)` — loads clip into preview, sets S.current + S.selectedClipId. Skips video.src for browserPlayable===false
- `loadClipFromPath(sourcePath)` — native import path. Builds HTTP URL, probes duration via ffprobe if browser can't decode
- `onUploadZoneClick()` — routes to openFileNative() in pywebview, fileInput.click() in browser
- `openFileNative()` — calls pywebview.api.open_file(), passes path to loadClipFromPath()
- `onImportFolderClick()` — "📁 Import Folder" button (Media tab, pywebview only). `pick_folder()` → `list_video_files()` → `loadClipFromPath()` for every file found (top-level only, no subfolder recursion) — links a whole folder of clips in one go via the same native-path pipeline as a single Open File import

**js/media/export.js**
- `startExport()` — routes to pywebview export (native path) or `_doWebMExport()` (manual WebM, browser-only, no ffmpeg)
- `_doPywebviewExport()` — export via pywebview API (no upload/download, direct ffmpeg). When burn-in captions is on, also sends `S.textStyle` + the preview `<video>`'s `clientHeight` so `_generate_ass()` can scale the style to the real output resolution
- `_onExportProgress(pct)` — global, called by Python via evaluate_js() during export
- `exportFrame()` — exports current frame as PNG
- `setExportTransition(type)` / `syncExportTransitionDur(v)` — Export modal's Transitions dropdown (None/Crossfade/Wipe Left/Wipe Right/Zoom/Glitch/Dissolve) + duration slider, sets `_exportTransitionType`/`_exportTransitionDur` and shows the "not combined with burn-in" warning whenever a transition other than `'none'` is picked

**js/ui/colorfilters.js — Color filter presets**
- `setColorFilter(name, btn)` — sets `S.colorFilter`, applies `_applyColorFilterPreview()` (sets `video.style.filter` from the `COLOR_FILTER_CSS` table). Swatch buttons live in the Video inspector tab, next to Flip
- `_applyColorFilterPreview()` — re-called after `selectClip()` and `_applySnapshot()` (undo/redo) so the CSS filter survives a `video.src` swap
- **Export applies the real preset server-side** — JS only ever sends the preset *name* (`S.colorFilter`) as the last `export_video`/`export_video_batch_one` param, never a raw filter string; `_color_filter_ffmpeg()` (serve.py) maps it to the actual ffmpeg `eq`/`colorbalance`/`hue` filter chain (`COLOR_FILTER_PRESETS`), applied consistently across all three export paths — fast path (per-segment, before the `-c copy` concat), `_export_burnin`, and `_export_with_transitions`. CSS and ffmpeg don't compute saturation/contrast identically, so the preview is an approximation, not pixel-identical to the export

**js/media/batch.js — Batch export / "Process All" (Part F3)**
- `openBatchModal()` — populates the clip checklist + template dropdown, opens `#batchModal`
- `runBatchExport()` — `pick_folder()` once, then sequentially per checked clip: `selectClip()` → optional `applyTemplate()` → optional `runAutoMode(deep)` → `runEditLint()` (advisory, doesn't block — batch is meant to run unattended) → `pywebview.api.export_video_batch_one()`. Per-clip status renders live in the modal via `_setBatchStatus()`. Each clip fully swaps live state (S.segments/S.cuts/S.captions) through the existing `selectClip()` per-clip persistence (bug #22) — there's no separate batch job/clip-state model, it reuses the same state the interactive UI uses
- `cancelBatch()` — sets a flag checked between clips (not mid-encode) — the current clip's export still finishes
- `_batchOutputName(clip, templateName)` — `{clipName}_{template|'clipcut'}_{date}.mp4`, sanitized
- **Known gaps:** no per-clip template override (one template applies to the whole batch run); `selectClip()` swap is followed by a fixed `setTimeout(300ms)` rather than an awaited completion signal — consistent with `runAutoMode()`'s existing style of fixed waits between steps, not new fragility introduced here; not runtime-verified end-to-end for the same reason as the proxy render and templates work (no way to launch the actual pywebview GUI in this environment)

**js/playback/playback.js**
- `togglePlay()`, `skipTime()`, `setSpeed()`, `setVolume()` — all branch on `S.proxyActive` early (proxy has no gaps to route skip/restart logic around)
- `buildPlaySegments()` — derives S.playSegments from S.segments for virtual playback. Also sets `S.proxyDirty=true` — anything that reaches this function changed segments/cuts, so an existing rendered proxy no longer matches
- `getPlayheadPosition(overrideSrcTime)` — returns pixel position of playhead on timeline. `overrideSrcTime` is used during proxy playback (see below) since `video.currentTime` there is proxy-space, not source-space — omit for normal virtual playback
- `sourceTimeToTimeline(t)` — maps source timestamp to timeline position; returns null if inside a cut
- `gaplessSegmentMeta()` — S.segments-shaped data with a contiguous cursor layout, independent of the live `S.snapped` state; both export caption-sync and the preview proxy's source↔proxy time mapping use this instead of trusting `S.segments[].timelineStart` directly (see the Segment Object Shape section above)
- `tc(t)`, `fmt(t)`, `clamp(v,mn,mx)` — utility functions used across all modules

**js/playback/playback.js — PREVIEW PROXY (Part A3 Option 3)**
- `renderPreviewProxy()` — calls `pywebview.api.render_preview_proxy()` with the kept segments (source time), shows progress via `_onProxyProgress(pct)` on the `#proxyBtn` label, then `_enterProxyMode()` on success
- `_sourceToProxyTime(t)` / `_proxyToSourceTime(t)` — map between source-file time and the proxy's own (gapless) time, using `gaplessSegmentMeta()`'s cursor layout — the same layout the rendered proxy file actually has, regardless of the live `S.snapped` display state
- `_enterProxyMode()` / `_exitProxyMode()` — swap `video.src` between the proxy and the live source file, preserving playhead position across the swap via the mapping functions above
- `toggleProxyMode()` — the `#proxyBtn` click handler: exits if active, re-enters an existing non-dirty proxy without re-rendering, otherwise triggers a fresh render
- The rVFC loop (`_onVideoFrame`/`_onVideoFrameFallback`) branches on `S.proxyActive` at the very top — when true, skips all segment-boundary/skip-cut jump logic entirely (the proxy file has no gaps to skip) and just syncs UI, passing `_proxyToSourceTime(t)` as the `overrideSrcTime` to `updateTimecode()`/`updatePlayhead()`/`updateCaptionOverlay()`/`updateTrimPlayhead()`/`updateTranscriptHighlight()` so caption/segment lookups (keyed by source time) still resolve correctly
- `selectClip()` (import.js) and `_applySnapshot()` (history.js, undo/redo) both reset all three proxy state fields — the rendered proxy belongs to whichever clip/edit-state was active when it was made, so switching clips or undoing invalidates it outright rather than leaving a stale PROXY/LIVE state pointing at the wrong file
- **Known limitation, not done in v1:** no Cancel button for an in-progress proxy render (unlike `cancel_export()`); no automatic proxy re-render on dirty, the user re-triggers via the button

**js/timeline/trim.js**
- `updateTrimUI()` — updates trim bar display (handles cut-mode vs clip-mode)
- `applyTrim()` — commits trim bar handles: calls `_applyTrimToSegments` → `sliceWaveforms` → `renderTimeline`
- `resetTrim()` — restores full clip duration
- `trimBefore()` — immediately chops everything before playhead: sets S.trimIn, calls `_applyTrimToSegments` → `sliceWaveforms` → `renderTimeline`
- `trimAfter()` — immediately chops everything after playhead: sets S.trimOut, calls `_applyTrimToSegments` → `sliceWaveforms` → `renderTimeline`
- `splitAtPlayhead()` — splits selected clip at current playhead position
- `_applyTrimToSegments(tIn, tOut)` — clamps S.segments to [tIn, tOut], recalculates timelineStart offsets
- `_bindCutDrag(el, cut)` — on-timeline cut edge-resize/move drag (§C6): edges resize, center moves, snaps to word/cut/segment/playhead/whole-second edges, Alt=no-snap, Shift=0.25× fine
- `_bindCaptionDrag(el, cap)` — same edge-resize/move drag grammar applied to a caption block on the timeline caption track, so retiming a caption doesn't require the transcript tab. Clamps directly against neighboring captions (`_captionNeighborBounds`) rather than width-clamping, since captions must stay gapless/non-overlapping. Not bound on the low-zoom merged strip (nothing to drag — see `_mergeCaptionsIntoStrip` in captions.js)
- `_bindSegmentDrag(el, seg)` — edge-only drag (F1 universal trim grammar, segments): slip-trims `seg.sourceStart`/`sourceEnd` by dragging its left/right edge, clamped by `_segmentNeighborBounds()` (the adjacent kept segment's own range — can't eat into content another segment owns, but *can* extend into an adjacent gap, un-cutting part of it). Center-drag ("move") is deliberately out of scope — only click-to-select lives there. "Ripple mode" from the original spec needed no new state: `_relayoutSegments()` (already called after every mutation) ripples downstream segments automatically when `S.snapped`, and stays gap-preserving when not — so toggling Snap Gaps *is* the ripple toggle. Unlike `_bindCutDrag`/`_bindCaptionDrag`, live-nudges every existing segment element's style directly during the drag (`document.querySelector('.tl-clip[data-seg-id=...]')`) instead of touching just one — ripple can move all of them — and deliberately never calls `renderTimeline()` mid-drag (that would destroy the dragged element and its active `setPointerCapture()` on the very first `pointermove`)

**js/timeline/timeline.js**
- `renderTimeline()` — redraws entire timeline. ALWAYS re-appends playhead (`ph`) as last child of `tracksInner` at end
- `buildRuler(totalDur, totalW, zoom)` — renders ruler ticks and markers
- `snapGaps()` — recalculates timelineStart for all segments to close gaps
- `renderClipList()` — renders `#clipList` as a `.clip-grid` of thumbnail cards (duration badge, hover delete calling `deleteClipById(id)`)
- `handleTLClick(e)` — maps timeline pixel position to source time via segment offsets (NOT raw `x/zoom`); critical after trim ops
- `zoomTL(d)` — adjusts S.zoom and re-renders

**js/timeline/trim.js**
- `splitAtPlayhead()` — splits the segment containing `video.currentTime` into two segments in `S.segments` (NOT S.clips); rebuilds timelineStart, calls `buildPlaySegments` → `sliceWaveforms` → `renderTimeline`

**js/ui/ui.js**
- `toast(msg)` — shows toast notification
- `switchTab(name)` — switches left panel tab; matches `.panel-tab` elements by `data-tab` attribute (not position); calls `_loadWhisperConfigFromServer()` when switching to 'settings'
- `switchInspTab(name)` — switches right-panel inspector tab (Video/Speed/Captions); matches `.insp-tab`/`.insp-panel` by `data-insp` — deliberately separate from `switchTab()`, do not merge them or give inspector tabs the `.panel-tab` class
- `syncTopbarClipName()` — writes `S.current?.name` (or "No clip loaded") into `#topbarClipName`; call after any clip select/delete/undo-restore
- `openModal(id)` / `closeModal(id)` — modal open/close
- `deleteClip()` — deletes `S.selectedClipId||S.current`; `deleteClipById(id)` sets `S.selectedClipId=id` first then delegates to it (used by the Media grid's hover delete icon)
- `setAspect()`, `addMarker()`, `toggleLoop()`, `toggleSkipCuts()`, `toggleScriptPart()`, `toggleCutSkip()`
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

**js/ui/templates.js — UGC Templates (Part F4)**
- `refreshTemplateList()` — calls `pywebview.api.list_templates()`, populates `#templateSelect`. Called on every switch to the Settings tab (`switchTab()` in ui.js), same lazy pattern as `_loadWhisperConfigFromServer()`
- `saveCurrentAsTemplate()` — bundles the current aspect/aspectMode/textStyle/captionLayout/captionMode/export-preset/a subset of S.settings (see `_buildTemplateFromCurrent()`) under the name typed into `#templateNameInput`, via `pywebview.api.save_template()`
- `applyTemplate(name)` — `saveHistory()` then applies every field in the named template onto live state, re-syncing every UI control that isn't already wired to its own live-apply setter. Templates deliberately don't include the spec's "text layers" (hook slot, etc.) — ClipCut has no freeform text-layer feature yet to apply that to
- `_syncTextStyleUI()` — re-syncs the Caption Style panel's DOM controls from `S.textStyle` after a template changes it directly (bypassing the individual `setCaptionFont()`/`syncFontSize()`/etc. setters, which each only touch their own control). **Known gap:** the Weight/Layout buttons have no ids (inline `onclick(value,this)` only) so their `.primary` highlight isn't re-synced here — `S.textStyle.fontWeight`/`S.captionLayout` are still correctly applied to the live overlay and export, this is a settings-panel cosmetic gap only
- `deleteTemplateUI(name)` — confirms, calls `pywebview.api.delete_template()`, refreshes the list

**js/ui/textlayers.js — "Add Text" freeform text layers**
- `addTextLayer()` — creates a new layer at the playhead (default 3s duration, clamped to clip duration), pushes to `S.textLayers`, selects it, switches to the Text inspector tab. Each layer owns its own `style` object (same shape as `S.textStyle`, but per-object — NOT shared like captions, since these are independent on-screen objects)
- `updateTextLayerOverlays(srcTime)` — pool-manages one DOM element per layer in `#videoContainer` (unlike the single `captionOverlay` div, several text layers can be visible at once); called from the rVFC loop (`_onVideoFrame`/`_onVideoFrameFallback` in playback.js, both proxy and normal branches) alongside `updateCaptionOverlay()`. Fully removes (not just hides) overlay elements for layers no longer in `S.textLayers` at all, so add/delete/undo cycles don't leak DOM nodes
- `selectTextLayer(id)` / `renderTextLayerInspector()` — selection sync; the Text inspector tab (4th tab alongside Video/Speed/Captions) shows the selected layer's text content + a font/size/color/stroke/position style panel mirroring the Captions tab's own controls, but bound to the selected layer's `style`, not `S.textStyle`
- Timeline: `#textLayerTrack` (lane above Video — text/image tracks composite on top of the video frame, so they sit above it in the stack, not buried below Captions), one block per layer via `_bindTextLayerDrag()` (`js/timeline/trim.js`) — same edge-resize/move grammar as cuts/captions/segments, but layers can freely overlap each other in time (independent objects, not a running transcript), so the only clamp is the clip's own `[0, duration]` bounds
- **On-canvas manipulation**: dragging the layer directly in the preview moves it (`_bindLayerOverlayDrag()`, shared with image layers via `_layerKindAPI(kind)`), and a corner handle scales it (`_bindLayerScaleHandle()`) — both in `js/ui/textlayers.js`, both looking the layer up fresh by id each event rather than closing over the object (undo/redo replaces the array wholesale via JSON round-trip, so a captured reference would go stale same-id-different-object). Dragging snaps to 0/50/100% on each axis independently within a small threshold (`_applyLayerSnap()` — a magnet, not a hard grid) and shows a center guide line (`#layerGuideV`/`#layerGuideH`); holding Alt bypasses snapping for free placement. The X/Y/Z sliders in the inspector and the on-canvas drag both write the same `layer.style` fields, so either stays in sync with the other
- **Export**: `_generate_ass()` (serve.py) takes an added `text_layers` param — `_generate_text_layer_dialogue()` emits one ASS Dialogue line per layer with every style property as an inline override (`\fn\fs\b\c\3c\bord`), `\an5\pos(x,y)` (middle-center, matching the preview overlay's `translate(-50%,-50%)`), on `Layer: 1` (above captions' `Layer: 0`). Threaded through the whole export chain (`export_video`/`export_video_batch_one`/`_export_video_core`/`_export_burnin`) as `text_layers_json`. **"Add Text" only reaches the export through the ASS burn-in path** — `_doPywebviewExport()`/`runBatchExport()` both force `burn_captions` on when `S.textLayers.length>0`, even if the user never toggled Burn-in Captions, so text doesn't silently vanish from the export
- Persists per-clip via `selectClip()` (same pattern as cuts/captions/markers) and in undo/redo snapshots (`_makeSnapshot()`/`_applySnapshot()`) — NOT included in UGC Templates (`_buildTemplateFromCurrent()`), since templates are style/settings presets, and text layers are actual per-clip content, not something that should inject clip A's specific text into clip B
- **Known gap, v1 scope:** no live per-word or animated text (static per-layer style only); scale handle is a single corner (uniform scale only, no per-axis stretch or rotation)
- `layer.hidden` (bool, default false) — eye-icon toggle in the outliner row (`toggleTextLayerHidden(id)`/`toggleImageLayerHidden(id)`). Not a `saveHistory()` checkpoint (same convention as the style setters — only add/delete are undo-tracked). A hidden layer is skipped by the preview overlay AND excluded from `text_layers_json`/`image_layers_json` at export time (`js/media/export.js`, `js/media/batch.js` both filter `!l.hidden` before building those payloads and before deciding whether to force `burn_captions` on) — it's a real hide, not just a view setting that reappears in the output

**js/ui/imagelayers.js — "+ Image" sticker/image overlays**
- `addImageLayer()` — calls `pywebview.api.pick_image()` (native picker), creates a layer at the playhead. Much lighter than text layers — just `{posX,posY,posZ}`, no font/color/stroke, since the content is a fixed image file rather than something styled in-app
- `updateImageLayerOverlays(srcTime)` — same pool-managed-`<img>`-per-layer pattern as `updateTextLayerOverlays()`, wired into the same rVFC call sites right alongside it
- Timeline: `#imageLayerTrack` (lane below Text, both above Video), `_bindImageLayerDrag()` (`js/timeline/trim.js`) — identical grammar to `_bindTextLayerDrag()`, kept as a separate function since image layers select/render through their own state, not the text-layer functions
- **On-canvas drag/scale/snap** — same `_bindLayerOverlayDrag()`/`_bindLayerScaleHandle()`/`_applyLayerSnap()` in `js/ui/textlayers.js` as text layers (see that section), just invoked with `kind:'image'`. The overlay DOM is a wrapper `<div class="image-layer-overlay">` containing the `<img>` plus a `.layer-resize-handle` child — an `<img>` can't have DOM children, so unlike text layers the preview node is a div, not the image element itself
- **Shares the "Text" inspector tab** with text layers rather than adding a 5th tab — `#textLayerEmpty` is a combined empty state ("+ Add Text" / "+ Add Image" side by side) shown only when neither a text nor image layer is selected (`_updateLayersEmptyState()` in textlayers.js, called by both render functions); selecting one layer type clears the other's selection (`S.selectedTextLayerId`/`S.selectedImageLayerId` are mutually exclusive) so only one editor block shows at a time
- **Export is NOT the ASS pipeline** (ASS is text/subtitle-only, can't carry a raster image) — `_make_filter_complex()` (serve.py) gained an `image_layers` param: each layer becomes its own ffmpeg `-i` input, composited via the `overlay` filter with `enable='between(t,start,end)'` gating its visible window, chained after the ASS `subtitles=` stage. Forces the multi-input filter_complex path even for a single segment (the plain single-segment `-vf` chain has no way to take multiple inputs). Same "force burn_captions on if any exist" pattern as text layers, threaded as `image_layers_json` through the full export chain. JS flattens `layer.style.{posX,posY,posZ}` to top-level fields before sending — `_make_filter_complex()` reads them directly, not nested
- `pick_image()` (serve.py) — native image picker; previews stream through the same generic `/video?path=` file server as video clips (its mime map gained png/jpg/jpeg/gif/webp — the endpoint already streamed arbitrary local files, it just needed the right Content-Type for browsers to render an `<img>`)
- Persists per-clip and through undo/redo, same pattern as text layers; also excluded from UGC Templates for the same reason (actual per-clip content, not a style/settings preset)

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
Reskinned to an Apple-style dark shell (2026-07-26 session), then restructured to a CapCut-style layout scoped to only the features ClipCut actually has:
- **Topbar:** Logo (no dropdown) · icon-only `.action-cluster` pill (Import/Undo/Redo/Mark/Delete, tooltips via `title=`) · centered `#topbarClipName` readout (live clip name, synced by `syncTopbarClipName()` in `js/ui/ui.js` — called from `selectClip()`, `deleteClip()`, and `_applySnapshot()` undo/redo restore) · config status pills (icon-only ✓/✗, no text) · timecode · AI Chat icon · Settings gear · Export button (label kept)
- **Left panel:** horizontal `.panel-tabs` replaced by a vertical `.icon-rail` (Media/Captions/Silence/AI Tools, icon above label). `switchTab(name)` in `js/ui/ui.js` matches on `t.dataset.tab===name` (NOT positional index — do not add/reorder `.panel-tab` elements without keeping `data-tab` attributes in sync)
- **Media tab:** slim `.upload-zone.slim` "+ Import Media" button (still calls `onUploadZoneClick()`, still drag-droppable via the body-level handler) · Auto/Deep pipeline buttons (`id="autoModeBtn"`/`id="autoModeDeepBtn"` — **required**, `runAutoMode()` reads `btn.textContent` with no null guard) · `#clipList` is now a `.clip-grid` (2-col thumbnail cards with duration badge + hover delete via `deleteClipById(id)`, not a row list)
- **Silence tab:** "✦ Open AI Silence Studio" button (`openSilenceModal()`) added at top — real modal, backed by `analyzeAudio()`/`runAIAnalysis()`/`applySilenceRemoval()`
- **Captions tab:** unchanged content. Do NOT add a modal-launcher button here — `openCaptionAI()` was removed because it was dead (just toasted "use the Transcribe button"); `generateAICaptions()` is a legacy stub kept only because the (unreachable) `#captionModal`'s Generate button still calls it
- **Right panel (inspector):** flat stacked sections replaced by tabs — `.insp-tabs`/`.insp-tab`/`.insp-panel`, switched via `switchInspTab(name)` (namespaced separately from `switchTab()` on purpose — they used to share `.panel-tab` and each call was wiping the other's active state)
  - **Video** tab: Clip Info (now wrapped in `.info-card`) + Flip + Snapshot Frame
  - **Speed** tab: Rate select
  - **Captions** tab: full caption style block (font/weight/layout/size/color/stroke/position)
  - **Text** tab: shared by two independent object types — "Add Text" freeform text layers (content textarea + per-layer font/weight/size/color/stroke/position, `js/ui/textlayers.js`) and "+ Image" sticker/image overlays (preview thumbnail + position/scale only, `js/ui/imagelayers.js`). Selecting one clears the other's selection; combined empty state offers both "+ Add Text" and "+ Add Image" when nothing is selected
  - **Export**: the persistent footer block was removed (2026-07-26) — it duplicated the topbar Export button (Export Video) and the left-panel Captions tab's SRT/VTT buttons, and appeared under every insp-tab regardless of which was active, reading as if export lived in every tab. Export is now reached only via the topbar `⬆ Export` button → `#exportModal` (format/preset/burn-captions/aspect options). SRT/VTT export stays in the left-panel Captions tab only. Snapshot Frame moved into the Video insp-tab (still calls `exportFrame()`).
- **Timeline toolbar:** flat row of individual pills (Select/Trim/Split/Trim Before/Merge Cuts/Trim After/Silence, then Snap/Snap Gaps) — no longer grouped in a boxed tray
- **Playback bar:** wrapped in a floating `.pb-pill` capsule instead of a flat full-width strip. `#proxyBtn` (LIVE/PROXY toggle, `toggleProxyMode()`) sits right after Skip Cuts — see the PREVIEW PROXY section under js/playback/playback.js above
- **Export modal:** Save folder row removed (native Save dialog handles folder+filename)

## Tab Structure — Left Panel (icon rail)
**Media tab:** slim import button, Auto/Deep buttons, 📦 Process All (Batch) button (`openBatchModal()`, see `js/media/batch.js`), clip library grid (2-col thumbnails)
**Captions tab:** Load Whisper Model button, words-per-cap stepper, strip punctuation toggle, transcribe button, caption list
**Silence tab:** AI Silence Studio modal launcher, threshold/duration/padding sliders (cached to localStorage), Run AI Silence Removal, Detect Dead Spaces, silence findings list (dead_air + silence types only), Edit Check (🔍 Check Edit → `runEditLint()`, see `js/detection/linter.js`) directly above Apply Selected Cuts
**AI Tools tab:** provider pills (OpenRouter / Ollama), model selector, ping status, script textarea, Analyse Script, Detect Fillers, Tier-2 Edit Review (`runTier2EditReview()`), findings list (filler + retake + weak + highlight types), Apply Selected Cuts, AI Chat panel
**Settings tab (⚙, gear icon in topbar, not in the rail):** Transcription backend (faster-whisper/WhisperX pills, model select, batch size slider, retake detection toggle) · Detection Pipeline (VAD toggle, MediaPipe toggle, combine mode AND/OR, VAD tuning sliders, MediaPipe tuning sliders) · Auto Mode Steps (checkboxes per step) · Deep AI Mode Extras (AI analysis, Tier-2 edit review, MediaPipe pass) · UGC Templates (`js/ui/templates.js` — save/apply/delete named presets) · Reset to Defaults

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
| Tier-2 AI edit review | `deepEditReview` | ✗ | ✓ (opt-in, default off — runs after `deepAI` so it reviews AI-suggested cuts too) |

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
Solid, flat dark theme — CapCut-style panels (reskinned 2026-07-26, de-glassed
later session — see `git log clipcut.css` for the prior "rusty" v1 palette and
the intermediate frosted-glass/backdrop-filter version if ever needed):
```css
--bg: #151517
--s1: #1C1C1E       /* panels, topbar, playback-bar — solid, no blur */
--s2: #202022       /* cards, inputs */
--s3: #2A2A2D       /* hover states */
--s4: #333336       /* deep inset */
--b1: #313134       /* primary borders */
--b2: #3D3D41       /* secondary borders */
--blue: #0A84FF     /* primary accent */
--blue-soft: #409CFF
--blue-dim: rgba(10,132,255,.14)   /* tinted highlight wash — not a glass surface, just a subtle accent tint (Discord/Slack "selected" style), kept */
--accent: #FF9F0A   /* trim handles only */
--green: #30D158    /* config status "ok" pills */
--red: #FF453A      /* cuts, delete, dead_air */
--teal: #64D2FF     /* captions, waveform, whisper */
--text: #f5f5f7
--text2: rgba(255,255,255,.55)
--text3: rgba(255,255,255,.32)
```
Fonts: Outfit (UI) + JetBrains Mono (mono/timecodes) — kept as-is through the reskin, not swapped for SF Pro
Target resolution: 1920×1080 at 100% browser zoom

**No `backdrop-filter` anywhere, no translucent panel chrome.** The original
reskin used `backdrop-filter: blur(20px)` + `rgba()` surfaces on topbar/
playback-bar/timeline-section/modals/toast/transcript-toolbar/aspect-badges —
removed in a later session (explicit user ask: "get rid of this liquid glass
type UI"). `--s1`–`--s4`/`--b1`/`--b2` are now solid opaque hex, same relative
contrast steps as before (panel < card < hover < active), just no blur/alpha.
**Do not reintroduce `backdrop-filter` or translucent `rgba()` panel
backgrounds** — solid fills only for any new chrome (buttons stay pill/rounded,
7–14px radius). `--blue-dim`/`--accent-dim` tinted-highlight washes are fine to
keep using for selected/active states — those read as a flat-UI accent tint,
not glass, and were kept deliberately.

## Hardware Context
- CPU: Ryzen 5 7600X
- GPU: RTX 4070 (use h264_nvenc for export, cuda for whisper)
- RAM: 16GB DDR5-6000
- OS: Windows 11
- faster-whisper model: base (GPU/CUDA)
