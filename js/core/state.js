// ═══════════════════════════════════════
// STATE
// ═══════════════════════════════════════
// Registry of every clip ever loaded — never cleared, so undo can re-wire File + blob URL
const _clipRegistry = {};

const S = {
  clips: [],
  current: null,
  playing: false,
  flipH: false, flipV: false,
  trimIn: 0, trimOut: 0, duration: 0,
  fps: 30, // real source fps when probed at import, else this default
  aspect: '9/16',       // target export aspect ratio (also drives preview box) — 'w/h'
  aspectMode: 'crop',   // 'crop' (crop-to-fill) | 'pad' (pad-to-fit, letterbox)
  colorFilter: 'none',  // 'none'|'vivid'|'warm'|'cool'|'bw'|'vintage'|'moody' — see js/ui/colorfilters.js
  captions: [],
  cuts: [],              // [{id,start,end,type,selected,aiNote}] — unified silence + filler cuts
  segments: [],          // timeline segment model
  snapped: false,        // whether gaps are closed
  playSegments: [],      // [{start,end,timelineStart}] — active play queue
  currentSegmentIdx: 0,  // index into playSegments during playback
  // Preview proxy (Part A3 Option 3) — a background-rendered gapless concat
  // of kept segments, swapped into video.src for perfectly gapless
  // scrub-anywhere playback. See js/playback/playback.js's proxy section.
  proxyUrl: null,        // http://localhost:8080/video?path=... once rendered
  proxyActive: false,    // true while video.src IS the proxy
  proxyDirty: true,      // true if segments/cuts changed since last render
  silenceVisible: true,
  zoom: 60,
  tool: 'select',
  captionStyle: 'ugc',
  waveformData: null,
  orKey: '',
  orModel: '',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3',
  aiProvider: 'openrouter',
  availableModels: [],
  selectedModel: null,
  chatHistory: [],
  chatContext: {transcript:true,timeline:true,script:false},
  aiSource: 'openrouter',  // 'openrouter' | 'whisper'
  wordsPerCap: 2,
  stripPunct: true,
  captionLayout: 'single',
  captionMode: 'static',  // 'static' | 'word-highlight' (karaoke) — export burn-in only, see setCaptionMode()
  safeZonesVisible: false, // platform UI safe-zone guide overlay (9:16 only) — see toggleSafeZones()
  // Freeform text layers ("Add Text") — independent of auto-generated
  // captions. Each: {id, text, start, end (source time), style:{fontSize,
  // fontFamily,fontWeight,color,background,strokeEnabled,strokeThickness,
  // strokeColor,posX,posY,posZ}} — same shape as S.textStyle but per-object,
  // not shared. See js/ui/textlayers.js.
  textLayers: [],
  selectedTextLayerId: null,
  // Sticker/image overlays ("+ Image") — {id, path (absolute local file),
  // url (http://localhost:8080/video?path=... for preview), start, end
  // (source time), style:{posX,posY,posZ}}. Export composites via ffmpeg's
  // overlay filter (_make_filter_complex in serve.py), not the ASS pipeline
  // (ASS is text-only) — see js/ui/imagelayers.js.
  imageLayers: [],
  selectedImageLayerId: null,
  // Caption overlay styling — source of truth (bug #10). Previously these
  // lived only as inline styles on #captionOverlay: not undoable, not
  // persisted, and (still, pending the ASS burn-in pipeline) not passed to
  // export burn-in, which only renders plain text via the SRT subtitles filter.
  textStyle: {
    fontSize: 15, fontFamily: 'Outfit', fontWeight: '700', color: '#ffffff', background: '',
    strokeEnabled: false, strokeThickness: 1, strokeColor: '#000000',
    posX: 50, posY: 14, posZ: 1,
  },
  undoStack: [], redoStack: [],
  markers: [],
  loopA: null, loopB: null, looping: false, skipCuts: true,
  selectedClipId: null,
  selectedSegmentId: null,
  selectedFindingId: null,
  selectedCutId: null,
  whisperPort: '5000',
  whisperMode: 'words',
  settings: {
    // Detection pipeline
    useVAD:        true,
    // VAD tuning
    vadThreshold:    0.5,
    vadMinSpeechMs:  250,
    vadMinSilenceMs: 300,
    // Auto Mode steps
    autoTranscribe:  true,
    autoWaveform:    true,
    autoSilence:     true,
    autoDeadSpaces:  true,
    autoFillers:     true,
    // Deep AI Mode extras (on top of Auto Mode)
    deepAI:          true,
    deepEditReview:  false,  // Tier-2 AI edit review (Part F2) — extra model call beyond deepAI, opt-in
    // Transcription
    detectRetakes:   true,   // absorb WhisperX retake cuts into S.cuts after transcription
  },
};

const video  = document.getElementById('previewVideo');
const ph     = document.getElementById('playhead');
const tArea  = document.getElementById('tracksArea');
