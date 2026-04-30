// ═══════════════════════════════════════
// INIT
// ═══════════════════════════════════════
renderTimeline();
renderTranscriptEditor();
updateConfigStatus();
loadSilenceSettings();
loadSettings();
loadConfig().then(()=>{ if(S.orKey) fetchOpenRouterModels(); });
// Try loading ffmpeg.wasm in background (optional, no CDN restriction)
window.FFmpeg={createFFmpeg:()=>({load:async()=>{throw new Error('ffmpeg.wasm not loaded');},run:async()=>{},FS:()=>({})}),fetchFile:async f=>new Uint8Array(await(await fetch(typeof f==='string'?f:URL.createObjectURL(f))).arrayBuffer())};
toast('ClipCut — Drag & drop or import a video');
