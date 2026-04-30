// ═══════════════════════════════════════
// SETTINGS — persistence + UI sync
// ═══════════════════════════════════════
const SETTINGS_KEY = 'vexxe_pipeline_settings';

const SETTINGS_DEFAULTS = {
  useVAD:          true,
  vadThreshold:    0.5,
  vadMinSpeechMs:  250,
  vadMinSilenceMs: 300,
  autoTranscribe:  true,
  autoWaveform:    true,
  autoSilence:     true,
  autoDeadSpaces:  true,
  autoFillers:     true,
  deepAI:          true,
  detectRetakes:   true,
};

function loadSettings(){
  // Apply defaults first, then override with any persisted values
  Object.assign(S.settings, SETTINGS_DEFAULTS);
  try {
    const stored = localStorage.getItem(SETTINGS_KEY);
    if(stored) Object.assign(S.settings, JSON.parse(stored));
  } catch(e){}

  // Apply whatever we have immediately — don't wait for the API
  updateSettingsUI();

  // Then override with server-side file after pywebview is ready
  // (survives pywebview localStorage wipes; delayed because API isn't ready at page load)
  setTimeout(() => {
    if(!window.pywebview) return;
    window.pywebview.api.load_ui_settings().then(data => {
      if(data && Object.keys(data).length){
        Object.assign(S.settings, data);
        updateSettingsUI();
      }
    }).catch(()=>{});
  }, 800);

  setTimeout(_loadWhisperConfigFromServer, 800);
}

function saveSettings(){
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(S.settings));
  if(window.pywebview) window.pywebview.api.save_ui_settings(S.settings).catch?.(()=>{});
}

function toggleSetting(key){
  // checkbox-driven keys
  const chk = {
    autoTranscribe: 'autoTranscribeChk', autoWaveform: 'autoWaveformChk',
    autoSilence: 'autoSilenceChk',       autoDeadSpaces: 'autoDeadSpacesChk',
    autoFillers: 'autoFillersChk',       deepAI: 'deepAIChk',
    detectRetakes: 'detectRetakesChk',
  };
  if(chk[key]){
    const el = document.getElementById(chk[key]);
    S.settings[key] = el ? el.checked : !S.settings[key];
  } else {
    S.settings[key] = !S.settings[key];
  }

  if(key === 'useVAD') _updatePipelineBtns();
  saveSettings();
}

function resetSettings(){
  Object.assign(S.settings, SETTINGS_DEFAULTS);
  saveSettings();
  updateSettingsUI();
  toast('Settings reset to defaults');
}

// ── Whisper backend (writes to config.json via pywebview) ─────────────────────
async function setWhisperBackend(backend){
  _updateBackendUI(backend);
  await _saveWhisperConfig();
}

async function updateWhisperXSetting(){
  await _saveWhisperConfig();
}

async function _saveWhisperConfig(){
  if(!window.pywebview) return;
  const backend    = document.getElementById('backendFWBtn')?.classList.contains('primary') ? 'faster-whisper' : 'whisperx';
  const model      = document.getElementById('whisperXModelSelect')?.value || 'distil-large-v3';
  const batch_size = parseInt(document.getElementById('wxBatchSlider')?.value || '16');
  try{
    const r = await window.pywebview.api.save_whisper_config(backend, model, batch_size);
    if(r.ok){
      const label = backend === 'whisperx' ? 'WhisperX' : 'faster-whisper';
      const badge = document.getElementById('settingsBackendBadge');
      if(badge){ badge.textContent = label; badge.style.color = backend==='whisperx' ? 'var(--blue-soft)' : 'var(--text2)'; }
      // Also update the Captions tab status line
      const ws = document.getElementById('whisperStatus');
      if(ws && ws.textContent.startsWith('✓')){
        ws.textContent = ws.textContent.replace(/faster-whisper|WhisperX/, label);
      }
      toast(`✓ Backend → ${label}`);
    }
  } catch(e){ toast('✕ Could not save config: '+e.message); }
}

function _updateBackendUI(backend){
  const fwBtn    = document.getElementById('backendFWBtn');
  const wxBtn    = document.getElementById('backendWXBtn');
  const wxPanel  = document.getElementById('whisperXOptions');
  const isWX     = backend === 'whisperx';
  if(fwBtn){ fwBtn.className = `act-btn${!isWX ? ' primary' : ''}`; }
  if(wxBtn){ wxBtn.className = `act-btn${isWX  ? ' primary' : ''}`; }
  if(wxPanel){ wxPanel.style.display = isWX ? 'block' : 'none'; }
}

async function _loadWhisperConfigFromServer(){
  if(!window.pywebview) return;
  try{
    const cfg = await window.pywebview.api.get_whisper_config();
    _updateBackendUI(cfg.whisper_backend);
    const sel = document.getElementById('whisperXModelSelect');
    if(sel) sel.value = cfg.whisperx_model;
    const slider = document.getElementById('wxBatchSlider');
    const label  = document.getElementById('wxBatchVal');
    if(slider){ slider.value = cfg.whisperx_batch_size; }
    if(label)  { label.textContent = cfg.whisperx_batch_size; }
    const badge = document.getElementById('settingsBackendBadge');
    if(badge){
      const bl = cfg.whisper_backend === 'whisperx' ? 'WhisperX' : 'faster-whisper';
      badge.textContent = bl;
      badge.style.color = cfg.whisper_backend === 'whisperx' ? 'var(--blue-soft)' : 'var(--text2)';
    }
  } catch(e){ /* pywebview not ready yet */ }
}

// ── UI sync ───────────────────────────────────────────────────────────────────
function updateSettingsUI(){
  _updatePipelineBtns();

  // VAD sliders
  _setSlider('vadThresh',    S.settings.vadThreshold,    'vadThreshVal',  v=>v.toFixed(2));
  _setSlider('vadSpeech',    S.settings.vadMinSpeechMs,  'vadSpeechVal',  v=>v);
  _setSlider('vadSilence',   S.settings.vadMinSilenceMs, 'vadSilenceVal', v=>v);

  // Auto Mode checkboxes
  _setChk('autoTranscribeChk', S.settings.autoTranscribe);
  _setChk('autoWaveformChk',   S.settings.autoWaveform);
  _setChk('autoSilenceChk',    S.settings.autoSilence);
  _setChk('autoDeadSpacesChk', S.settings.autoDeadSpaces);
  _setChk('autoFillersChk',    S.settings.autoFillers);

  // Deep AI checkboxes
  _setChk('deepAIChk',         S.settings.deepAI);

  // Transcription
  _setChk('detectRetakesChk',  S.settings.detectRetakes);
}

function _setSlider(sliderId, val, labelId, fmt){
  const s = document.getElementById(sliderId);
  const l = document.getElementById(labelId);
  if(s) s.value = val;
  if(l) l.textContent = fmt(val);
}

function _setChk(id, val){
  const el = document.getElementById(id);
  if(el) el.checked = !!val;
}

function _updatePipelineBtns(){
  const vadBtn  = document.getElementById('settingVADBtn');
  const vadPanel = document.getElementById('settingsVADTuning');
  if(vadBtn){
    vadBtn.textContent = S.settings.useVAD ? 'ON' : 'OFF';
    vadBtn.className = `act-btn${S.settings.useVAD ? ' primary' : ''}`;
  }
  if(vadPanel){
    vadPanel.style.opacity       = S.settings.useVAD ? '1'    : '.4';
    vadPanel.style.pointerEvents = S.settings.useVAD ? 'auto' : 'none';
  }
}
