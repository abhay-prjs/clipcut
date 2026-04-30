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
  captions: [],
  cuts: [],              // [{id,start,end,type,selected,aiNote}] — unified silence + filler cuts
  segments: [],          // timeline segment model
  snapped: false,        // whether gaps are closed
  playSegments: [],      // [{start,end,timelineStart}] — active play queue
  currentSegmentIdx: 0,  // index into playSegments during playback
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
    // Transcription
    detectRetakes:   true,   // absorb WhisperX retake cuts into S.cuts after transcription
  },
};

const video  = document.getElementById('previewVideo');
const ph     = document.getElementById('playhead');
const tArea  = document.getElementById('tracksArea');
