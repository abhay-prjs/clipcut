// ═══════════════════════════════════════
// CONFIG  (fetch ./config.json — requires local server, not file://)
// ═══════════════════════════════════════
async function loadConfig(){
  try{
    const r=await fetch('./config.json?_='+Date.now(),{cache:'no-store'});
    if(!r.ok) throw new Error('not found');
    const cfg=await r.json();
    if(cfg.openrouter_key)   S.orKey       = cfg.openrouter_key;
    if(cfg.openrouter_model) S.orModel     = cfg.openrouter_model;
    if(cfg.ollama_url)       S.ollamaUrl   = cfg.ollama_url.replace(/\/+$/,'');
    if(cfg.ollama_model)     S.ollamaModel = cfg.ollama_model;
    if(cfg.whisper_port){
      S.whisperPort=String(cfg.whisper_port);
    }
    if(cfg.whisper_mode){ S.whisperMode=cfg.whisper_mode; setWhisperMode(cfg.whisper_mode); }
    updateConfigStatus();
  } catch(e){
    toast('Config not found — add config.json to the folder');
  }
}

function updateConfigStatus(){
  const el=document.getElementById('configStatus');
  if(!el) return;
  const orOk=!!S.orKey;
  el.innerHTML=
    `<span class="cs-pill ok">✓ Whisper</span>`+
    (orOk
      ? `<span class="cs-pill ok">✓ OpenRouter</span>`
      : `<span class="cs-pill err">✗ OpenRouter</span>`);
}

function setAiSource(src){
  S.aiSource=src;
  document.getElementById('srcOpenRouter').classList.toggle('active',src==='openrouter');
  document.getElementById('srcWhisper').classList.toggle('active',src==='whisper');
}
