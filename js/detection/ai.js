// ═══════════════════════════════════════
// AI CHAT PANEL
// ═══════════════════════════════════════
function toggleChatPanel(){
  const panel=document.getElementById('chatPanel');
  const isOpen=panel.style.display==='flex';
  panel.style.display=isOpen?'none':'flex';
  document.getElementById('chatToggleBtn').classList.toggle('act',!isOpen);
  if(!isOpen){
    // opening chat — close Settings first so the two don't sit open together
    if(document.getElementById('tab-settings')?.classList.contains('active')) switchTab(_lastPanelTab);
    if(S.selectedModel) document.getElementById('chatModelBadge').textContent=S.selectedModel.name;
    if(!S.chatHistory.length) renderChatSuggestions();
  }
}

function toggleCtx(key){
  S.chatContext[key]=!S.chatContext[key];
  document.getElementById('ctx'+key.charAt(0).toUpperCase()+key.slice(1))
    .classList.toggle('act',S.chatContext[key]);
}

function clearChat(){
  S.chatHistory=[];
  renderChatSuggestions();
}

function renderChatSuggestions(){
  const suggestions=[
    'Find all my retakes',
    'Which part of the video is weakest?',
    'Remove all filler words',
    'Where should I cut to tighten the pacing?',
    'What is missing from my script?',
    'Summarise what I said in this video',
  ];
  document.getElementById('chatMessages').innerHTML=`
    <div style="font-size:9.5px;color:var(--text3);text-align:center;margin-bottom:8px;letter-spacing:.06em;text-transform:uppercase">Suggestions</div>
    ${suggestions.map(s=>`
      <div onclick="document.getElementById('chatInput').value='${s}';sendChat()"
        style="padding:6px 9px;background:var(--s2);border:1px solid var(--b1);border-radius:5px;font-size:10.5px;cursor:pointer;transition:all .15s;color:var(--text2)"
        onmouseover="this.style.borderColor='var(--blue)';this.style.color='var(--text)'"
        onmouseout="this.style.borderColor='var(--b1)';this.style.color='var(--text2)'">${s}</div>`).join('')}`;
}

