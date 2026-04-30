// waveform.worker.js
// Owns both waveform canvas contexts (timeline + modal).
// Main thread transfers canvas control via transferControlToOffscreen()
// then sends draw commands via postMessage — worker draws, returns nothing.

let tlCtx   = null;  // timeline waveform canvas context
let modCtx  = null;  // modal waveform canvas context

self.onmessage = function(e) {
  const msg = e.data;

  // ── Setup: receive transferred OffscreenCanvas objects ──────────────────────
  if (msg.type === 'init_tl') {
    tlCtx = msg.canvas.getContext('2d');
    return;
  }
  if (msg.type === 'init_mod') {
    modCtx = msg.canvas.getContext('2d');
    return;
  }

  // ── Draw timeline waveform ──────────────────────────────────────────────────
  if (msg.type === 'draw_tl') {
    if (!tlCtx) return;
    const { frames, segments, slicedSegments, zoom, totalPx, H } = msg;

    tlCtx.canvas.width  = totalPx;
    tlCtx.canvas.height = H;
    tlCtx.clearRect(0, 0, totalPx, H);

    if (slicedSegments && slicedSegments.some(s => s.waveformSlice && s.waveformSlice.length)) {
      // Post-cut: draw each segment's slice at its timeline position
      slicedSegments.forEach(seg => {
        const slice = seg.waveformSlice;
        if (!slice || !slice.length) return;
        const maxRms = Math.max(...slice.map(f => f.rms)) || 1;
        const offsetPx = seg.timelineStart * zoom;
        slice.forEach(f => {
          const x = offsetPx + (f.t - seg.sourceStart) * zoom;
          const h = (f.rms / maxRms) * (H * 0.75);
          tlCtx.fillStyle = 'rgba(78,205,196,0.55)';
          tlCtx.fillRect(x, H / 2 - h / 2, Math.max(zoom * 0.05 - 0.5, 0.5), h);
        });
      });
    } else if (frames && frames.length) {
      // Pre-cut: draw all frames
      const maxRms = Math.max(...frames.map(f => f.rms)) || 1;
      frames.forEach(f => {
        const x = f.t * zoom;
        const h = (f.rms / maxRms) * (H * 0.75);
        tlCtx.fillStyle = 'rgba(78,205,196,0.55)';
        tlCtx.fillRect(x, H / 2 - h / 2, Math.max(zoom * 0.05 - 0.5, 0.5), h);
      });
    }
    return;
  }

  // ── Draw modal waveform ─────────────────────────────────────────────────────
  if (msg.type === 'draw_mod') {
    if (!modCtx) return;
    const { frames, W, H } = msg;
    modCtx.canvas.width  = W;
    modCtx.canvas.height = H;
    modCtx.clearRect(0, 0, W, H);
    modCtx.fillStyle = '#0f0f12';
    modCtx.fillRect(0, 0, W, H);
    if (!frames || !frames.length) return;
    const maxRms = Math.max(...frames.map(f => f.rms)) || 1;
    const bw = W / frames.length;
    frames.forEach((f, i) => {
      const h = (f.rms / maxRms) * (H * 0.8);
      modCtx.fillStyle = 'rgba(78,205,196,0.7)';
      modCtx.fillRect(i * bw, H / 2 - h / 2, Math.max(bw - 0.5, 0.5), h);
    });
    return;
  }
};
