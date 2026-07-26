// ═══════════════════════════════════════
// UGC TEMPLATES (Part F4)
// ═══════════════════════════════════════
// Bundles aspect/aspectMode, caption style (S.textStyle) + mode
// (S.captionMode), export preset, and a subset of S.settings (the
// auto-detection toggles) into one named, saveable/applyable preset.
// Deliberately NOT the spec's full "text layers" system (hook slot, etc.) —
// ClipCut has no freeform text-layer feature yet to apply that to; this
// covers what actually exists.

let _templatesCache = {};

async function refreshTemplateList(){
  const sel = document.getElementById('templateSelect');
  if(!window.pywebview){ if(sel) sel.innerHTML='<option value="">— desktop app required —</option>'; return; }
  try{
    _templatesCache = await window.pywebview.api.list_templates();
  } catch(e){
    _templatesCache = {};
  }
  if(!sel) return;
  const names = Object.keys(_templatesCache).sort();
  sel.innerHTML = '<option value="">— Select a template —</option>' +
    names.map(n=>`<option value="${_escTx(n)}">${_escTx(n)}</option>`).join('');
}

function _buildTemplateFromCurrent(){
  return {
    aspect: S.aspect,
    aspectMode: S.aspectMode,
    textStyle: {...S.textStyle},
    captionLayout: S.captionLayout,
    captionMode: S.captionMode,
    exportPreset: typeof _exportPreset !== 'undefined' ? _exportPreset : 'fast',
    autoSettings: {
      useVAD:         S.settings.useVAD,
      autoTranscribe: S.settings.autoTranscribe,
      autoWaveform:   S.settings.autoWaveform,
      autoSilence:    S.settings.autoSilence,
      autoDeadSpaces: S.settings.autoDeadSpaces,
      autoFillers:    S.settings.autoFillers,
      autoMediapipe:  S.settings.autoMediapipe,
      deepAI:         S.settings.deepAI,
      deepMediapipe:  S.settings.deepMediapipe,
      combineMode:    S.settings.combineMode,
    },
  };
}

async function saveCurrentAsTemplate(){
  if(!window.pywebview){ toast('Templates require the desktop app'); return; }
  const input = document.getElementById('templateNameInput');
  const name = (input?.value||'').trim();
  if(!name){ toast('Enter a template name first'); return; }
  const tpl = _buildTemplateFromCurrent();
  const result = await window.pywebview.api.save_template(name, JSON.stringify(tpl));
  if(!result?.success){ toast(`✕ Save failed: ${result?.error||'unknown error'}`); return; }
  if(input) input.value='';
  await refreshTemplateList();
  const sel = document.getElementById('templateSelect');
  if(sel) sel.value = name;
  toast(`✓ Saved template "${name}"`);
}

// Re-syncs every Caption Style DOM control from S.textStyle — needed because
// applying a template changes S.textStyle directly (not through the
// individual setCaptionFont()/syncFontSize()/etc. setters, which each only
// update their own single control). Weight/layout buttons are a known gap:
// they have no ids (only inline onclick(value,this)), so their `.primary`
// highlight isn't re-synced here — S.textStyle.fontWeight/S.captionLayout
// ARE correctly applied to the live overlay and export either way, this is
// a cosmetic gap in the settings panel only.
function _syncTextStyleUI(){
  const ts = S.textStyle;
  const set = (id, val) => { const el=document.getElementById(id); if(el) el.value = val; };
  set('fontSelect', ts.fontFamily);
  set('fontSizeSlider', Math.min(ts.fontSize, 120));
  set('fontSizeInput', ts.fontSize);
  set('captionColorInput', ts.color);
  set('captionBgSelect', ts.background);
  set('strokeThickness', Math.min(ts.strokeThickness, 20));
  set('strokeThickInput', ts.strokeThickness);
  set('strokeColor', ts.strokeColor);
  set('captionPosX', ts.posX); set('captionPosXInput', ts.posX);
  set('captionPosY', ts.posY); set('captionPosYInput', ts.posY);
  set('captionPosZ', ts.posZ); set('captionPosZInput', ts.posZ);
  const strokeBtn = document.getElementById('strokeToggleBtn');
  if(strokeBtn) strokeBtn.textContent = ts.strokeEnabled ? 'ON' : 'OFF';
  const strokeControls = document.getElementById('strokeControls');
  if(strokeControls) strokeControls.style.display = ts.strokeEnabled ? '' : 'none';
}

async function applyTemplate(name){
  if(!name){ toast('Select a template first'); return; }
  if(!_templatesCache[name]) await refreshTemplateList();
  const tpl = _templatesCache[name];
  if(!tpl){ toast('Template not found'); return; }

  saveHistory(); // aspect/aspectMode/textStyle are all part of the undo snapshot

  if(tpl.aspect){
    const btn = [...document.querySelectorAll('.ab')].find(b => b.getAttribute('onclick')?.includes(`'${tpl.aspect}'`));
    if(btn) setAspect(tpl.aspect, btn); else S.aspect = tpl.aspect;
  }
  if(tpl.aspectMode) setAspectMode(tpl.aspectMode);
  if(tpl.textStyle){ Object.assign(S.textStyle, tpl.textStyle); _applyTextStyle(); _syncTextStyleUI(); }
  if(tpl.captionLayout){
    S.captionLayout = tpl.captionLayout;
    const layoutBtnId = {single:'layoutSingle', stack:'layoutStack', grid:'layoutGrid'}[tpl.captionLayout];
    ['layoutSingle','layoutStack','layoutGrid'].forEach(id => document.getElementById(id)?.classList.remove('primary'));
    document.getElementById(layoutBtnId)?.classList.add('primary');
  }
  if(tpl.captionMode){
    S.captionMode = tpl.captionMode;
    document.getElementById('capModeStatic')?.classList.toggle('primary', tpl.captionMode==='static');
    document.getElementById('capModeKaraoke')?.classList.toggle('primary', tpl.captionMode==='word-highlight');
  }
  if(tpl.exportPreset && typeof setExportPreset==='function') setExportPreset(tpl.exportPreset);
  if(tpl.autoSettings){
    Object.assign(S.settings, tpl.autoSettings);
    saveSettings();
    updateSettingsUI();
  }

  renderTimeline();
  toast(`✓ Applied template "${name}"`);
}

async function deleteTemplateUI(name){
  if(!name){ toast('Select a template first'); return; }
  if(!confirm(`Delete template "${name}"?`)) return;
  const result = await window.pywebview.api.delete_template(name);
  if(!result?.success){ toast(`✕ Delete failed: ${result?.error||'unknown error'}`); return; }
  await refreshTemplateList();
  toast(`✕ Deleted "${name}"`);
}