// Group word-level captions into sentence chunks for AI context
// Splits on pause gaps >0.4s or every maxWords words
function _buildChatSRT(maxWords=80){
  if(!S.captions.length) return null;
  const GAP=0.4;
  const fmt=t=>{
    const h=Math.floor(t/3600),m=Math.floor((t%3600)/60),s=t%60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(Math.floor(s)).padStart(2,'0')},${String(Math.round((s%1)*1000)).padStart(3,'0')}`;
  };
  const chunks=[];
  let cur=[],curStart=null,curEnd=null,idx=1;
  const flush=()=>{
    if(!cur.length) return;
    chunks.push(`${idx++}\n${fmt(curStart)} --> ${fmt(curEnd)}\n${cur.join(' ')}`);
    cur=[];curStart=null;curEnd=null;
  };
  S.captions.forEach((c,i)=>{
    const gap=i>0?c.start-S.captions[i-1].end:0;
    if(cur.length&&(gap>GAP||cur.length>=maxWords)) flush();
    if(curStart===null) curStart=c.start;
    curEnd=c.end;
    cur.push(c.text);
  });
  flush();
  return chunks.join('\n\n');
}

function buildSystemPrompt(){
  const hasCaps=S.captions.length>0;

  let sys=`You are an AI video editor assistant for a video editor called ClipCut.
You help the user edit their video by analysing transcript, timeline, and script.
Video duration: ${S.duration?.toFixed(1)||'?'}s
Current playhead: ${video?.currentTime?.toFixed(2)||'0'}s
Clips on timeline: ${S.clips.length}
Words transcribed: ${S.captions.length}
Segments flagged for cut: ${S.cuts.filter(s=>s.selected).length}
Total findings: ${S.cuts.length}

To manipulate the timeline, output one or more action blocks in this exact format:

ACTION: <action>
START: 0.00
END: 0.00
REASON: <brief reason>

Available actions:
- add_cut       → mark a time range to be removed (requires START + END)
- add_highlight → mark a time range as a best part / keep (requires START + END)
- seek          → move playhead to START time
- trim_before   → trim clip start to START time
- trim_after    → trim clip end to START time
- split         → split clip at START time
- select_cut    → select (enable) all cuts overlapping START–END
- deselect_cut  → deselect (disable) all cuts overlapping START–END
- add_marker    → drop a named marker at START time (optional LABEL: <name>)
- delete_cut    → remove all cuts overlapping START–END
- apply_cuts    → apply (bake) all currently selected cuts into the timeline
- snap_gaps     → close all gaps between segments on the timeline
- set_speed     → set playback speed (requires SPEED: <value>, e.g. 0.5 or 2)
- select_type   → select all cuts of a given type (TYPE: dead_air | filler | retake | weak | silence | highlight)
- deselect_type → deselect all cuts of a given type (TYPE: same options)
- select_all    → select every cut on the timeline (no START/END needed)
- deselect_all  → deselect every cut on the timeline (no START/END needed)

Cut types: dead_air, filler, retake, weak, silence, highlight

Rules:
• Use only timestamps from the SRT transcript — never invent times
• You can output multiple ACTION blocks in one response
• Always include REASON

Always be concise. Think like an editor, not a chatbot.`;

  if(S.chatContext.transcript){
    if(hasCaps){
      sys+=`\n\n--- SRT TRANSCRIPT (use these timestamps for all time references) ---\n${_buildChatSRT()}`;
    } else {
      sys+=`\n\n[NO TRANSCRIPT LOADED — video has not been transcribed yet. Remind the user to click Transcribe in the Captions tab first, then they can ask transcript-related questions.]`;
    }
  }
  if(S.chatContext.timeline){
    const cuts=S.cuts.filter(s=>s.selected);
    const highlights=S.cuts.filter(s=>s.type==='highlight');
    sys+=`\n\n--- TIMELINE ---\nSelected cuts: ${cuts.map(s=>`${s.start.toFixed(2)}s–${s.end.toFixed(2)}s (${s.type})`).join(', ')||'none'}`;
    if(highlights.length) sys+=`\nHighlights (best parts): ${highlights.map(s=>`${s.start.toFixed(2)}s–${s.end.toFixed(2)}s`).join(', ')}`;
  }
  if(S.chatContext.script){
    const script=document.getElementById('scriptInput')?.value?.trim();
    if(script) sys+=`\n\n--- ORIGINAL SCRIPT (what the creator planned to say) ---\n${script}`;
  }
  return sys;
}

async function sendChat(){
  const input=document.getElementById('chatInput');
  const msg=input.value.trim();
  if(!msg) return;
  if(S.aiProvider==='openrouter' && !S.orKey){toast('Add openrouter_key to config.json');return;}
  if(S.aiProvider==='openrouter' && !S.selectedModel){toast('Select a model in the AI tab');return;}
  if(S.aiProvider==='ollama' && !S.ollamaModel){toast('Select an Ollama model in the AI tab');return;}

  if(S.chatContext.transcript && !S.captions.length){
    toast('✕ No transcript — re-transcribe after applying cuts before using AI chat');
    return;
  }

  input.value='';
  appendChatMsg('user',msg);

  const systemPrompt=buildSystemPrompt();
  const fullPrompt=systemPrompt+msg;
  if(!checkTokenLimit(fullPrompt)){
    appendChatMsg('ai','⚠ Context too large for this model. Disable Transcript or Script context, or switch to a larger context model.');
    return;
  }

  S.chatHistory.push({role:'user',content:msg});

  const loadId='load-'+Date.now();
  appendChatMsg('ai','...',loadId);

  const model = S.aiProvider==='ollama' ? S.ollamaModel : S.selectedModel.id;
  const endpoint = S.aiProvider==='ollama'
    ? `${S.ollamaUrl}/v1/chat/completions`
    : 'https://openrouter.ai/api/v1/chat/completions';
  const headers = S.aiProvider==='ollama'
    ? {'Content-Type':'application/json'}
    : {'Content-Type':'application/json','Authorization':`Bearer ${S.orKey}`};

  try{
    const res=await fetch(endpoint,{
      method:'POST',
      headers,
      body:JSON.stringify({
        model,
        messages:[{role:'system',content:systemPrompt},...S.chatHistory],
        max_tokens:1000
      })
    });
    const data=await res.json();
    if(data.error) throw new Error(data.error.message);
    const reply=data.choices[0].message.content;
    S.chatHistory.push({role:'assistant',content:reply});
    document.getElementById(loadId)?.remove();
    appendChatMsg('ai',reply);
    parseAIActions(reply);
  }catch(e){
    document.getElementById(loadId)?.remove();
    appendChatMsg('ai','✕ Error: '+e.message);
  }
}

// Parse all ACTION blocks from an AI response
// Tolerant line-by-line parser — handles markdown asterisks, indentation,
// extra text after numbers (e.g. "0.32 (just before the repeat)"), mixed casing
function _parseActionBlocks(text){
  const blocks=[];
  let cur=null;
  for(const raw of text.split(/\r?\n/)){
    // Strip leading markdown noise: spaces, *, -, >, #
    const line=raw.replace(/^[\s*\->•#]+/,'').trim();
    if(!line) continue;

    if(/^ACTION\s*:/i.test(line)){
      if(cur && cur.action) blocks.push(cur);
      // grab first word after colon — ignore trailing description
      const act=line.replace(/^ACTION\s*:\s*/i,'').trim().split(/[\s,.(]/)[0].toLowerCase();
      cur={action:act, start:0, end:0, reason:''};
    } else if(cur && /^START\s*:/i.test(line)){
      cur.start=parseFloat(line.replace(/^START\s*:\s*/i,''))||0;
    } else if(cur && /^END\s*:/i.test(line)){
      cur.end=parseFloat(line.replace(/^END\s*:\s*/i,''))||0;
    } else if(cur && /^TIME\s*:/i.test(line)){
      const t=parseFloat(line.replace(/^TIME\s*:\s*/i,''))||0;
      cur.start=t; cur.end=t;
    } else if(cur && /^REASON\s*:/i.test(line)){
      cur.reason=line.replace(/^REASON\s*:\s*/i,'').trim();
    } else if(cur && /^LABEL\s*:/i.test(line)){
      cur.label=line.replace(/^LABEL\s*:\s*/i,'').trim();
    } else if(cur && /^SPEED\s*:/i.test(line)){
      cur.speed=parseFloat(line.replace(/^SPEED\s*:\s*/i,''))||1;
    } else if(cur && /^TYPE\s*:/i.test(line)){
      cur.cutType=line.replace(/^TYPE\s*:\s*/i,'').trim().toLowerCase();
    }
  }
  if(cur && cur.action) blocks.push(cur);
  return blocks.filter(b=>b.action);
}

function appendChatMsg(role,text,id){
  const el=document.createElement('div');
  if(id) el.id=id;
  el.style.cssText=`padding:8px 10px;border-radius:6px;font-size:11px;line-height:1.5;max-width:90%;word-break:break-word;${role==='user'?'background:var(--blue-dim);border:1px solid rgba(61,127,255,.2);align-self:flex-end;color:var(--text);':'background:var(--s2);border:1px solid var(--b1);align-self:flex-start;color:var(--text);'}`;

  // Render action blocks as interactive cards
  const ACTION_COLOR={add_cut:'var(--red)',add_highlight:'var(--teal)',seek:'var(--blue)',
    trim_before:'#facc15',trim_after:'#facc15',split:'#a855f7',
    select_cut:'var(--blue-soft)',deselect_cut:'var(--text3)',
    add_marker:'#f97316',delete_cut:'#ff5461',apply_cuts:'var(--accent)',
    snap_gaps:'var(--accent)',set_speed:'#c084fc',
    select_type:'var(--blue-soft)',deselect_type:'var(--text3)',
    select_all:'var(--blue-soft)',deselect_all:'var(--text3)'};
  const ACTION_ICON={add_cut:'✕',add_highlight:'✦',seek:'→',trim_before:'⊣',
    trim_after:'⊢',split:'⊘',select_cut:'☑',deselect_cut:'☐',
    add_marker:'⚑',delete_cut:'⊗',apply_cuts:'✂',snap_gaps:'↯',set_speed:'⏩',
    select_type:'☑',deselect_type:'☐',select_all:'☑',deselect_all:'☐'};

  const blocks=_parseActionBlocks(text);
  // Strip raw ACTION/START/END/TIME/REASON lines from display text
  let display=text
    .split(/\r?\n/)
    .filter(l=>!/^[\s*\->•#]*(?:ACTION|START|END|TIME|REASON|LABEL|SPEED|TYPE)\s*:/i.test(l))
    .join('\n')
    .trim()
    .replace(/</g,'&lt;');

  let cardsHtml='';
  if(blocks.length){
    const batchId='batch-'+Date.now();
    const encoded=encodeURIComponent(JSON.stringify(blocks));
    cardsHtml=`<div style="margin-top:6px;display:flex;flex-direction:column;gap:4px">
      ${blocks.map((b,i)=>{
        const color=ACTION_COLOR[b.action]||'var(--blue)';
        const icon=ACTION_ICON[b.action]||'▶';
        const range=b.end>b.start?`${b.start.toFixed(2)}s – ${b.end.toFixed(2)}s`:`@ ${b.start.toFixed(2)}s`;
        return `<div style="background:var(--s3);border:1px solid var(--b2);border-left:3px solid ${color};border-radius:4px;padding:5px 8px;font-family:'JetBrains Mono',monospace;font-size:9px">
          <div style="display:flex;align-items:center;justify-content:space-between;gap:6px">
            <span><span style="color:${color};font-weight:700">${icon} ${b.action}</span> <span style="color:var(--text2)">${range}</span></span>
            <button onclick="applyAIAction(${i},${JSON.stringify(encoded).slice(1,-1)})" style="padding:2px 8px;background:${color};border:none;border-radius:3px;color:#000;font-size:8.5px;font-weight:700;cursor:pointer;flex-shrink:0">Apply</button>
          </div>
          <div style="color:var(--text2);margin-top:2px">${b.reason}</div>
        </div>`;
      }).join('')}
      ${blocks.length>1?`<button onclick="applyAllAIActions('${encoded}')" style="padding:3px;background:var(--blue);border:none;border-radius:3px;color:#fff;font-size:8.5px;cursor:pointer;font-weight:700">▶ Apply All ${blocks.length} Actions</button>`:''}
    </div>`;
  }

  el.innerHTML=(display?`<div style="white-space:pre-wrap">${display}</div>`:'')+cardsHtml;
  document.getElementById('chatMessages').appendChild(el);
  el.scrollIntoView({behavior:'smooth'});
}

let _chatAutoApply = false;

function toggleChatAutoApply(){
  _chatAutoApply=!_chatAutoApply;
  const btn=document.getElementById('chatAutoApplyBtn');
  if(btn){ btn.textContent=_chatAutoApply?'Auto-apply ON':'Auto-apply OFF'; btn.classList.toggle('primary',_chatAutoApply); }
  toast(_chatAutoApply?'✦ Chat will auto-apply actions':'Auto-apply off');
}

function parseAIActions(text){
  const blocks=_parseActionBlocks(text);
  if(!blocks.length) return;

  if(_chatAutoApply){
    // Auto-apply all actions immediately
    saveHistory();
    blocks.forEach(b=>_execAIAction(b,false));
    renderAllFindings(); renderTimeline(); buildPlaySegments();
    appendChatMsg('system',`✦ Auto-applied ${blocks.length} action${blocks.length!==1?'s':''}`);
  } else {
    // Auto-seek to first relevant time so user can preview
    const first=blocks.find(b=>b.action!=='add_cut'&&b.action!=='add_highlight')||blocks[0];
    if(first&&video.src) video.currentTime=first.start;
  }
}

function applyAIAction(idx, encoded){
  const blocks=JSON.parse(decodeURIComponent(encoded));
  const b=blocks[idx];
  _execAIAction(b);
}

function applyAllAIActions(encoded){
  const blocks=JSON.parse(decodeURIComponent(encoded));
  saveHistory();
  blocks.forEach(b=>_execAIAction(b,false));
  renderAllFindings(); renderTimeline(); buildPlaySegments();
  toast(`✦ Applied ${blocks.length} actions`);
}

function _execAIAction(b, doHistory=true){
  if(doHistory) saveHistory();
  const {action,start,end,reason}=b;

  if(action==='seek'){
    if(video.src) video.currentTime=start;

  } else if(action==='add_cut'){
    S.cuts.push({id:crypto.randomUUID(),start,end,type:'retake',text:'',
      aiNote:reason,selected:true,skipEnabled:true,scriptPart:false,_src:'chat'});
    renderAllFindings(); renderTimeline(); buildPlaySegments();
    toast(`✕ Cut added ${start.toFixed(2)}s–${end.toFixed(2)}s`);

  } else if(action==='add_highlight'){
    S.cuts.push({id:crypto.randomUUID(),start,end,type:'highlight',text:'',
      aiNote:reason,selected:false,skipEnabled:false,scriptPart:true,_src:'chat'});
    renderAllFindings(); renderTimeline();
    toast(`✦ Highlight added ${start.toFixed(2)}s–${end.toFixed(2)}s`);

  } else if(action==='trim_before'){
    video.currentTime=start; trimBefore();

  } else if(action==='trim_after'){
    video.currentTime=start; trimAfter();

  } else if(action==='split'){
    video.currentTime=start; splitAtPlayhead();

  } else if(action==='select_cut'){
    S.cuts.filter(c=>c.start<end&&c.end>start&&c.type!=='highlight')
          .forEach(c=>c.selected=true);
    renderAllFindings(); renderTimeline(); buildPlaySegments();
    toast(`☑ Cuts selected in ${start.toFixed(2)}s–${end.toFixed(2)}s`);

  } else if(action==='deselect_cut'){
    S.cuts.filter(c=>c.start<end&&c.end>start)
          .forEach(c=>c.selected=false);
    renderAllFindings(); renderTimeline(); buildPlaySegments();
    toast(`☐ Cuts deselected in ${start.toFixed(2)}s–${end.toFixed(2)}s`);

  } else if(action==='add_marker'){
    const name=b.label||`M${S.markers.length+1}`;
    S.markers.push({t:start, name});
    renderTimeline();
    toast(`⚑ Marker "${name}" @ ${start.toFixed(2)}s`);

  } else if(action==='delete_cut'){
    const before=S.cuts.length;
    S.cuts=S.cuts.filter(c=>!(c.start<end&&c.end>start));
    const removed=before-S.cuts.length;
    renderAllFindings(); renderTimeline(); buildPlaySegments();
    toast(`⊗ Removed ${removed} cut${removed!==1?'s':''} in ${start.toFixed(2)}s–${end.toFixed(2)}s`);

  } else if(action==='apply_cuts'){
    const sel=S.cuts.filter(c=>c.selected);
    if(!sel.length){ toast('No cuts selected to apply'); return; }
    applyCuts();

  } else if(action==='snap_gaps'){
    snapGaps();
    toast('↯ Gaps snapped');

  } else if(action==='set_speed'){
    const rate=b.speed||1;
    video.playbackRate=rate;
    const sel=document.getElementById('speedSelect');
    if(sel) sel.value=rate;
    toast(`⏩ Speed → ${rate}×`);

  } else if(action==='select_type'){
    const t=b.cutType;
    const matched=S.cuts.filter(c=>!t||c.type===t);
    matched.forEach(c=>c.selected=true);
    renderAllFindings(); renderTimeline(); buildPlaySegments();
    toast(`☑ Selected ${matched.length} ${t||'all'} cuts`);

  } else if(action==='deselect_type'){
    const t=b.cutType;
    const matched=S.cuts.filter(c=>!t||c.type===t);
    matched.forEach(c=>c.selected=false);
    renderAllFindings(); renderTimeline(); buildPlaySegments();
    toast(`☐ Deselected ${matched.length} ${t||'all'} cuts`);

  } else if(action==='select_all'){
    S.cuts.filter(c=>c.type!=='highlight').forEach(c=>c.selected=true);
    renderAllFindings(); renderTimeline(); buildPlaySegments();
    toast(`☑ All cuts selected`);

  } else if(action==='deselect_all'){
    S.cuts.forEach(c=>c.selected=false);
    renderAllFindings(); renderTimeline(); buildPlaySegments();
    toast(`☐ All cuts deselected`);
  }
  if(doHistory) toast(`✦ ${action} @ ${start.toFixed(2)}s`);
}

async function pingAIStatus(){
  const el=document.getElementById('aiPingStatus');
  if(!el) return;
  el.textContent='⏳ Pinging...'; el.style.color='var(--text2)';

  let whisperStatus, orStatus;

  // ping whisper (pywebview API — no HTTP involved)
  try{
    if(!window.pywebview) throw new Error('not in pywebview');
    const d=await window.pywebview.api.ping();
    whisperStatus=d.online ? `✓ Whisper · ${d.model} · ${d.device}` : `✗ Whisper · ${d.error||'failed'}`;
  } catch { whisperStatus='✗ Whisper · not available'; }

  // ping openrouter
  try{
    if(!S.orKey) throw new Error('no key');
    const r=await fetch('https://openrouter.ai/api/v1/models',{
      headers:{Authorization:`Bearer ${S.orKey}`},
      signal:AbortSignal.timeout(3000)
    });
    if(r.ok) orStatus=`✓ OpenRouter · ${S.orModel}`;
    else throw new Error();
  } catch(e){ orStatus=e.message==='no key'?'✗ OpenRouter · no key in config':'✗ OpenRouter · unreachable'; }

  const wOk=whisperStatus.startsWith('✓');
  const orOk=orStatus.startsWith('✓');
  const html=
    `<span style="color:${wOk?'var(--teal)':'var(--red)'}">${whisperStatus}</span><br>`+
    `<span style="color:${orOk?'var(--teal)':'var(--red)'}">${orStatus}</span>`;
  el.innerHTML=html; el.style.color='';
  // also update AI tab panel ping
  const panel=document.getElementById('aiAnalysisPing');
  if(panel){panel.innerHTML=html; panel.style.color='';}
}

// ═══════════════════════════════════════
// MODEL SELECTOR / PROVIDER SWITCHER
// ═══════════════════════════════════════
function setProvider(p){
  S.aiProvider = p;
  localStorage.setItem('vexxe_provider', p);
  document.getElementById('providerOR')        .classList.toggle('primary', p==='openrouter');
  document.getElementById('providerOllama')    .classList.toggle('primary', p==='ollama');
  document.getElementById('providerORPanel')   .style.display = p==='openrouter' ? '' : 'none';
  document.getElementById('providerOllamaPanel').style.display = p==='ollama'     ? '' : 'none';
  if(p==='ollama') fetchOllamaModels();
}

async function fetchOllamaModels(){
  const statusEl = document.getElementById('ollamaStatus');
  const sel      = document.getElementById('ollamaModelSelect');
  if(statusEl) statusEl.textContent = '⏳ Fetching…';
  try{
    const res  = await fetch(`${S.ollamaUrl}/api/tags`, {signal:AbortSignal.timeout(3000)});
    if(!res.ok) throw new Error('HTTP '+res.status);
    const data = await res.json();
    const models = (data.models||[]).map(m=>m.name).sort();
    if(!models.length) throw new Error('No models installed');

    sel.innerHTML = models.map(m=>`<option value="${m}" ${m===S.ollamaModel?'selected':''}>${m}</option>`).join('');
    // Pick saved model if available, else first
    const saved = localStorage.getItem('vexxe_ollama_model');
    if(saved && models.includes(saved)){ sel.value=saved; S.ollamaModel=saved; }
    else S.ollamaModel = sel.value;

    sel.onchange = ()=>{
      S.ollamaModel = sel.value;
      localStorage.setItem('vexxe_ollama_model', sel.value);
    };

    if(statusEl) statusEl.innerHTML=`<span style="color:var(--teal)">✓ Ollama · ${models.length} model${models.length!==1?'s':''}</span>`;
    toast(`⬡ ${models.length} Ollama model${models.length!==1?'s':''} found`);
  } catch(e){
    if(statusEl) statusEl.innerHTML=`<span style="color:var(--red)">✕ ${e.message} — is Ollama running?</span>`;
  }
}

// Restore saved provider on load
(()=>{
  const saved = localStorage.getItem('vexxe_provider') || 'openrouter';
  // Defer until DOM is ready
  document.addEventListener('DOMContentLoaded', ()=>setProvider(saved), {once:true});
})();

async function fetchOpenRouterModels(){
  if(!S.orKey){toast('Add openrouter_key to config.json');return;}
  try{
    const res=await fetch('https://openrouter.ai/api/v1/models',{
      headers:{'Authorization':`Bearer ${S.orKey}`}
    });
    const data=await res.json();
    S.availableModels=data.data
      .filter(m=>m.id.includes(':free')||m.pricing?.prompt==='0'||m.pricing?.prompt===0)
      .sort((a,b)=>a.name.localeCompare(b.name));
    renderModelSelector();
    toast(`✦ ${S.availableModels.length} free models loaded`);
  }catch(e){
    toast('✕ Could not fetch models: '+e.message);
  }
}

function openModelPicker(){
  if(!S.availableModels.length){
    fetchOpenRouterModels().then(()=>{
      document.getElementById('modelPicker').style.display='block';
      filterModels('');
    });
  } else {
    const picker=document.getElementById('modelPicker');
    picker.style.display=picker.style.display==='none'?'block':'none';
    if(picker.style.display==='block') filterModels(document.getElementById('modelSearch')?.value||'');
  }
}

function filterModels(query){
  const list=document.getElementById('modelList');
  if(!list) return;
  const q=query.toLowerCase();
  const filtered=S.availableModels.filter(m=>
    m.name.toLowerCase().includes(q)||m.id.toLowerCase().includes(q)
  );
  list.innerHTML=filtered.slice(0,40).map(m=>`
    <div onclick="selectModel('${m.id}')"
      style="padding:6px 8px;background:var(--s2);border:1px solid var(--b1);border-radius:4px;cursor:pointer;transition:border-color .15s"
      onmouseover="this.style.borderColor='var(--blue)'"
      onmouseout="this.style.borderColor='var(--b1)'">
      <div style="font-size:10px;font-weight:500;color:var(--text)">${m.name}</div>
      <div style="font-size:8.5px;font-family:'JetBrains Mono',monospace;color:var(--text3);margin-top:1px">${m.id} · ctx: ${((m.context_length||8000)/1000).toFixed(0)}k</div>
    </div>`).join('');
}

function selectModel(id){
  const m=S.availableModels.find(x=>x.id===id);
  if(!m) return;
  S.selectedModel=m;
  S.orModel=m.id;
  const disp=document.getElementById('selectedModelDisplay');
  if(disp) disp.textContent=m.name;
  const info=document.getElementById('modelContextInfo');
  if(info) info.textContent=`ctx: ${((m.context_length||8000)/1000).toFixed(0)}k tokens · ${m.id}`;
  document.getElementById('modelPicker').style.display='none';
  localStorage.setItem('vexxe_selected_model',m.id);
  toast(`✓ Model: ${m.name}`);
}

function renderModelSelector(){
  const saved=localStorage.getItem('vexxe_selected_model');
  if(saved){
    const m=S.availableModels.find(x=>x.id===saved);
    if(m){selectModel(m.id);return;}
  }
  if(S.availableModels.length) selectModel(S.availableModels[0].id);
}

// ═══════════════════════════════════════
// TOKEN GUARD
// ═══════════════════════════════════════
function estimateTokens(text){
  return Math.ceil(text.length/4);
}

function checkTokenLimit(prompt){
  if(!S.selectedModel) return true;
  const maxCtx=S.selectedModel.context_length||8000;
  const estimated=estimateTokens(prompt);
  const limit=Math.floor(maxCtx*0.8);
  if(estimated>limit){
    toast(`✕ Prompt too long — ~${estimated} tokens, model max ~${limit}`);
    const listEl=document.getElementById('fillerList');
    if(listEl) listEl.innerHTML=`<div class="sil-result-item" style="border-color:rgba(255,84,97,.3);background:rgba(255,84,97,0.08)"><div style="color:var(--red);font-weight:600;margin-bottom:4px">Token Limit Exceeded</div><div style="font-size:10px;color:var(--text2)">~${estimated} tokens estimated but "${S.selectedModel.name}" supports ~${limit}.<br><br>Options:<br>· Switch to a larger-context model<br>· Shorten your pasted script<br>· Trim the video before analysing</div></div>`;
    return false;
  }
  return true;
}

// Robust JSON extractor — handles text-before-JSON, markdown fences,
// {findings:[]} wrappers, and truncated arrays.
function _extractFindings(raw){
  const clean = raw.replace(/```json|```/gi,'').trim();

  const tryParse = str => {
    try {
      const p = JSON.parse(str);
      if(Array.isArray(p)) return p;
      // Handle wrapped objects: {findings:[]} {cuts:[]} {results:[]}
      const arr = p.findings || p.cuts || p.results || p.highlights ||
                  Object.values(p).find(v=>Array.isArray(v));
      if(arr) return arr;
    } catch(e){}
    return null;
  };

  // 1. Try the full clean string
  let res = tryParse(clean);
  if(res) return res;

  // 2. Find first [...] block (handles preamble text)
  const arrM = clean.match(/\[[\s\S]*\]/);
  if(arrM){ res=tryParse(arrM[0]); if(res) return res; }

  // 3. Find first {...} block
  const objM = clean.match(/\{[\s\S]*\}/);
  if(objM){ res=tryParse(objM[0]); if(res) return res; }

  // 4. Truncated array — try closing it
  const partial = clean.match(/(\[[\s\S]*)\}[^}]*$/);
  if(partial){ res=tryParse(partial[1]+']}'); if(res) return res; }

  return null;
}

async function _fetchFromEndpoint(url, headers, body){
  const res = await fetch(url, {method:'POST', headers, body: JSON.stringify(body)});
  const data = await res.json();
  return {res, data};
}

async function _aiScriptFetch(body, attempt=1){
  const MAX=3;
  const pingEl = document.getElementById('aiAnalysisPing');

  // ── Route by selected provider ────────────────────────────────
  if(S.aiProvider === 'ollama'){
    try{
      const ollamaBody = {...body, model: S.ollamaModel};
      const {data} = await _fetchFromEndpoint(
        `${S.ollamaUrl}/v1/chat/completions`,
        {'Content-Type':'application/json'},
        ollamaBody
      );
      if(data.error) throw new Error(data.error.message||'Ollama error');
      return data;
    } catch(e){
      throw new Error(`Ollama failed: ${e.message}\n\nMake sure Ollama is running: ollama serve`);
    }
  }

  // ── Try OpenRouter ────────────────────────────────────────────
  if(S.orKey){
    try{
      const {res, data} = await _fetchFromEndpoint(
        'https://openrouter.ai/api/v1/chat/completions',
        {'Content-Type':'application/json','Authorization':`Bearer ${S.orKey}`,'HTTP-Referer':'http://localhost'},
        body
      );
      if(data.error){
        const code = data.error.code || res.status;
        const msg  = data.error.message || '';
        const is429 = code===429 || res.status===429 ||
                      msg.toLowerCase().includes('rate') || msg.includes('429');
        if(is429 && attempt < MAX){
          const wait = attempt * 15;
          let remaining = wait;
          const iv = setInterval(()=>{
            remaining--;
            if(pingEl) pingEl.innerHTML=`<span style="color:#facc15">⏳ Rate limited — retrying in ${remaining}s (${attempt}/${MAX-1})</span>`;
            if(remaining<=0) clearInterval(iv);
          },1000);
          if(pingEl) pingEl.innerHTML=`<span style="color:#facc15">⏳ Rate limited — retrying in ${wait}s (${attempt}/${MAX-1})</span>`;
          await new Promise(r=>setTimeout(r, wait*1000));
          clearInterval(iv);
          return _aiScriptFetch(body, attempt+1);
        }
        if(code===402) throw new Error('OpenRouter credit limit reached');
        throw new Error(msg || `OpenRouter HTTP ${res.status}`);
      }
      return data;
    } catch(orErr){
      // If Ollama is available, fall through to it — otherwise rethrow
      if(!S.ollamaUrl){ throw orErr; }
      if(pingEl) pingEl.innerHTML=`<span style="color:#facc15">⚠ OpenRouter failed — trying Ollama (${S.ollamaModel})…</span>`;
    }
  }

  // ── Ollama fallback (OpenAI-compatible API) ───────────────────
  try{
    const ollamaBody = {...body, model: S.ollamaModel};
    const {data} = await _fetchFromEndpoint(
      `${S.ollamaUrl}/v1/chat/completions`,
      {'Content-Type':'application/json'},
      ollamaBody
    );
    if(data.error) throw new Error(data.error.message || 'Ollama error');
    if(pingEl) pingEl.innerHTML=`<span style="color:var(--teal)">⟳ Using Ollama · ${S.ollamaModel}</span>`;
    return data;
  } catch(ollamaErr){
    throw new Error(`OpenRouter unavailable + Ollama failed: ${ollamaErr.message}\n\nMake sure Ollama is running: ollama serve`);
  }
}

// Build SRT string from S.captions
function _buildSRT(){
  const fmt = t => {
    const h=Math.floor(t/3600), m=Math.floor((t%3600)/60), s=t%60;
    return `${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:${String(Math.floor(s)).padStart(2,'0')},${String(Math.round((s%1)*1000)).padStart(3,'0')}`;
  };
  return S.captions.map((c,i)=>`${i+1}\n${fmt(c.start)} --> ${fmt(c.end)}\n${c.text}`).join('\n\n');
}

// ── Script diff helpers ──────────────────────────────────────────────────────

// Strip punctuation + lowercase for word comparison
function _normalizeWords(text){
  return text.toLowerCase().replace(/[^a-z0-9\s']/g,'').split(/\s+/).filter(Boolean);
}

// LCS alignment — returns array of {si, ti} matched index pairs
function _lcsAlign(sw, tw){
  const S=sw.length, T=tw.length;
  // Build DP table (flat array for speed)
  const dp=new Int32Array((S+1)*(T+1));
  for(let i=S-1;i>=0;i--){
    for(let j=T-1;j>=0;j--){
      const idx=i*(T+1)+j;
      if(sw[i]===tw[j]) dp[idx]=1+dp[(i+1)*(T+1)+(j+1)];
      else dp[idx]=Math.max(dp[(i+1)*(T+1)+j], dp[i*(T+1)+(j+1)]);
    }
  }
  // Traceback
  const pairs=[];
  let i=0,j=0;
  while(i<S&&j<T){
    if(sw[i]===tw[j]){ pairs.push({si:i,ti:j}); i++;j++; }
    else if(dp[(i+1)*(T+1)+j]>=dp[i*(T+1)+(j+1)]) i++;
    else j++;
  }
  return pairs;
}

// Build structured diff blocks from script text + S.captions
// Returns array of {kind:'match'|'adlib'|'skipped', text, start?, end?}
function _buildScriptDiff(scriptText, captions){
  const sw = _normalizeWords(scriptText);
  const tw = captions.map(c=>_normalizeWords(c.text)[0]||''); // one word per caption entry
  // tw may be multi-word captions — flatten to word list with caption index
  const wordList=[]; // {word, capIdx}
  captions.forEach((c,ci)=>{
    _normalizeWords(c.text).forEach(w=>wordList.push({word:w,capIdx:ci}));
  });
  const twWords=wordList.map(w=>w.word);

  const pairs=_lcsAlign(sw,twWords);

  const blocks=[];
  let si=0,ti=0,pi=0;

  const pushSkipped=(from,to)=>{
    if(from>=to) return;
    blocks.push({kind:'skipped', text:sw.slice(from,to).join(' ')});
  };
  const pushAdlib=(from,to)=>{
    if(from>=to) return;
    const cap0=captions[wordList[from]?.capIdx];
    const cap1=captions[wordList[to-1]?.capIdx];
    blocks.push({kind:'adlib', text:twWords.slice(from,to).join(' '),
      start:cap0?.start??null, end:cap1?.end??null});
  };
  const pushMatch=(siFrom,siTo,tiFrom,tiTo)=>{
    if(siFrom>=siTo) return;
    const cap0=captions[wordList[tiFrom]?.capIdx];
    const cap1=captions[wordList[tiTo-1]?.capIdx];
    blocks.push({kind:'match', text:sw.slice(siFrom,siTo).join(' '),
      start:cap0?.start??null, end:cap1?.end??null});
  };

  for(const {si:ms,ti:mt} of pairs){
    pushSkipped(si,ms);
    pushAdlib(ti,mt);
    pushMatch(si,ms+1,ti,mt+1);
    si=ms+1; ti=mt+1;
  }
  pushSkipped(si,sw.length);
  pushAdlib(ti,twWords.length);

  return blocks;
}

// Render diff blocks into a human-readable string for the prompt
function _formatDiffForPrompt(blocks){
  const tf=t=>t==null?'?s':`${t.toFixed(1)}s`;
  return blocks.map(b=>{
    if(b.kind==='match')
      return `[ON-SCRIPT ${tf(b.start)}–${tf(b.end)}] "${b.text}"`;
    if(b.kind==='adlib')
      return `[AD-LIB ${tf(b.start)}–${tf(b.end)}] "${b.text}"`;
    if(b.kind==='skipped')
      return `[SKIPPED from script — never said] "${b.text}"`;
  }).join('\n');
}

async function runAIScriptAnalysis(){
  const script   = (document.getElementById('scriptInput')?.value||'').trim();
  const hasCapts  = S.captions.length > 0;
  const hasScript = script.length > 0;

  if(!hasCapts){ toast('✕ Transcribe the video first — AI analysis requires captions'); return; }
  if(!hasScript && !hasCapts){ toast('Transcribe video OR paste a script first'); return; }
  if(!S.orKey && !S.ollamaUrl){ toast('Add openrouter_key or ollama_url to config.json'); return; }
  if(!S.orKey && !S.ollamaModel){ toast('Set ollama_model in config.json'); return; }
  if(S.orKey && !S.selectedModel){ toast('Select a model in the AI tab'); return; }

  const pingEl = document.getElementById('aiAnalysisPing');
  const listEl = document.getElementById('fillerList');
  if(pingEl){ pingEl.textContent='⏳ Analysing…'; pingEl.style.color='var(--teal)'; }
  if(listEl) listEl.innerHTML='<div class="loading-state"><span class="spin">✦</span><p>AI reviewing content…</p></div>';

  const dur = S.duration || 60;

  // ── Build context block ──────────────────────────────────────────────
  // When both script + captions exist: pre-compute word-level diff so AI
  // gets a structured map instead of two raw blobs to compare blindly.
  // When only captions: fall back to raw SRT.
  // When only script: rough word timing estimate.

  let contextBlock, diffStats='';

  if(hasScript && hasCapts){
    const diffBlocks = _buildScriptDiff(script, S.captions);
    const adlibs   = diffBlocks.filter(b=>b.kind==='adlib');
    const skipped  = diffBlocks.filter(b=>b.kind==='skipped');
    diffStats = `(${adlibs.length} ad-lib regions · ${skipped.length} skipped script sections)`;
    contextBlock = `SCRIPT-TRANSCRIPT DIFF ${diffStats}:\n`+_formatDiffForPrompt(diffBlocks);
  } else if(hasCapts){
    contextBlock = `SRT TRANSCRIPT (actual speech with exact timestamps):\n`+_buildSRT();
  } else {
    contextBlock = `NO TRANSCRIPT — rough word timing only (unreliable):\n`+
      script.split(/\s+/).map((w,i)=>`[~${(i/2.5).toFixed(1)}s] ${w}`).join(' ')+
      '\n\n⚠ Timestamps are estimates only. Transcribe for accuracy.';
  }

  // ── Prompt ──────────────────────────────────────────────────────────
  const hasDiff = hasScript && hasCapts;
  const combinedPrompt =
`You are a video cleanup AI. Your ONLY job is to find removable sections in a talking-head video recording. Do NOT judge script quality, content, or message — the script is final and approved. Return JSON findings only — no markdown, no explanation.

${hasDiff
  ? `HOW THIS WORKS:
The SCRIPT-TRANSCRIPT DIFF shows the creator's script aligned against what was actually spoken.
- [ON-SCRIPT start–end] = said correctly
- [AD-LIB start–end] = spoken but not in script — likely a retake restart or stumble
- [SKIPPED] = in script but not said — no cut needed`
  : `HOW THIS WORKS:
- Transcript is the actual spoken audio with timestamps`
}

Return ONLY this JSON shape:
{"findings": [{"start":0.00,"end":0.00,"type":"...","text":"...","reason":"...","cut":true}]}

Types (ONLY these — do not invent others):
- filler    → Filler words: um, uh, like, you know, literally, basically, kind of, sort of
- retake    → Speaker repeated a sentence or phrase already said — flag the EARLIER occurrence
- dead_air  → Silence or pause with no speech longer than 0.5s

Rules:
• Do NOT add highlight, weak, or any other type — only filler, retake, dead_air
• Do NOT judge whether the script content is good or bad
• Use ONLY timestamps that appear in the transcript — do NOT invent times
• reason must be ≤8 words describing WHAT to cut, not WHY the content is bad
• All findings have cut:true

---
Video duration: ${dur.toFixed(1)}s

${contextBlock}

Return findings JSON.`;

  if(!checkTokenLimit(combinedPrompt)) return;

  try{
    const body = {
      model:      S.selectedModel?.id || S.orModel || S.ollamaModel,
      max_tokens: 4096,
      messages:   [{ role:'user', content: combinedPrompt }],
    };

    const data = await _aiScriptFetch(body);

    const rawContent = data.choices?.[0]?.message?.content || '';
    if(!rawContent) throw new Error('Model returned empty response');

    const findings = _extractFindings(rawContent);
    if(!findings || !findings.length)
      throw new Error(`Could not parse JSON from model response.\n\nRaw output:\n${rawContent.slice(0,400)}`);

    // Snapshot right before mutating S.cuts — only once the AI call actually
    // succeeded, so a failed/empty response doesn't create a no-op undo step.
    saveHistory();

    // ── Map to S.cuts ────────────────────────────────────────────────
    const ts = Date.now();
    const newCuts = findings.map((f,i)=>({
      id:         `ai-${ts}-${i}`,
      start:      parseFloat(f.start)||0,
      end:        parseFloat(f.end)||0,
      type:       f.type||'weak',
      text:       f.text||'',
      aiNote:     f.reason||'',
      reason:     f.reason||'',
      selected:   f.cut !== false && f.type !== 'highlight',
      skipEnabled:f.type !== 'highlight',
      scriptPart: f.type === 'highlight',
      _src:       'ai',
    })).filter(c=>c.end > c.start); // drop zero-duration junk

    S.cuts = [...S.cuts.filter(c=>c._src!=='ai'), ...newCuts];
    renderAllFindings();
    renderTimeline();

    const cuts       = newCuts.filter(c=>c.selected);
    const highlights = newCuts.filter(c=>c.type==='highlight');
    const saved      = cuts.reduce((a,c)=>a+(c.end-c.start),0);
    const summary    = `✦ ${cuts.length} cut${cuts.length!==1?'s':''} · ${highlights.length} highlight${highlights.length!==1?'s':''} · ${saved.toFixed(1)}s removable`;

    if(pingEl) pingEl.innerHTML=`<span style="color:var(--teal)">${summary}</span>`;
    toast(summary);

  } catch(e){
    const msg = e.message||String(e);
    if(pingEl) pingEl.innerHTML=`<span style="color:var(--red)">✕ ${msg.split('\n')[0]}</span>`;
    const is429 = msg.toLowerCase().includes('rate limit');
    if(listEl) listEl.innerHTML=`
      <div class="sil-result-item" style="border-color:rgba(255,84,97,.3);background:rgba(255,84,97,0.08)">
        <div style="color:var(--red);font-weight:600;margin-bottom:6px">AI Error</div>
        <div style="font-size:10px;color:var(--text2);white-space:pre-wrap;line-height:1.6">${msg.split('\n')[0]}</div>
        <div style="margin-top:8px;display:flex;gap:6px;align-items:center">
          <button class="act-btn" style="margin:0;font-size:9px;padding:3px 10px" onclick="runAIScriptAnalysis()">↺ Retry</button>
          <span style="font-size:9px;color:var(--text3)">${is429?'Free models rate limit quickly — try switching model':'Try: switch model · shorten script'}</span>
        </div>
      </div>`;
    toast('✕ '+msg.split('\n')[0]);
  }
}

// ═══════════════════════════════════════
// TIER-2 AI EDIT REVIEW (Part F2) — review, not detection
// ═══════════════════════════════════════
// Tier 1 (js/detection/linter.js) is deterministic and always available.
// This is the LLM cross-check: reviews the PLANNED edit (segments already
// applied + cuts still pending) for pacing/hook strength/meaning-changing
// cuts/wrong-retake-kept, gated behind Deep Mode since it's an extra model
// call on top of runAIScriptAnalysis(). Reuses the exact ACTION-block
// vocabulary + card UI the chat panel already has (_parseActionBlocks,
// appendChatMsg) — "review mode: approve/reject per suggestion" falls out
// of that for free, no new UI needed.
async function runTier2EditReview(){
  if(S.aiProvider==='openrouter' && (!S.orKey || !S.selectedModel)){ toast('⚠ Tier-2 review needs an OpenRouter key + model selected'); return; }
  if(S.aiProvider==='ollama' && !S.ollamaModel){ toast('⚠ Tier-2 review needs an Ollama model selected'); return; }
  if(!S.segments.length && !S.cuts.length){ toast('Nothing to review yet — detect or apply some cuts first'); return; }

  const segSummary = S.segments.length
    ? S.segments.map((s,i)=>`Segment ${i+1}: ${s.duration.toFixed(1)}s kept (source ${s.sourceStart.toFixed(2)}s–${s.sourceEnd.toFixed(2)}s)`).join('\n')
    : '(no cuts applied yet — reviewing pending cuts against the full clip)';
  const cutSummary = S.cuts.length
    ? S.cuts.map(c=>`[${c.selected?'SELECTED':'pending'}] ${c.type} ${c.start.toFixed(2)}s–${c.end.toFixed(2)}s${c.aiNote?` — ${c.aiNote}`:''}${c.text?` ("${c.text}")`:''}`).join('\n')
    : '(no cuts detected)';

  const script = document.getElementById('scriptInput')?.value?.trim();
  let diffBlock = '';
  if(script && S.captions.length){
    const diffBlocks = _buildScriptDiff(script, S.captions);
    diffBlock = `\n\nSCRIPT-TRANSCRIPT DIFF:\n${_formatDiffForPrompt(diffBlocks)}`;
  }

  const keptDur = S.segments.reduce((a,s)=>a+s.duration,0);
  const prompt = `You are reviewing a PLANNED EDIT for a talking-head video before it's applied — you are NOT detecting new cuts, you are critiquing the ones already found. Answer these four things, briefly:
1. Pacing verdict — does this read as too choppy, too slow, or about right?
2. Hook check — is the first 3 seconds of KEPT footage strong? If weak, say what's wrong.
3. Any cuts that risk changing the meaning of what was said — name the specific cut (by its time range) and why.
4. Any retakes where the WRONG occurrence looks kept (earlier vs later) — name the specific time range.

If you want to suggest a concrete fix, output ACTION blocks in the exact same format the chat assistant uses — these render as clickable Apply buttons so the user approves or ignores each one individually, nothing here applies automatically:

ACTION: <action>
START: 0.00
END: 0.00
REASON: <brief reason>

Available actions: add_cut, add_highlight, seek, trim_before, trim_after, split, select_cut, deselect_cut, add_marker, delete_cut, select_type, deselect_type (TYPE: dead_air|filler|retake|weak|silence|highlight).
Use ONLY timestamps that appear below — never invent times. Don't restate the whole edit; focus on what's actually questionable. Be concise.

---
SEGMENTS (kept footage, in order):
${segSummary}

DETECTED CUTS (selected = will be removed on next Apply Cuts):
${cutSummary}${diffBlock}

Duration: ${(S.duration||0).toFixed(1)}s total, ${keptDur.toFixed(1)}s kept after currently-selected cuts.`;

  if(!checkTokenLimit(prompt)) return;

  toast('✦ Running Tier-2 AI edit review...');
  try{
    const data = await _aiScriptFetch({
      model: S.selectedModel?.id || S.orModel || S.ollamaModel,
      max_tokens: 1200,
      messages: [{role:'user', content: prompt}],
    });
    const reply = data.choices?.[0]?.message?.content || '';
    if(!reply) throw new Error('Model returned empty response');

    if(document.getElementById('chatPanel')?.style.display !== 'flex') toggleChatPanel();
    appendChatMsg('ai', `**Tier-2 Edit Review**\n\n${reply}`);
    S.chatHistory.push({role:'assistant', content: reply});
    toast('✓ Tier-2 review ready — see AI Chat panel');
  } catch(e){
    toast(`✕ Tier-2 review failed: ${e.message.split('\n')[0]}`);
  }
}

async function runAIAnalysis(){
  if(!S.current){toast('No video loaded');return;}

  // Local Whisper path — just run audio analysis, no network call
  if(S.aiSource==='whisper'){ analyzeAudio(); return; }

  // OpenRouter path
  if(!S.orKey){toast('Add openrouter_key to config.json');return;}
  const body=document.getElementById('silenceResults');
  body.innerHTML=`<div class="loading-state"><span class="spin">✦</span><p>Analyzing audio & consulting AI via OpenRouter...</p></div>`;
  const frames=await extractAudioData();
  if(!frames)return;
  const rawSegs=detectSilences(frames);
  if(!rawSegs.length){body.innerHTML='<div class="empty-state">No significant silences detected with current settings.</div>';return;}

  saveHistory(); // before either the AI-annotated or fallback branch mutates S.cuts
  const segSummary=rawSegs.map((s,i)=>`Segment ${i+1}: ${s.start.toFixed(2)}s–${s.end.toFixed(2)}s (${(s.end-s.start).toFixed(2)}s)`).join('\n');
  const prompt=`You're an expert video editor reviewing silence segments in a UGC/creator video that's ${S.duration.toFixed(1)}s long.

Silence segments detected:
${segSummary}

For each segment, advise whether to CUT it or KEEP it, and give a short reason (1 sentence max).
Consider: natural breathing pauses are okay to keep, dead air >0.8s should be cut, intro/outro silence might be intentional.

Return ONLY a JSON array matching the same segment count, like:
[{"cut":true,"note":"Dead air between sentences"}, {"cut":false,"note":"Natural breathing pause"}, ...]`;

  try{
    const res=await fetch('https://openrouter.ai/api/v1/chat/completions',{
      method:'POST',
      headers:{'Content-Type':'application/json','Authorization':`Bearer ${S.orKey}`,'HTTP-Referer':'http://localhost'},
      body:JSON.stringify({model:S.orModel||S.selectedModel?.id,max_tokens:1000,messages:[{role:'user',content:prompt}]})
    });
    const data=await res.json();
    if(data.error) throw new Error(data.error.message||JSON.stringify(data.error));
    const aiData=JSON.parse(data.choices[0].message.content.replace(/```json|```/g,'').trim());
    rawSegs.forEach((s,i)=>{if(aiData[i]){s.aiNote=aiData[i].note;s.cut=aiData[i].cut;}});
    const ts=Date.now();
    const aiAudioCuts=rawSegs.map((s,i)=>({
      id:`audio-${ts}-${i}`,start:s.start,end:s.end,
      type:'dead_air',selected:s.cut!==false,skipEnabled:true,scriptPart:false,
      text:'',aiNote:s.aiNote||'',_src:'audio'
    }));
    S.cuts=[...S.cuts.filter(c=>c._src!=='audio'),...aiAudioCuts];
    renderAllFindings();
    renderTimeline();
    toast(`✦ AI analyzed ${rawSegs.length} segments`);
  } catch(e){
    body.innerHTML=`<div class="ai-analysis-box" style="border-color:rgba(255,84,97,.3);background:rgba(255,84,97,0.15)"><div class="ai-label" style="color:var(--red)">AI Error</div><p>${e.message}</p></div>`;
    const ts=Date.now();
    const fallbackCuts=rawSegs.map((s,i)=>({
      id:`audio-${ts}-${i}`,start:s.start,end:s.end,
      type:'dead_air',selected:s.cut!==false,skipEnabled:true,scriptPart:false,
      text:'',aiNote:'',_src:'audio'
    }));
    S.cuts=[...S.cuts.filter(c=>c._src!=='audio'),...fallbackCuts];
    renderAllFindings();
  }
}
