// ═══════════════════════════════════════
// COLOR FILTERS — CapCut-style one-tap presets
// ═══════════════════════════════════════
// Preview uses a CSS `filter:` approximation on the <video> element; export
// applies the real ffmpeg filter server-side (COLOR_FILTER_PRESETS in
// serve.py) — JS only ever sends the preset NAME, never a raw filter
// string, so the actual ffmpeg filter graph stays fully server-controlled.
// The two won't be pixel-identical (CSS and ffmpeg's eq/colorbalance don't
// compute saturation/contrast the same way) but read the same at a glance.

const COLOR_FILTER_CSS = {
  none:    'none',
  vivid:   'saturate(1.4) contrast(1.15)',
  warm:    'sepia(0.15) saturate(1.15) hue-rotate(-8deg)',
  cool:    'saturate(1.1) hue-rotate(8deg)',
  bw:      'grayscale(1) contrast(1.05)',
  vintage: 'sepia(0.3) saturate(0.8) contrast(0.9) brightness(1.05)',
  moody:   'contrast(1.2) saturate(0.9) brightness(0.92)',
};

function setColorFilter(name, btn){
  S.colorFilter = name;
  document.querySelectorAll('.color-filter-swatch').forEach(b=>b.classList.remove('primary'));
  btn?.classList.add('primary');
  _applyColorFilterPreview();
}

function _applyColorFilterPreview(){
  if(video) video.style.filter = COLOR_FILTER_CSS[S.colorFilter] || 'none';
}
