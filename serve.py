import os
import re
import sys
import json
import shutil
import subprocess
import threading
import tempfile
import time
import http.server
import socketserver
import webview

BASE_DIR = os.path.dirname(os.path.abspath(__file__))
HTTP_PORT = 8080

# Windows' default console codepage (cp1252) can't encode characters like
# ✓/✕ used throughout log() below — an uncaught UnicodeEncodeError here has
# previously killed background threads (e.g. the whisper auto-ping thread)
# mid-startup. Reconfigure to UTF-8 with replacement so a stray character
# degrades to '?' instead of crashing the thread that logged it.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding='utf-8', errors='replace')
    except Exception:
        pass


# ── Logger ────────────────────────────────────────────────────────────────────

def log(category, msg, *extra):
    ts = time.strftime('%H:%M:%S')
    prefix = f'[{ts}] [{category}]'
    try:
        print(f'{prefix} {msg}')
        for line in extra:
            print(f'{" " * len(prefix)}   {line}')
    except UnicodeEncodeError:
        # Last-resort fallback if reconfigure() itself wasn't available
        # (older Python) — never let a log call crash its caller's thread.
        safe_msg = msg.encode('ascii', 'replace').decode('ascii')
        print(f'{prefix} {safe_msg}')


# ── Config ────────────────────────────────────────────────────────────────────

def _load_config():
    try:
        with open(os.path.join(BASE_DIR, 'config.json'), encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return {}

_cfg                = _load_config()
MODEL_SIZE          = _cfg.get('whisper_model',        'base')
DEVICE              = 'cuda'
COMPUTE_TYPE        = 'float16'
WHISPER_BACKEND     = _cfg.get('whisper_backend',      'whisperx')  # 'parakeet' | 'whisperx' | 'faster-whisper'
WHISPERX_MODEL      = _cfg.get('whisperx_model',       'distil-large-v3')
WHISPERX_BATCH_SIZE = int(_cfg.get('whisperx_batch_size', 16))
PARAKEET_MODEL_ID   = _cfg.get('parakeet_model',       'nvidia/parakeet-tdt-0.6b-v3')


def _write_config(updates):
    """Merge updates dict into config.json and update module-level globals."""
    global WHISPER_BACKEND, WHISPERX_MODEL, WHISPERX_BATCH_SIZE, PARAKEET_MODEL_ID, _whisperx_model
    cfg_path = os.path.join(BASE_DIR, 'config.json')
    try:
        with open(cfg_path, encoding='utf-8') as f:
            data = json.load(f)
    except Exception:
        data = {}
    data.update(updates)
    with open(cfg_path, 'w', encoding='utf-8') as f:
        json.dump(data, f, indent=2)
    if 'whisper_backend' in updates:
        WHISPER_BACKEND = updates['whisper_backend']
    if 'whisperx_model' in updates:
        if updates['whisperx_model'] != WHISPERX_MODEL:
            _whisperx_model = None   # force reload with new model
        WHISPERX_MODEL = updates['whisperx_model']
    if 'whisperx_batch_size' in updates:
        WHISPERX_BATCH_SIZE = int(updates['whisperx_batch_size'])
    if 'parakeet_model' in updates:
        PARAKEET_MODEL_ID = updates['parakeet_model']
    log('CONFIG', f'Saved: {updates}')

PRESET_MAP = {
    "fast":     {"nvenc": "p2", "tune": None,  "bitrate": "6M",  "x264": "fast",   "crf": "26"},
    "balanced": {"nvenc": "p4", "tune": "hq",  "bitrate": "8M",  "x264": "medium", "crf": "22"},
    "quality":  {"nvenc": "p6", "tune": "hq",  "bitrate": "15M", "x264": "slow",   "crf": "18"},
}


# ── Parakeet TDT model (lazy, singleton) ─────────────────────────────────────

_parakeet_model = None
_parakeet_lock  = threading.Lock()

def _get_parakeet_model():
    global _parakeet_model
    with _parakeet_lock:
        if _parakeet_model is None:
            log('PARAKEET', f'Loading {PARAKEET_MODEL_ID} (NeMo)...')
            t0 = time.time()
            try:
                import nemo.collections.asr as nemo_asr
                m = nemo_asr.models.ASRModel.from_pretrained(PARAKEET_MODEL_ID)
                m.cuda()
                m.eval()
                _parakeet_model = m
                log('PARAKEET', f'✓ Ready on GPU ({time.time()-t0:.1f}s)')
            except Exception as e:
                log('PARAKEET', f'✕ Failed to load: {e}')
                raise
    return _parakeet_model


# ── Whisper model (lazy, singleton) ──────────────────────────────────────────

_whisper_model = None
_whisper_lock  = threading.Lock()

def _get_whisper_model():
    global _whisper_model
    with _whisper_lock:
        if _whisper_model is None:
            log('WHISPER', f'Loading model "{MODEL_SIZE}" on {DEVICE} ({COMPUTE_TYPE})...')
            t0 = time.time()
            try:
                from faster_whisper import WhisperModel
                _whisper_model = WhisperModel(MODEL_SIZE, device=DEVICE, compute_type=COMPUTE_TYPE)
                log('WHISPER', f'✓ Model ready — GPU ({time.time()-t0:.1f}s)')
            except Exception as e:
                log('WHISPER', f'GPU load failed: {e}')
                log('WHISPER', 'Retrying on CPU (int8)...')
                from faster_whisper import WhisperModel
                _whisper_model = WhisperModel(MODEL_SIZE, device='cpu', compute_type='int8')
                log('WHISPER', f'✓ Model ready — CPU ({time.time()-t0:.1f}s)')
    return _whisper_model


# ── Silero VAD model (lazy, singleton) ───────────────────────────────────────

_vad_model = None
_vad_lock  = threading.Lock()

def _get_vad_model():
    global _vad_model
    with _vad_lock:
        if _vad_model is None:
            log('VAD', 'Loading Silero VAD model...')
            t0 = time.time()
            from silero_vad import load_silero_vad
            _vad_model = load_silero_vad()
            log('VAD', f'✓ VAD ready ({time.time()-t0:.1f}s)')
    return _vad_model


# ── WhisperX models (lazy, per-language alignment cache) ─────────────────────

_whisperx_model      = None
_whisperx_lock       = threading.Lock()
_whisperx_align      = {}   # {lang: (align_model, metadata)}
_whisperx_align_lock = threading.Lock()

def _get_whisperx_model():
    global _whisperx_model
    with _whisperx_lock:
        if _whisperx_model is None:
            import whisperx
            log('WHISPERX', f'Loading {WHISPERX_MODEL} on {DEVICE} ({COMPUTE_TYPE})...')
            t0 = time.time()
            _whisperx_model = whisperx.load_model(
                WHISPERX_MODEL, DEVICE, compute_type=COMPUTE_TYPE
            )
            log('WHISPERX', f'✓ Transcription model ready ({time.time()-t0:.1f}s)')
    return _whisperx_model

def _get_whisperx_align(language):
    global _whisperx_align
    with _whisperx_align_lock:
        if language not in _whisperx_align:
            import whisperx
            log('WHISPERX', f'Loading alignment model for lang={language}...')
            t0 = time.time()
            model_a, metadata = whisperx.load_align_model(
                language_code=language, device=DEVICE
            )
            _whisperx_align[language] = (model_a, metadata)
            log('WHISPERX', f'✓ Alignment model ready ({time.time()-t0:.1f}s)')
    return _whisperx_align[language]


# ── Retake detection (WhisperX segments) ─────────────────────────────────────

def _detect_retakes(segments):
    """
    Scan WhisperX segments for repeated sentences (retakes).
    Uses Jaccard word overlap — ≥70% overlap in a 10-segment lookback window
    marks the earlier occurrence as a retake (keep the last / best take).
    Returns list of {start, end, type, selected}.
    """
    import re as _re

    def _norm(text):
        t = text.lower().strip()
        t = _re.sub(r'[^\w\s]', '', t)
        t = _re.sub(r'\s+', ' ', t).strip()
        return t

    sents = []
    for seg in segments:
        text = _norm(seg.get('text', ''))
        if len(text) < 8:
            continue
        sents.append({'text': text, 'start': seg.get('start', 0), 'end': seg.get('end', 0)})

    retakes = []
    WINDOW  = 10
    marked  = set()  # prevent double-marking
    for i, s in enumerate(sents):
        lookback = sents[max(0, i - WINDOW):i]
        for j, prev in enumerate(reversed(lookback)):
            prev_idx = i - 1 - j
            if prev_idx in marked:
                continue
            a = set(s['text'].split())
            b = set(prev['text'].split())
            if not a or not b:
                continue
            jaccard = len(a & b) / len(a | b)
            if jaccard >= 0.70:
                marked.add(prev_idx)
                retakes.append({
                    'start':    round(float(prev['start']), 3),
                    'end':      round(float(prev['end']),   3),
                    'type':     'retake',
                    'selected': True,
                })
                break  # one retake match per current segment

    log('WHISPERX', f'Retake detection: {len(retakes)} retakes from {len(sents)} segments')
    return retakes


# ── ffmpeg helpers ────────────────────────────────────────────────────────────

def _nvenc_args(p):
    args = ['-c:v', 'h264_nvenc', '-preset', p['nvenc'], '-rc', 'vbr', '-b:v', p['bitrate']]
    if p.get('tune'):
        args += ['-tune', p['tune']]
    return args

def _x264_args(p):
    return ['-c:v', 'libx264', '-preset', p['x264'], '-crf', p['crf']]

def _aspect_filter(aspect, mode):
    """Crop-to-fill or pad-to-fit ffmpeg filter for a target aspect ratio
    like '9/16'. Uses ffmpeg's iw/ih expressions so it works at native
    resolution without a separate scale step. Returns '' if aspect is falsy
    (export ignores aspect entirely, matching bug #21's WYSIWYG fix)."""
    if not aspect:
        return ''
    try:
        tw_s, th_s = aspect.split('/')
        tw, th = float(tw_s), float(th_s)
        if tw <= 0 or th <= 0:
            return ''
    except Exception:
        return ''
    if mode == 'pad':
        w = f"trunc(max(iw,ih*{tw}/{th})/2)*2"
        h = f"trunc(max(ih,iw*{th}/{tw})/2)*2"
        return f"pad=w='{w}':h='{h}':x='(ow-iw)/2':y='(oh-ih)/2':color=black"
    w = f"trunc(min(iw,ih*{tw}/{th})/2)*2"
    h = f"trunc(min(ih,iw*{th}/{tw})/2)*2"
    return f"crop='{w}':'{h}'"

def _make_filter_complex(segments, flip_filter, sub_path=None, aspect_filter='',
                         image_layers=None, seg_meta=None, out_w=0, out_h=0):
    """image_layers: [{path,start,end,posX,posY,posZ}] (source time) — each
    becomes its own ffmpeg input (index 1, 2, ... — video source is input 0)
    plus an overlay stage gated by enable='between(t,...)' so it only shows
    for its [start,end] window on the (already gapless, post-concat)
    timeline. seg_meta maps source time -> that timeline the same way
    caption/text-layer burn-in does."""
    parts = []
    for i, seg in enumerate(segments):
        s, e = round(seg["start"], 3), round(seg["end"], 3)
        parts.append(f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{i}]")
        parts.append(f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}]")
    n = len(segments)
    interleaved = "".join(f"[v{i}][a{i}]" for i in range(n))
    parts.append(f"{interleaved}concat=n={n}:v=1:a=1[outv][outa]")
    out_v = "[outv]"
    if sub_path:
        esc = sub_path.replace("\\", "/").replace(":", "\\:")
        parts.append(f"[outv]subtitles='{esc}'[subv]")
        out_v = "[subv]"
    if image_layers:
        def src_to_tl(t):
            for seg in (seg_meta or []):
                if seg["sourceStart"] <= t <= seg["sourceEnd"]:
                    return seg["timelineStart"] + (t - seg["sourceStart"])
            return None
        for idx, layer in enumerate(image_layers):
            ts = src_to_tl(layer["start"])
            if ts is None:
                continue
            te = src_to_tl(layer["end"])
            if te is None:
                te = ts + (layer["end"] - layer["start"])
            scale_factor = layer.get("posZ") or 1.0
            disp_w = max(2, int((out_w or 1080) * 0.3 * scale_factor))  # default sticker width ~30% of frame, scaled by posZ
            px = (layer.get("posX") if layer.get("posX") is not None else 50) / 100 * (out_w or 1080)
            py = (layer.get("posY") if layer.get("posY") is not None else 50) / 100 * (out_h or 1920)
            img_input_idx = idx + 1  # input 0 is the source video
            parts.append(f"[{img_input_idx}:v]scale={disp_w}:-1[img{idx}]")
            parts.append(
                f"{out_v}[img{idx}]overlay=x='{px:.1f}-w/2':y='{py:.1f}-h/2'"
                f":enable='between(t,{ts:.3f},{te:.3f})'[ov{idx}]"
            )
            out_v = f"[ov{idx}]"
    if aspect_filter:
        parts.append(f"{out_v}{aspect_filter}[av]")
        out_v = "[av]"
    if flip_filter:
        parts.append(f"{out_v}{flip_filter}[fv]")
        out_v = "[fv]"
    return ";".join(parts), out_v

def _probe_dimensions(source_path):
    """ffprobe video width/height. Falls back to 1920x1080 on failure."""
    result = subprocess.run(
        ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
         '-show_entries', 'stream=width,height', '-of', 'csv=s=x:p=0', source_path],
        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
    )
    try:
        w_s, h_s = result.stdout.strip().split('x')
        return int(w_s), int(h_s)
    except Exception:
        return 1920, 1080

def _compute_output_dims(source_path, aspect, aspect_mode):
    """Source dimensions after the same crop/pad math _aspect_filter() applies
    — needed so ASS PlayResX/Y (and therefore burned-in caption position/size)
    match the actual exported frame, not the source frame."""
    w, h = _probe_dimensions(source_path)
    if not aspect:
        return w, h
    try:
        tw_s, th_s = aspect.split('/')
        tw, th = float(tw_s), float(th_s)
        if tw <= 0 or th <= 0:
            return w, h
    except Exception:
        return w, h
    if aspect_mode == 'pad':
        ow = int(max(w, h * tw / th) // 2 * 2)
        oh = int(max(h, w * th / tw) // 2 * 2)
    else:
        ow = int(min(w, h * tw / th) // 2 * 2)
        oh = int(min(h, w * th / tw) // 2 * 2)
    return ow, oh

def _hex_to_ass_color(hex_color, alpha=0):
    """'#rrggbb' -> ASS &HAABBGGRR (note reversed byte order vs standard RGB,
    alpha 0=opaque/255=transparent — opposite of CSS alpha)."""
    hex_color = (hex_color or '#ffffff').lstrip('#')
    if len(hex_color) != 6:
        hex_color = 'ffffff'
    r, g, b = hex_color[0:2], hex_color[2:4], hex_color[4:6]
    return f'&H{alpha:02X}{b}{g}{r}'.upper()

def _parse_bg_color(bg):
    """Caption-style background dropdown value ('rgba(r,g,b,a)', 'transparent',
    or '') -> (ass_back_colour, has_opaque_box). Values come from the fixed
    preset list in clipcut.html (Black/Lime/Red/None)."""
    if not bg or bg == 'transparent':
        return '&H00000000', False
    m = re.match(r'rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+))?\)', bg)
    if not m:
        return '&H00000000', False
    r, g, b = int(m.group(1)), int(m.group(2)), int(m.group(3))
    a = float(m.group(4)) if m.group(4) else 1.0
    ass_alpha = int(round((1 - a) * 255))
    return f'&H{ass_alpha:02X}{b:02X}{g:02X}{r:02X}'.upper(), True

def _generate_text_layer_dialogue(text_layers, seg_meta, out_w, out_h):
    """Dialogue lines for freeform "Add Text" layers — each carries its own
    font/size/color/stroke/position (per-object, not a shared style like
    captions), so every property is an inline override rather than a named
    Style. \\an5\\pos() = middle-center anchor, matching the live preview
    overlay's transform:translate(-50%,-50%) at posX%/posY%. Layer=1 (above
    captions' layer=0) so text objects render on top if they overlap in time."""
    def src_to_tl(t):
        for seg in seg_meta:
            if seg["sourceStart"] <= t <= seg["sourceEnd"]:
                return seg["timelineStart"] + (t - seg["sourceStart"])
        return None

    def fmt(s):
        h, m = int(s // 3600), int((s % 3600) // 60)
        sec = s % 60
        return f"{h:d}:{m:02d}:{sec:05.2f}"

    lines = []
    for layer in text_layers:
        ts = src_to_tl(layer["start"])
        if ts is None:
            continue
        te = src_to_tl(layer["end"])
        if te is None:
            te = ts + (layer["end"] - layer["start"])

        st = layer.get("style") or {}
        font_name = (st.get("fontFamily") or "Outfit").split(",")[0].strip("'\" ")
        font_size = int(st.get("fontSize") or 32)
        weight = str(st.get("fontWeight") or "800")
        bold = 1 if (weight.isdigit() and int(weight) >= 600) or weight == "bold" else 0
        color = _hex_to_ass_color(st.get("color") or "#ffffff")
        stroke_on = bool(st.get("strokeEnabled"))
        outline_color = _hex_to_ass_color(st.get("strokeColor") or "#000000")
        outline_px = (st.get("strokeThickness") or 0) if stroke_on else 0
        pos_x = (st.get("posX") if st.get("posX") is not None else 50) / 100 * out_w
        pos_y = (st.get("posY") if st.get("posY") is not None else 50) / 100 * out_h
        text = (layer.get("text") or "").replace("\n", "\\N").replace("{", "(").replace("}", ")")
        if not text:
            continue

        override = (
            f"{{\\an5\\pos({pos_x:.1f},{pos_y:.1f})\\fn{font_name}\\fs{font_size}"
            f"\\b{bold}\\c{color}\\3c{outline_color}\\bord{outline_px:.1f}}}"
        )
        lines.append(f"Dialogue: 1,{fmt(ts)},{fmt(te)},Default,,0,0,0,,{override}{text}")
    return lines

def _generate_ass(captions, seg_meta, text_style, preview_height_px, out_w, out_h, caption_mode='static', text_layers=None):
    """Build an ASS subtitle file from S.textStyle so burned-in export
    captions match the Captions inspector tab's font/size/color/stroke/
    position instead of always rendering plain text (bug #10's remaining half).

    Font size/stroke are set in the browser as CSS px against the on-screen
    preview element, which is a different pixel size than the actual export
    resolution — preview_height_px (video.clientHeight at export time) lets
    us scale them proportionally to out_h instead of baking in the preview's
    literal pixel values. posX/posY are already percentages, so they map
    directly to out_w/out_h with no scaling needed.

    Known limitation: fontFamily only works if that font is installed on the
    machine running ffmpeg. The fixed preset list (Outfit, JetBrains Mono,
    Arial Black, Georgia, Impact) and any font loaded via "+ Load Font" in the
    browser are not guaranteed to be — bundling the actual font file via the
    subtitles filter's fontsdir= option is a separate follow-up.

    caption_mode='word-highlight' (Part F4) renders each caption as ASS
    karaoke (\\k tags per word, from cap['words'] — per-word timestamps
    preserved at transcription time in whisper.js) instead of static text:
    libass progressively swaps each word from SecondaryColour (not yet
    "sung") to PrimaryColour as playback reaches it — the standard karaoke
    mechanism, repurposed here for CapCut-style word-highlight captions.
    Falls back to static rendering per-caption if a caption has no `words`
    (manual edits/splits in the transcript editor clear it, since the text
    no longer matches the original per-word timing 1:1).
    """
    scale = (out_h / preview_height_px) if preview_height_px and preview_height_px > 0 else 1.0
    font_size = max(1, int(round((text_style.get('fontSize') or 15) * scale)))

    stroke_on  = bool(text_style.get('strokeEnabled'))
    outline_px = ((text_style.get('strokeThickness') or 0) * scale) if stroke_on else 0

    weight = str(text_style.get('fontWeight') or '700')
    bold = -1 if (weight.isdigit() and int(weight) >= 600) or weight == 'bold' else 0

    font_name = (text_style.get('fontFamily') or 'Outfit').split(',')[0].strip("'\" ")

    primary_color = _hex_to_ass_color(text_style.get('color') or '#ffffff')
    outline_color = _hex_to_ass_color(text_style.get('strokeColor') or '#000000')
    back_color, has_bg = _parse_bg_color(text_style.get('background') or '')
    border_style = 3 if has_bg else 1  # 3 = opaque box, 1 = outline+shadow
    # Karaoke: words not yet "sung" render in SecondaryColour, switching to
    # PrimaryColour as \k reaches them — a dim neutral gray reads as "upcoming"
    # regardless of the user's chosen caption color.
    secondary_color = '&H00969696' if caption_mode == 'word-highlight' else '&H000000FF'

    pos_x = (text_style.get('posX') if text_style.get('posX') is not None else 50) / 100 * out_w
    pos_y = out_h - ((text_style.get('posY') if text_style.get('posY') is not None else 14) / 100 * out_h)

    def src_to_tl(t):
        for seg in seg_meta:
            if seg["sourceStart"] <= t <= seg["sourceEnd"]:
                return seg["timelineStart"] + (t - seg["sourceStart"])
        return None

    def fmt(s):
        h, m = int(s // 3600), int((s % 3600) // 60)
        sec = s % 60
        return f"{h:d}:{m:02d}:{sec:05.2f}"

    header = (
        "[Script Info]\n"
        "ScriptType: v4.00+\n"
        f"PlayResX: {out_w}\n"
        f"PlayResY: {out_h}\n"
        "WrapStyle: 2\n"
        "ScaledBorderAndShadow: yes\n\n"
        "[V4+ Styles]\n"
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, "
        "Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, "
        "Alignment, MarginL, MarginR, MarginV, Encoding\n"
        f"Style: Default,{font_name},{font_size},{primary_color},{secondary_color},{outline_color},{back_color},"
        f"{bold},0,0,0,100,100,0,0,{border_style},{outline_px:.1f},0,2,10,10,10,1\n\n"
        "[Events]\n"
        "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n"
    )

    lines = [header]
    for cap in captions:
        ts = src_to_tl(cap["start"])
        if ts is None:
            continue
        te = src_to_tl(cap["end"])
        if te is None:
            te = ts + (cap["end"] - cap["start"])

        text = None
        if caption_mode == 'word-highlight' and cap.get('words'):
            karaoke_parts = []
            for w in cap['words']:
                cs = max(1, int(round((w['end'] - w['start']) * 100)))  # centiseconds, \k's unit
                wtext = (w.get('text') or '').replace('{', '(').replace('}', ')')
                if wtext:
                    karaoke_parts.append(f"{{\\k{cs}}}{wtext}")
            if karaoke_parts:
                text = ' '.join(karaoke_parts)
        if text is None:
            text = (cap.get("text") or "").replace("\n", "\\N").replace("{", "(").replace("}", ")")

        # \an2 (bottom-center anchor) + \pos() overrides the style's own
        # alignment/margins — matches the live overlay's left:X%/bottom:Y%
        lines.append(
            f"Dialogue: 0,{fmt(ts)},{fmt(te)},Default,,0,0,0,,"
            f"{{\\an2\\pos({pos_x:.1f},{pos_y:.1f})}}{text}"
        )

    if text_layers:
        lines.extend(_generate_text_layer_dialogue(text_layers, seg_meta, out_w, out_h))

    return "\n".join(lines)


# ── HTTP handler ──────────────────────────────────────────────────────────────

class NoCacheHandler(http.server.SimpleHTTPRequestHandler):

    def do_GET(self):
        if self.path.startswith('/video'):
            self._serve_video()
        else:
            super().do_GET()

    def _serve_video(self):
        from urllib.parse import parse_qs, urlparse, unquote
        query     = parse_qs(urlparse(self.path).query)
        paths     = query.get('path', [])
        if not paths:
            self.send_error(400, 'Missing path'); return
        file_path = unquote(paths[0])
        if not os.path.isfile(file_path):
            self.send_error(404, 'Not found'); return

        ext  = os.path.splitext(file_path)[1].lower().lstrip('.')
        mime = {'mp4':'video/mp4','mov':'video/quicktime','mkv':'video/x-matroska',
                'webm':'video/webm','m4v':'video/mp4','avi':'video/x-msvideo',
                # Same generic /video?path= streamer also backs sticker/image-overlay
                # previews (js/ui/imagelayers.js) — no separate endpoint needed.
                'png':'image/png','jpg':'image/jpeg','jpeg':'image/jpeg',
                'gif':'image/gif','webp':'image/webp'}.get(ext, 'application/octet-stream')
        size = os.path.getsize(file_path)
        rng  = self.headers.get('Range', '')

        try:
            if rng:
                parts = rng.replace('bytes=', '').split('-')
                start = int(parts[0]) if parts[0] else 0
                end   = int(parts[1]) if len(parts) > 1 and parts[1] else size - 1
                end   = min(end, size - 1)
                length = end - start + 1
                self.send_response(206)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Range', f'bytes {start}-{end}/{size}')
                self.send_header('Content-Length', str(length))
                self.send_header('Accept-Ranges', 'bytes')
                self.end_headers()
                with open(file_path, 'rb') as f:
                    f.seek(start)
                    remaining = length
                    while remaining > 0:
                        chunk = f.read(min(65536, remaining))
                        if not chunk: break
                        self.wfile.write(chunk)
                        remaining -= len(chunk)
            else:
                self.send_response(200)
                self.send_header('Content-Type', mime)
                self.send_header('Content-Length', str(size))
                self.send_header('Accept-Ranges', 'bytes')
                self.end_headers()
                with open(file_path, 'rb') as f:
                    while True:
                        chunk = f.read(65536)
                        if not chunk: break
                        self.wfile.write(chunk)
        except (BrokenPipeError, ConnectionResetError):
            pass  # client seeked away mid-stream, normal

    def end_headers(self):
        if self.path.split('?')[0].endswith('config.json'):
            self.send_header('Cache-Control', 'no-store, no-cache, must-revalidate')
            self.send_header('Pragma', 'no-cache')
            self.send_header('Expires', '0')
        super().end_headers()

    def log_message(self, format, *args):
        pass


# ── pywebview API ─────────────────────────────────────────────────────────────

class API:
    """All Python functionality exposed to JS via window.pywebview.api.*"""

    _export_cancelled = False
    _last_proxy_path  = None  # previous render_preview_proxy() output — deleted before the next render

    # ── File dialogs ──────────────────────────────────────────────────────────

    def open_file(self):
        """Native video file open dialog. Returns absolute path or None."""
        log('DIALOG', 'open_file() — opening native file picker')
        result = webview.windows[0].create_file_dialog(
            webview.FileDialog.OPEN,
            file_types=('Video Files (*.mp4;*.mov;*.webm;*.mkv)',)
        )
        path = result[0] if result else None
        if path:
            size_mb = os.path.getsize(path) / 1_048_576
            log('DIALOG', f'✓ File selected: {path}  ({size_mb:.1f} MB)')
        else:
            log('DIALOG', 'File picker cancelled')
        return path

    def pick_image(self):
        """Native image file open dialog — backs the sticker/image-overlay
        feature ("+ Image" on the timeline toolbar). Returns absolute path or None."""
        log('DIALOG', 'pick_image() — opening native file picker')
        result = webview.windows[0].create_file_dialog(
            webview.FileDialog.OPEN,
            file_types=('Image Files (*.png;*.jpg;*.jpeg;*.gif;*.webp)',)
        )
        path = result[0] if result else None
        if path:
            size_mb = os.path.getsize(path) / 1_048_576
            log('DIALOG', f'✓ Image selected: {path}  ({size_mb:.1f} MB)')
        else:
            log('DIALOG', 'Image picker cancelled')
        return path

    def pick_folder(self):
        """Native OS folder picker. Returns absolute path or None."""
        log('DIALOG', 'pick_folder() — opening native folder picker')
        result = webview.windows[0].create_file_dialog(webview.FileDialog.FOLDER)
        path = result[0] if result else None
        log('DIALOG', f'✓ Folder selected: {path}' if path else 'Folder picker cancelled')
        return path

    def list_video_files(self, folder_path):
        """List video files directly inside folder_path (top-level only — no
        recursion into subfolders, keeping a folder-link import predictable).
        Returns absolute paths, sorted by filename."""
        VIDEO_EXTS = ('.mp4', '.mov', '.mkv', '.webm', '.avi', '.m4v', '.wmv', '.flv', '.ts', '.mts')
        log('DIALOG', f'list_video_files() — scanning {folder_path}')
        try:
            entries = sorted(os.listdir(folder_path))
        except OSError as e:
            log('DIALOG', f'✕ list_video_files failed: {e}')
            return []
        paths = [
            os.path.join(folder_path, name) for name in entries
            if name.lower().endswith(VIDEO_EXTS) and os.path.isfile(os.path.join(folder_path, name))
        ]
        log('DIALOG', f'✓ found {len(paths)} video file(s)')
        return paths

    # ── Whisper transcription ─────────────────────────────────────────────────

    def probe_duration(self, source_path):
        """Use ffprobe to get video duration in seconds. Returns float."""
        log('PROBE', f'probing duration: {source_path}')
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', source_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        dur = float(result.stdout.strip() or 0)
        log('PROBE', f'duration: {dur:.3f}s')
        return dur

    def probe_fps(self, source_path):
        """Use ffprobe to get the video's real frame rate. Returns float, 0 on failure."""
        log('PROBE', f'probing fps: {source_path}')
        result = subprocess.run(
            ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
             '-show_entries', 'stream=r_frame_rate',
             '-of', 'default=noprint_wrappers=1:nokey=1', source_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        raw = result.stdout.strip()
        try:
            if '/' in raw:
                num, den = raw.split('/')
                fps = float(num) / float(den) if float(den) != 0 else 0
            else:
                fps = float(raw or 0)
        except Exception:
            fps = 0
        log('PROBE', f'fps: {fps:.3f}')
        return fps

    # ── Project save/load (bug #8) ────────────────────────────────────────────

    _AUTOSAVE_NAME = 'autosave.ccproj'

    def save_project(self, project_json, output_name='clipcut_project.ccproj'):
        """Native Save dialog, writes the project JSON string to disk."""
        log('PROJECT', 'Opening native Save dialog for project file...')
        save_path = webview.windows[0].create_file_dialog(
            webview.FileDialog.SAVE,
            save_filename=output_name,
            file_types=('ClipCut Project (*.ccproj)',)
        )
        if not save_path:
            log('PROJECT', 'Save dialog cancelled')
            return {'success': False, 'error': 'cancelled'}
        if isinstance(save_path, (list, tuple)):
            save_path = save_path[0]
        if not save_path.lower().endswith('.ccproj'):
            save_path += '.ccproj'
        try:
            with open(save_path, 'w', encoding='utf-8') as f:
                f.write(project_json)
            log('PROJECT', f'✓ Saved project: {save_path}')
            return {'success': True, 'path': save_path}
        except Exception as exc:
            log('PROJECT', f'✕ Save failed: {exc}')
            return {'success': False, 'error': str(exc)}

    def open_project(self):
        """Native Open dialog, returns the project JSON string or None."""
        log('PROJECT', 'Opening native Open dialog for project file...')
        result = webview.windows[0].create_file_dialog(
            webview.FileDialog.OPEN,
            file_types=('ClipCut Project (*.ccproj)',)
        )
        path = result[0] if result else None
        if not path:
            log('PROJECT', 'Open dialog cancelled')
            return None
        try:
            with open(path, 'r', encoding='utf-8') as f:
                data = f.read()
            log('PROJECT', f'✓ Loaded project: {path}')
            return data
        except Exception as exc:
            log('PROJECT', f'✕ Load failed: {exc}')
            return None

    def autosave_project(self, project_json):
        """Silently writes the project JSON to a fixed path — no dialog. Called
        periodically by the JS side; failures are logged, not surfaced to the user."""
        path = os.path.join(BASE_DIR, self._AUTOSAVE_NAME)
        try:
            with open(path, 'w', encoding='utf-8') as f:
                f.write(project_json)
        except Exception as exc:
            log('PROJECT', f'✕ Autosave failed: {exc}')

    def check_autosave(self):
        """Returns the autosave file's JSON content if it exists, else None —
        used for the startup recovery prompt."""
        path = os.path.join(BASE_DIR, self._AUTOSAVE_NAME)
        if not os.path.exists(path):
            return None
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return f.read()
        except Exception as exc:
            log('PROJECT', f'✕ Reading autosave failed: {exc}')
            return None

    def clear_autosave(self):
        """Deletes the autosave file (called after a real save, or once the
        user dismisses/recovers it)."""
        path = os.path.join(BASE_DIR, self._AUTOSAVE_NAME)
        try:
            if os.path.exists(path):
                os.remove(path)
        except Exception as exc:
            log('PROJECT', f'✕ Clearing autosave failed: {exc}')

    def load_ui_settings(self):
        """Load persisted UI/pipeline settings from ui_settings.json."""
        path = os.path.join(BASE_DIR, 'ui_settings.json')
        try:
            with open(path, 'r', encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}

    def save_ui_settings(self, data):
        """Persist UI/pipeline settings to ui_settings.json."""
        path = os.path.join(BASE_DIR, 'ui_settings.json')
        try:
            with open(path, 'w', encoding='utf-8') as f:
                json.dump(data, f, indent=2)
            return {'ok': True}
        except Exception as e:
            return {'ok': False, 'error': str(e)}

    def get_whisper_config(self):
        """Return current transcription config values for the Settings UI."""
        return {
            'whisper_backend':     WHISPER_BACKEND,
            'whisperx_model':      WHISPERX_MODEL,
            'whisperx_batch_size': WHISPERX_BATCH_SIZE,
            'parakeet_model':      PARAKEET_MODEL_ID,
        }

    def save_whisper_config(self, backend, model, batch_size):
        """Write transcription settings to config.json and apply live."""
        _write_config({
            'whisper_backend':     backend,
            'whisperx_model':      model,
            'whisperx_batch_size': int(batch_size),
        })
        return {'ok': True, 'backend': WHISPER_BACKEND, 'model': WHISPERX_MODEL, 'batch_size': WHISPERX_BATCH_SIZE}

    # ── UGC templates (Part F4) ─────────────────────────────────────────────
    # Presets bundling aspect/aspectMode, caption style+mode, export preset,
    # and a subset of the detection/auto-mode settings. Deliberately doesn't
    # include the spec's "text layers" (hook slot etc.) — ClipCut has no
    # freeform text-layer feature to apply that to yet; templates cover what
    # actually exists (captions, aspect, detection settings, export quality).

    def list_templates(self):
        """Returns {name: templateObject} from templates.json, or {} if missing/corrupt."""
        try:
            with open(os.path.join(BASE_DIR, 'templates.json'), encoding='utf-8') as f:
                return json.load(f)
        except Exception:
            return {}

    def save_template(self, name, template_json):
        """Adds/overwrites one named template in templates.json."""
        try:
            templates = self.list_templates()
            templates[name] = json.loads(template_json)
            with open(os.path.join(BASE_DIR, 'templates.json'), 'w', encoding='utf-8') as f:
                json.dump(templates, f, indent=2)
            log('TEMPLATE', f'✓ Saved "{name}"')
            return {'success': True}
        except Exception as e:
            log('TEMPLATE', f'✕ save_template failed: {e}')
            return {'success': False, 'error': str(e)}

    def delete_template(self, name):
        try:
            templates = self.list_templates()
            templates.pop(name, None)
            with open(os.path.join(BASE_DIR, 'templates.json'), 'w', encoding='utf-8') as f:
                json.dump(templates, f, indent=2)
            log('TEMPLATE', f'✓ Deleted "{name}"')
            return {'success': True}
        except Exception as e:
            log('TEMPLATE', f'✕ delete_template failed: {e}')
            return {'success': False, 'error': str(e)}

    def ping(self):
        """Load (or confirm loaded) transcription + VAD models. Returns {online, model, device, backend}."""
        log('WHISPER', f'ping() — backend={WHISPER_BACKEND}')
        try:
            if WHISPER_BACKEND == 'parakeet':
                _get_parakeet_model()
                model_label = PARAKEET_MODEL_ID.split('/')[-1]
            elif WHISPER_BACKEND == 'whisperx':
                _get_whisperx_model()
                model_label = WHISPERX_MODEL
            else:
                _get_whisper_model()
                model_label = MODEL_SIZE
            _get_vad_model()
            log('WHISPER', f'✓ Online — model={model_label}  device={DEVICE}  backend={WHISPER_BACKEND}')
            return {'online': True, 'model': model_label, 'device': DEVICE, 'backend': WHISPER_BACKEND}
        except Exception as e:
            log('WHISPER', f'✕ Failed: {e}')
            return {'online': False, 'error': str(e), 'backend': WHISPER_BACKEND}

    def transcribe(self, source_path):
        """
        Extract audio and transcribe. Backend switches on WHISPER_BACKEND config key.
        parakeet:     NVIDIA NeMo TDT — fastest, English-primary, word timestamps built-in.
        whisperx:     faster-whisper + Wav2Vec2 forced alignment + retake detection.
        faster-whisper: beam search word timestamps (fallback).
        All paths return {words, language, duration, fps, backend} + optional retake_cuts.
        """
        log('TRANSCRIBE', f'source: {source_path}  backend: {WHISPER_BACKEND}')
        if not source_path or not os.path.exists(source_path):
            log('TRANSCRIBE', f'✕ File not found: {source_path}')
            return {'error': f'File not found: {source_path}'}

        size_mb = os.path.getsize(source_path) / 1_048_576
        log('TRANSCRIBE', f'File size: {size_mb:.1f} MB')

        # Probe actual video framerate for accurate caption frame-snapping in JS
        def _probe_fps(path):
            r = subprocess.run(
                ['ffprobe', '-v', 'error', '-select_streams', 'v:0',
                 '-show_entries', 'stream=r_frame_rate',
                 '-of', 'default=noprint_wrappers=1:nokey=1', path],
                stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
            )
            raw = r.stdout.strip()  # e.g. "30000/1001" or "30/1"
            try:
                if '/' in raw:
                    n, d = raw.split('/')
                    return round(float(n) / float(d), 3) if float(d) else 30.0
                return round(float(raw), 3) if raw else 30.0
            except Exception:
                return 30.0

        video_fps = _probe_fps(source_path)
        log('TRANSCRIBE', f'Video FPS: {video_fps}')

        with tempfile.TemporaryDirectory() as tmp:
            audio_path = os.path.join(tmp, 'audio.wav')

            cmd = ['ffmpeg', '-y', '-i', source_path,
                   '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', audio_path]
            log('TRANSCRIBE', 'Extracting audio (16kHz mono WAV)...')
            t0 = time.time()
            r  = subprocess.run(cmd, capture_output=True, text=True)
            # ── Parakeet path ──────────────────────────────────────────────
            if WHISPER_BACKEND == 'parakeet':
                try:
                    model = _get_parakeet_model()
                    log('PARAKEET', 'Transcribing with word timestamps...')
                    t1 = time.time()
                    hypotheses = model.transcribe(
                        [audio_path], timestamps=True, return_hypotheses=True
                    )
                    log('PARAKEET', f'✓ Done in {time.time()-t1:.1f}s')

                    hyp = hypotheses[0] if isinstance(hypotheses, list) else hypotheses
                    word_ts = (hyp.timestamp or {}).get('word', [])
                    words = []
                    for wt in word_ts:
                        w_text = (wt.get('word') or '').strip()
                        if not w_text:
                            continue
                        # TDT: seconds; CTC fallback: frame offsets → convert
                        if 'start' in wt:
                            s, e = float(wt['start']), float(wt['end'])
                        else:
                            hop = 0.01  # NeMo default 10ms hop
                            s   = float(wt.get('start_offset', 0)) * hop
                            e   = float(wt.get('end_offset',   0)) * hop
                        words.append({'word': w_text, 'start': round(s, 3), 'end': round(e, 3)})

                    # Probe duration
                    probe = subprocess.run(
                        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                         '-of', 'default=noprint_wrappers=1:nokey=1', source_path],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
                    )
                    dur = float(probe.stdout.strip() or 0)
                    log('PARAKEET', f'✓ {len(words)} words — returning to JS')
                    return {
                        'words':    words,
                        'language': 'en',
                        'duration': round(dur, 2),
                        'fps':      video_fps,
                        'backend':  'parakeet',
                    }
                except Exception as e:
                    log('PARAKEET', f'✕ Failed: {e} — falling back to whisperx')
            if r.returncode != 0:
                log('TRANSCRIBE', f'✕ Audio extraction failed (exit {r.returncode})')
                log('TRANSCRIBE', r.stderr[-400:])
                return {'error': f'Audio extraction failed: {r.stderr[-200:]}'}
            log('TRANSCRIBE', f'Audio extracted in {time.time()-t0:.1f}s')

            # ── WhisperX path ──────────────────────────────────────────────
            if WHISPER_BACKEND == 'whisperx':
                try:
                    import whisperx, gc

                    log('WHISPERX', 'Loading audio array...')
                    audio = whisperx.load_audio(audio_path)

                    model = _get_whisperx_model()
                    log('WHISPERX', f'Transcribing (batch={WHISPERX_BATCH_SIZE})...')
                    t1 = time.time()
                    result = model.transcribe(audio, batch_size=WHISPERX_BATCH_SIZE)
                    lang   = result.get('language', 'en')
                    log('WHISPERX', f'✓ Transcription in {time.time()-t1:.1f}s — lang={lang}  segs={len(result["segments"])}')

                    log('WHISPERX', 'Running Wav2Vec2 forced alignment...')
                    t2 = time.time()
                    model_a, metadata = _get_whisperx_align(lang)
                    result = whisperx.align(
                        result['segments'], model_a, metadata, audio,
                        DEVICE, return_char_alignments=False
                    )
                    log('WHISPERX', f'✓ Alignment in {time.time()-t2:.1f}s')

                    # Probe duration via ffprobe
                    probe = subprocess.run(
                        ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
                         '-of', 'default=noprint_wrappers=1:nokey=1', source_path],
                        stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
                    )
                    dur = float(probe.stdout.strip() or 0)

                    words = []
                    for seg in result['segments']:
                        for w in seg.get('words', []):
                            token = (w.get('word') or '').strip()
                            s, e  = w.get('start'), w.get('end')
                            if token and s is not None and e is not None:
                                words.append({
                                    'word':  token,
                                    'start': round(float(s), 3),
                                    'end':   round(float(e), 3),
                                })

                    retake_cuts = _detect_retakes(result['segments'])
                    log('WHISPERX', f'✓ {len(words)} words  {len(retake_cuts)} retakes — returning to JS')
                    gc.collect()
                    return {
                        'words':       words,
                        'language':    lang,
                        'duration':    round(dur, 2),
                        'fps':         video_fps,
                        'retake_cuts': retake_cuts,
                        'backend':     'whisperx',
                    }
                except Exception as e:
                    log('WHISPERX', f'✕ WhisperX failed: {e} — falling back to faster-whisper')

            # ── faster-whisper path (default / fallback) ───────────────────
            try:
                log('TRANSCRIBE', f'Running faster-whisper (model={MODEL_SIZE}, beam=5, vad=on)...')
                t1  = time.time()
                m   = _get_whisper_model()
                segments, info = m.transcribe(
                    audio_path,
                    word_timestamps=True,
                    vad_filter=True,
                    vad_parameters=dict(min_silence_duration_ms=300),
                    beam_size=5,
                )
                segments = list(segments)
                log('TRANSCRIBE', f'✓ Transcription done in {time.time()-t1:.1f}s')
                log('TRANSCRIBE', f'Language: {info.language} ({info.language_probability:.0%})  Duration: {info.duration:.1f}s')
            except Exception as e:
                log('TRANSCRIBE', f'✕ Transcription failed: {e}')
                return {'error': f'Transcription failed: {e}'}

            words = []
            for seg in segments:
                for w in (seg.words or []):
                    if w.start is None or w.end is None:
                        continue
                    token = (w.word or '').strip()
                    if token:
                        words.append({
                            'word':  token,
                            'start': round(float(w.start), 3),
                            'end':   round(float(w.end),   3),
                        })

            log('TRANSCRIBE', f'✓ {len(words)} words extracted — returning to JS')
            return {
                'words':    words,
                'language': info.language,
                'duration': round(info.duration, 2),
                'fps':      video_fps,
                'backend':  'faster-whisper',
            }

    # ── Silence detection ─────────────────────────────────────────────────────

    def detect_silence(self, source_path, threshold='-35dB',
                       min_duration=0.3, pad_before=0.05, pad_after=0.05):
        """
        Run ffmpeg silencedetect on source_path.
        Returns {cuts: [{start, end, type, selected}], count, duration} or {error}.
        """
        log('SILENCE', f'source:       {source_path}')
        log('SILENCE', f'threshold:    {threshold}  min_dur: {min_duration}s  pad: {pad_before}s/{pad_after}s')

        if not source_path or not os.path.exists(source_path):
            log('SILENCE', f'✕ File not found: {source_path}')
            return {'error': f'File not found: {source_path}'}

        # Probe total duration
        probe = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', source_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        total_dur = float(probe.stdout.strip() or 0)
        log('SILENCE', f'Video duration: {total_dur:.2f}s')

        cmd = ['ffmpeg', '-i', source_path,
               '-af', f'silencedetect=n={threshold}:d={min_duration}',
               '-f', 'null', '-']
        log('SILENCE', 'CMD: ' + ' '.join(cmd))
        t0     = time.time()
        result = subprocess.run(cmd, stderr=subprocess.PIPE, text=True)
        log('SILENCE', f'ffmpeg done in {time.time()-t0:.1f}s  (exit {result.returncode})')
        output = result.stderr

        starts = [float(x) for x in re.findall(r'silence_start: (\d+\.?\d*)', output)]
        ends   = [float(x) for x in re.findall(r'silence_end: (\d+\.?\d*)',   output)]

        if len(starts) > len(ends):
            ends.append(total_dur if total_dur > 0 else starts[-1] + min_duration)
            log('SILENCE', 'Note: trailing silence_start without end — synthesised end from duration')

        cuts = []
        for s, e in zip(starts, ends):
            start = max(0.0, round(s - pad_before, 3))
            end   = round(e + pad_after, 3)
            if total_dur > 0:
                end = min(end, total_dur)
            cuts.append({'start': start, 'end': end, 'type': 'dead_air', 'selected': True})

        log('SILENCE', f'✓ {len(cuts)} silence regions found')
        for i, c in enumerate(cuts):
            log('SILENCE', f'  [{i}]  {c["start"]:.3f}s → {c["end"]:.3f}s  ({c["end"]-c["start"]:.3f}s)')

        return {'cuts': cuts, 'count': len(cuts), 'duration': total_dur}

    def vad_detect(self, source_path, threshold=0.5, min_speech_ms=250, min_silence_ms=300):
        """
        Run Silero VAD on source_path. Inverts speech segments to produce silence/dead_air cuts.
        Returns {speech_segments, cuts, count, duration} — same shape as detect_silence() response.
        """
        log('VAD', f'source:        {source_path}')
        log('VAD', f'threshold: {threshold}  min_speech_ms: {min_speech_ms}  min_silence_ms: {min_silence_ms}')

        if not source_path or not os.path.exists(source_path):
            log('VAD', f'✕ File not found: {source_path}')
            return {'error': f'File not found: {source_path}'}

        probe = subprocess.run(
            ['ffprobe', '-v', 'error', '-show_entries', 'format=duration',
             '-of', 'default=noprint_wrappers=1:nokey=1', source_path],
            stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True
        )
        total_dur = float(probe.stdout.strip() or 0)
        log('VAD', f'Video duration: {total_dur:.2f}s')

        with tempfile.TemporaryDirectory() as tmp:
            audio_path = os.path.join(tmp, 'audio.wav')
            cmd = ['ffmpeg', '-y', '-i', source_path,
                   '-vn', '-ac', '1', '-ar', '16000', '-f', 'wav', audio_path]
            log('VAD', 'Extracting audio (16kHz mono WAV)...')
            t0 = time.time()
            r = subprocess.run(cmd, capture_output=True, text=True)
            if r.returncode != 0:
                log('VAD', f'✕ Audio extraction failed (exit {r.returncode})')
                log('VAD', r.stderr[-400:])
                return {'error': f'Audio extraction failed: {r.stderr[-200:]}'}
            log('VAD', f'Audio extracted in {time.time()-t0:.1f}s')

            try:
                import wave, numpy as np, torch
                from silero_vad import get_speech_timestamps
                model = _get_vad_model()
                t1 = time.time()
                # Load WAV manually — avoids torchaudio/torchcodec which can't find FFmpeg DLLs
                with wave.open(audio_path, 'rb') as wf:
                    raw = wf.readframes(wf.getnframes())
                audio = torch.FloatTensor(
                    np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
                )
                speech_ts = get_speech_timestamps(
                    audio, model,
                    threshold=threshold,
                    min_speech_duration_ms=min_speech_ms,
                    min_silence_duration_ms=min_silence_ms,
                    return_seconds=True,
                )
                log('VAD', f'✓ VAD done in {time.time()-t1:.1f}s — {len(speech_ts)} speech segments')
            except Exception as e:
                log('VAD', f'✕ VAD failed: {e}')
                return {'error': f'VAD failed: {e}'}

        speech_segments = [{'start': round(s['start'], 3), 'end': round(s['end'], 3)} for s in speech_ts]

        # Invert: gaps between speech regions become dead_air cuts
        min_gap = min_silence_ms / 1000
        cuts = []
        prev_end = 0.0
        for seg in speech_segments:
            gap_start, gap_end = prev_end, seg['start']
            if gap_end - gap_start >= min_gap:
                cuts.append({'start': round(gap_start, 3), 'end': round(gap_end, 3),
                             'type': 'dead_air', 'selected': True})
            prev_end = seg['end']
        if total_dur > 0 and total_dur - prev_end >= min_gap:
            cuts.append({'start': round(prev_end, 3), 'end': round(total_dur, 3),
                         'type': 'dead_air', 'selected': True})

        log('VAD', f'✓ {len(cuts)} silence regions (gaps between speech)')
        for i, c in enumerate(cuts):
            log('VAD', f'  [{i}]  {c["start"]:.3f}s → {c["end"]:.3f}s  ({c["end"]-c["start"]:.3f}s)')

        return {'speech_segments': speech_segments, 'cuts': cuts, 'count': len(cuts), 'duration': total_dur}

    # ── Export ────────────────────────────────────────────────────────────────

    def export_video(self, source_path, segments_json, output_name,
                     preset='fast', flip_h=False, flip_v=False,
                     burn_captions=False, captions_json='[]', seg_meta_json='[]',
                     aspect='', aspect_mode='crop',
                     text_style_json='{}', preview_height_px=0,
                     caption_mode='static', text_layers_json='[]', image_layers_json='[]'):
        """
        Open native Save dialog, encode directly to disk with ffmpeg.

        Fast path (burn_captions=False):
          - Single segment  → one-pass hwaccel encode direct to save_path
          - Multi segment   → extract each segment (hwaccel) then concat -c copy

        Fallback (burn_captions=True):
          - filter_complex single-pass with ASS caption + text-layer overlay
            (styled — see _generate_ass; text_style_json/preview_height_px let
            the burned-in captions match S.textStyle from the Captions
            inspector tab instead of always rendering plain SRT text;
            text_layers_json carries "Add Text" freeform objects, each with
            its own style) plus ffmpeg overlay compositing for sticker/image
            layers (image_layers_json — each becomes its own ffmpeg input,
            forces the filter_complex path even for a single segment)

        aspect: target ratio like '9/16', or '' to export at source aspect
        (bug #21 — export previously ignored the preview's aspect entirely).
        aspect_mode: 'crop' (crop-to-fill, default) | 'pad' (pad-to-fit).
        """
        try:
            return self._export_video_inner(
                source_path, segments_json, output_name,
                preset, flip_h, flip_v,
                burn_captions, captions_json, seg_meta_json,
                aspect, aspect_mode,
                text_style_json, preview_height_px,
                caption_mode, text_layers_json, image_layers_json
            )
        except Exception as exc:
            import traceback
            log('EXPORT', f'✕ UNCAUGHT EXCEPTION: {exc}')
            log('EXPORT', traceback.format_exc())
            return {'success': False, 'error': str(exc)}

    def _export_video_inner(self, source_path, segments_json, output_name,
                            preset, flip_h, flip_v,
                            burn_captions, captions_json, seg_meta_json,
                            aspect='', aspect_mode='crop',
                            text_style_json='{}', preview_height_px=0,
                            caption_mode='static', text_layers_json='[]', image_layers_json='[]'):
        log('EXPORT', 'Opening native Save dialog...')
        save_path = webview.windows[0].create_file_dialog(
            webview.FileDialog.SAVE,
            save_filename=output_name,
            file_types=('MP4 Video (*.mp4)',)
        )
        if not save_path:
            log('EXPORT', 'Save dialog cancelled')
            return {'success': False, 'error': 'cancelled'}
        if isinstance(save_path, (list, tuple)):
            save_path = save_path[0]
        if not save_path.lower().endswith('.mp4'):
            save_path += '.mp4'

        return self._export_video_core(
            source_path, segments_json, save_path,
            preset, flip_h, flip_v,
            burn_captions, captions_json, seg_meta_json,
            aspect, aspect_mode,
            text_style_json, preview_height_px,
            caption_mode, text_layers_json, image_layers_json
        )

    def export_video_batch_one(self, source_path, segments_json, save_path,
                               preset='fast', flip_h=False, flip_v=False,
                               burn_captions=False, captions_json='[]', seg_meta_json='[]',
                               aspect='', aspect_mode='crop',
                               text_style_json='{}', preview_height_px=0,
                               caption_mode='static', text_layers_json='[]', image_layers_json='[]'):
        """Same encode core as export_video(), but takes save_path directly
        instead of opening a native Save dialog — batch export (js/media/batch.js)
        picks one destination folder up front via pick_folder() and computes
        each clip's output filename itself, so N clips shouldn't mean N dialogs."""
        try:
            if not save_path.lower().endswith('.mp4'):
                save_path += '.mp4'
            return self._export_video_core(
                source_path, segments_json, save_path,
                preset, flip_h, flip_v,
                burn_captions, captions_json, seg_meta_json,
                aspect, aspect_mode,
                text_style_json, preview_height_px,
                caption_mode, text_layers_json, image_layers_json
            )
        except Exception as exc:
            import traceback
            log('EXPORT', f'✕ UNCAUGHT EXCEPTION (batch): {exc}')
            log('EXPORT', traceback.format_exc())
            return {'success': False, 'error': str(exc)}

    def _export_video_core(self, source_path, segments_json, save_path,
                           preset, flip_h, flip_v,
                           burn_captions, captions_json, seg_meta_json,
                           aspect='', aspect_mode='crop',
                           text_style_json='{}', preview_height_px=0,
                           caption_mode='static', text_layers_json='[]', image_layers_json='[]'):
        self._export_cancelled = False

        log('EXPORT', f'source:       {source_path}')
        log('EXPORT', f'save_path:    {save_path}')
        log('EXPORT', f'preset:       {preset}  flip_h={flip_h}  flip_v={flip_v}  burn_captions={burn_captions}'
                       f'  aspect={aspect or "source"}  aspect_mode={aspect_mode}')

        segments  = json.loads(segments_json)
        if not segments:
            log('EXPORT', '✕ No segments provided')
            return {'success': False, 'error': 'No segments provided'}

        p           = PRESET_MAP.get(preset, PRESET_MAP['fast'])
        flip_parts    = (['hflip'] if flip_h else []) + (['vflip'] if flip_v else [])
        flip_filter   = ','.join(flip_parts)
        aspect_filter = _aspect_filter(aspect, aspect_mode)
        total_dur     = sum(seg['end'] - seg['start'] for seg in segments)

        log('EXPORT', f'Segments: {len(segments)}  total output: {total_dur:.2f}s')
        for i, s in enumerate(segments):
            log('EXPORT', f'  seg[{i}]  {s["start"]:.3f}s → {s["end"]:.3f}s  ({s["end"]-s["start"]:.3f}s)')
        log('EXPORT', f'nvenc preset: {p["nvenc"]}  bitrate: {p["bitrate"]}' +
            (f'  tune: {p["tune"]}' if p.get("tune") else '') +
            (f'  flip: {flip_filter}' if flip_filter else '') +
            (f'  aspect_filter: {aspect_filter}' if aspect_filter else ''))

        if burn_captions:
            log('EXPORT', 'Mode: filter_complex + styled ASS burn-in (single-pass)')
            return self._export_burnin(
                source_path, segments, save_path, p, flip_filter,
                json.loads(captions_json), json.loads(seg_meta_json), aspect_filter,
                json.loads(text_style_json or '{}'), preview_height_px,
                aspect, aspect_mode, caption_mode, json.loads(text_layers_json or '[]'),
                json.loads(image_layers_json or '[]')
            )

        t_start = time.time()
        tmp_dir = tempfile.mkdtemp()
        ok, err = True, ''

        try:
            if len(segments) == 1:
                log('EXPORT', 'Mode: single-segment  →  direct hwaccel encode')
                self._push_progress(0, 'Encoding (GPU)…')
                ok, err = self._encode_segment(
                    source_path, segments[0], save_path, p, flip_filter, 0, 100, aspect_filter
                )
                if not ok and not self._export_cancelled:
                    log('EXPORT', '✕ GPU encode failed — retrying CPU')
                    self._push_progress(0, 'GPU failed — retrying CPU…')
                    ok, err = self._encode_segment_cpu(
                        source_path, segments[0], save_path, p, flip_filter, 0, 100, aspect_filter
                    )
            else:
                log('EXPORT', f'Mode: two-pass  ({len(segments)} segments  →  concat copy)')
                seg_files   = []
                elapsed_dur = 0.0

                for i, seg in enumerate(segments):
                    if self._export_cancelled:
                        break
                    seg_dur   = seg['end'] - seg['start']
                    seg_path  = os.path.join(tmp_dir, f'seg{i}.mp4')
                    pct_start = int(elapsed_dur / total_dur * 90)
                    pct_end   = int((elapsed_dur + seg_dur) / total_dur * 90)

                    log('EXPORT', f'Encoding seg[{i}]  {seg["start"]:.3f}→{seg["end"]:.3f}s  (GPU)  {pct_start}%→{pct_end}%')
                    self._push_progress(pct_start, f'Encoding segment {i+1}/{len(segments)} (GPU)…')
                    ok, err = self._encode_segment(
                        source_path, seg, seg_path, p, flip_filter, pct_start, pct_end, aspect_filter
                    )
                    if not ok and not self._export_cancelled:
                        log('EXPORT', f'✕ GPU seg[{i}] failed — retrying CPU')
                        log('EXPORT', f'stderr: {err[-300:]}')
                        self._push_progress(pct_start, f'Encoding segment {i+1}/{len(segments)} (CPU)…')
                        ok, err = self._encode_segment_cpu(
                            source_path, seg, seg_path, p, flip_filter, pct_start, pct_end, aspect_filter
                        )
                    if not ok:
                        log('EXPORT', f'✕ seg[{i}] failed on both GPU and CPU')
                        log('EXPORT', f'stderr: {err[-300:]}')
                        break
                    log('EXPORT', f'✓ seg[{i}] done')
                    seg_files.append(seg_path)
                    elapsed_dur += seg_dur

                if ok and not self._export_cancelled:
                    self._push_progress(90, 'Merging segments…')
                    concat_txt = os.path.join(tmp_dir, 'concat.txt')
                    with open(concat_txt, 'w', encoding='utf-8') as f:
                        for sp in seg_files:
                            f.write(f"file '{sp.replace(chr(92), '/')}'\n")
                    concat_cmd = ['ffmpeg', '-y', '-f', 'concat', '-safe', '0',
                                  '-i', concat_txt, '-c', 'copy', save_path]
                    log('EXPORT', 'Running concat (stream copy)...')
                    log('EXPORT', 'CMD: ' + ' '.join(concat_cmd))
                    result = subprocess.run(concat_cmd, capture_output=True)
                    ok  = result.returncode == 0
                    err = result.stderr.decode(errors='replace')[-300:] if not ok else ''
                    if ok:
                        self._push_progress(100)
                        log('EXPORT', '✓ Concat done')
                    else:
                        log('EXPORT', f'✕ Concat failed (exit {result.returncode})')
                        log('EXPORT', err)

        finally:
            shutil.rmtree(tmp_dir, ignore_errors=True)

        elapsed = time.time() - t_start
        if self._export_cancelled:
            log('EXPORT', 'Cancelled by user')
            return {'success': False, 'error': 'cancelled'}
        if ok:
            size_mb = os.path.getsize(save_path) / 1_048_576 if os.path.exists(save_path) else 0
            log('EXPORT', f'✓ Done in {elapsed:.1f}s  →  {save_path}  ({size_mb:.1f} MB)')
            return {'success': True, 'path': save_path}
        log('EXPORT', f'✕ Export failed after {elapsed:.1f}s')
        return {'success': False, 'error': err}

    def cancel_export(self):
        self._export_cancelled = True

    # ── JS → terminal log bridge ──────────────────────────────────────────────

    def log_js(self, level, msg):
        """Receive a log line from the browser and print it to the terminal."""
        log('JS/' + level.upper(), msg)

    # ── Internal helpers ──────────────────────────────────────────────────────

    def _push_progress(self, pct, label=None, js_fn='setProgress'):
        # js_fn lets callers other than the main export path (e.g. the
        # preview proxy render) route progress to their own JS callback
        # instead of the export modal's setProgress(pct, label) \u2014 that
        # callback only takes a bare percentage.
        if js_fn != 'setProgress':
            try:
                webview.windows[0].evaluate_js(f"{js_fn}({pct})")
            except Exception:
                pass
            return
        if label is None:
            label = 'Done!' if pct >= 100 else f'Encoding\u2026 {pct}%'
        safe = label.replace("'", "\\'")
        try:
            webview.windows[0].evaluate_js(f"setProgress({pct}, '{safe}')")
        except Exception:
            pass

    def _run_ffmpeg(self, cmd, seg_us, pct_start, pct_end, progress_fn='setProgress'):
        log('FFMPEG', 'CMD: ' + ' '.join(cmd))
        t0   = time.time()
        proc = subprocess.Popen(
            cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True, bufsize=1
        )
        stderr_buf  = []
        last_pct    = -1

        def _drain():
            for ln in proc.stderr:
                stderr_buf.append(ln)
        threading.Thread(target=_drain, daemon=True).start()

        for line in proc.stdout:
            if self._export_cancelled:
                proc.kill()
                break
            line = line.strip()
            if '=' not in line:
                continue
            k, v = line.split('=', 1)
            if k == 'out_time_us' and seg_us > 0:
                try:
                    frac = min(1.0, int(v) / seg_us)
                    pct  = int(pct_start + frac * (pct_end - pct_start))
                    self._push_progress(pct, js_fn=progress_fn)
                    # Log every 10% milestone
                    if pct // 10 != last_pct // 10:
                        log('FFMPEG', f'  progress: {pct}%  ({time.time()-t0:.1f}s)')
                        last_pct = pct
                except Exception:
                    pass
            elif k == 'progress' and v == 'end':
                self._push_progress(pct_end, js_fn=progress_fn)

        proc.wait()
        elapsed = time.time() - t0
        ok      = proc.returncode == 0
        stderr  = ''.join(stderr_buf)
        log('FFMPEG', f'Exit {proc.returncode}  ({elapsed:.1f}s)' + ('' if ok else ' ← FAILED'))
        if stderr.strip():
            log('FFMPEG', '── stderr ──────────────────────────────')
            for ln in stderr_buf:
                stripped = ln.rstrip()
                if stripped:
                    log('FFMPEG', '  ' + stripped)
            log('FFMPEG', '────────────────────────────────────────')
        return ok, stderr

    def _encode_segment(self, source, seg, out_path, p, flip_filter, pct_start, pct_end, aspect_filter=''):
        dur      = round(seg['end'] - seg['start'], 3)
        seg_us   = int(dur * 1_000_000)
        vf_parts = [f for f in (aspect_filter, flip_filter) if f]
        vf       = ['-vf', ','.join(vf_parts)] if vf_parts else []
        cmd    = (
            ['ffmpeg', '-y', '-hwaccel', 'auto',
             '-ss', str(round(seg['start'], 3)), '-t', str(dur),
             '-i', source,
             '-progress', 'pipe:1', '-nostats', '-threads', '0',
             '-avoid_negative_ts', '1', '-reset_timestamps', '1']
            + vf + _nvenc_args(p) + ['-c:a', 'aac', out_path]
        )
        return self._run_ffmpeg(cmd, seg_us, pct_start, pct_end)

    def _encode_segment_cpu(self, source, seg, out_path, p, flip_filter, pct_start, pct_end, aspect_filter=''):
        dur      = round(seg['end'] - seg['start'], 3)
        seg_us   = int(dur * 1_000_000)
        vf_parts = [f for f in (aspect_filter, flip_filter) if f]
        vf       = ['-vf', ','.join(vf_parts)] if vf_parts else []
        cmd    = (
            ['ffmpeg', '-y',
             '-ss', str(round(seg['start'], 3)), '-t', str(dur),
             '-i', source,
             '-progress', 'pipe:1', '-nostats', '-threads', '0',
             '-avoid_negative_ts', '1', '-reset_timestamps', '1']
            + vf + _x264_args(p) + ['-c:a', 'aac', out_path]
        )
        return self._run_ffmpeg(cmd, seg_us, pct_start, pct_end)

    def _export_burnin(self, source_path, segments, save_path, p, flip_filter, captions, seg_meta,
                       aspect_filter='', text_style=None, preview_height_px=0,
                       aspect='', aspect_mode='crop', caption_mode='static', text_layers=None,
                       image_layers=None):
        """filter_complex single-pass with styled ASS caption + text-layer
        burn-in, plus image/sticker overlay compositing. Image layers force
        the multi-input filter_complex path even for a single segment —
        ffmpeg's overlay filter needs one input per image, which the plain
        single-segment -vf chain has no way to express."""
        total_dur = sum(seg['end'] - seg['start'] for seg in segments)
        total_us  = int(total_dur * 1_000_000)
        image_layers = image_layers or []

        out_w = out_h = 0
        if seg_meta and (captions or text_layers or image_layers):
            out_w, out_h = _compute_output_dims(source_path, aspect, aspect_mode)

        ass_path = None
        try:
            if seg_meta and (captions or text_layers):
                log('EXPORT', f'Generating ASS ({len(captions)} captions, {len(text_layers or [])} text layers, {out_w}x{out_h}, mode={caption_mode})...')
                ass = _generate_ass(captions, seg_meta, text_style or {}, preview_height_px, out_w, out_h, caption_mode, text_layers)
                tmp = tempfile.NamedTemporaryFile(
                    suffix='.ass', delete=False, mode='w', encoding='utf-8'
                )
                tmp.write(ass)
                tmp.close()
                ass_path = tmp.name
                log('EXPORT', f'ASS written: {ass_path}')
        except Exception as e:
            log('EXPORT', f'ASS generation failed: {e}')

        prog_flags = ['-progress', 'pipe:1', '-nostats', '-threads', '0']
        image_inputs = []
        for layer in image_layers:
            path = layer.get('path')
            if path and os.path.isfile(path):
                image_inputs.append(['-i', path])
            else:
                log('EXPORT', f'✕ Skipping image layer — file not found: {path}')
        # Drop layers whose file didn't exist, keeping image_inputs and
        # image_layers in sync (both indexed the same way in _make_filter_complex)
        image_layers = [l for l in image_layers if l.get('path') and os.path.isfile(l.get('path'))]

        if len(segments) == 1 and not image_layers:
            seg = segments[0]
            dur = round(seg['end'] - seg['start'], 3)
            vf  = []
            if ass_path:
                esc = ass_path.replace('\\', '/').replace(':', '\\:')
                vf.append(f"subtitles='{esc}'")
            if aspect_filter:
                vf.append(aspect_filter)
            if flip_filter:
                vf.append(flip_filter)
            base    = (['ffmpeg', '-y', '-ss', str(round(seg['start'], 3)), '-t', str(dur),
                        '-i', source_path] + prog_flags)
            vf_args = ['-vf', ','.join(vf)] if vf else []
            cmd_gpu = base + vf_args + _nvenc_args(p) + ['-c:a', 'aac', save_path]
            cmd_cpu = base + vf_args + _x264_args(p)  + ['-c:a', 'aac', save_path]
        else:
            image_input_flags = [f for pair in image_inputs for f in pair]
            base = ['ffmpeg', '-y', '-i', source_path] + image_input_flags + prog_flags
            fc_gpu, ov_gpu = _make_filter_complex(segments, flip_filter, ass_path, aspect_filter,
                                                  image_layers, seg_meta, out_w, out_h)
            fc_cpu, ov_cpu = _make_filter_complex(segments, flip_filter, ass_path, aspect_filter,
                                                  image_layers, seg_meta, out_w, out_h)
            cmd_gpu = (base + ['-filter_complex', fc_gpu, '-map', ov_gpu, '-map', '[outa]']
                       + _nvenc_args(p) + ['-c:a', 'aac', save_path])
            cmd_cpu = (base + ['-filter_complex', fc_cpu, '-map', ov_cpu, '-map', '[outa]']
                       + _x264_args(p)  + ['-c:a', 'aac', save_path])

        log('EXPORT', 'Running GPU encode (filter_complex + burnin)...')
        ok, err = self._run_ffmpeg(cmd_gpu, total_us, 0, 100)
        if not ok and not self._export_cancelled:
            log('EXPORT', '✕ GPU burnin failed — retrying CPU')
            ok, err = self._run_ffmpeg(cmd_cpu, total_us, 0, 100)

        if ass_path:
            try:
                os.unlink(ass_path)
            except Exception:
                pass

        if self._export_cancelled:
            log('EXPORT', 'Cancelled by user')
            return {'success': False, 'error': 'cancelled'}
        if ok:
            size_mb = os.path.getsize(save_path) / 1_048_576 if os.path.exists(save_path) else 0
            log('EXPORT', f'✓ Burnin export done  →  {save_path}  ({size_mb:.1f} MB)')
            return {'success': True, 'path': save_path}
        log('EXPORT', f'✕ Burnin export failed')
        return {'success': False, 'error': err}

    # ── Preview proxy (Part A3 Option 3) ────────────────────────────────────
    # A fast, low-quality background render of the kept segments only,
    # concatenated gaplessly — swapped into video.src client-side for
    # perfectly gapless scrub-anywhere playback (bypasses the virtual
    # playSegments jump-logic entirely, since the file itself has no gaps).
    # Not the final export: nvenc p1 + CQ32 + downscaled to 1280 wide, purely
    # for smooth editing feel.

    def render_preview_proxy(self, source_path, segments_json):
        try:
            segments = json.loads(segments_json)
            if not segments:
                return {'success': False, 'error': 'No segments'}

            # Best-effort cleanup of the previous proxy — otherwise every
            # render leaves an orphaned temp file behind.
            if self._last_proxy_path and os.path.exists(self._last_proxy_path):
                try:
                    os.unlink(self._last_proxy_path)
                except Exception:
                    pass

            out_path  = os.path.join(tempfile.gettempdir(), f'clipcut_proxy_{int(time.time()*1000)}.mp4')
            total_dur = sum(seg['end'] - seg['start'] for seg in segments)
            total_us  = int(total_dur * 1_000_000)
            log('PROXY', f'Rendering — {len(segments)} segment(s), {total_dur:.1f}s total  →  {out_path}')

            prog_flags  = ['-progress', 'pipe:1', '-nostats', '-threads', '0']
            scale_vf    = "scale='min(1280,iw)':-2"

            if len(segments) == 1:
                seg = segments[0]
                dur = round(seg['end'] - seg['start'], 3)
                base = (['ffmpeg', '-y', '-ss', str(round(seg['start'], 3)), '-t', str(dur),
                         '-i', source_path] + prog_flags + ['-vf', scale_vf])
                cmd_gpu = (['ffmpeg', '-y', '-hwaccel', 'auto'] + base[2:] +
                           ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '32', '-c:a', 'aac', '-b:a', '96k', out_path])
                cmd_cpu = (base +
                           ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', out_path])
            else:
                fc   = self._make_proxy_filter_complex(segments, scale_vf)
                base = ['ffmpeg', '-y', '-i', source_path] + prog_flags + ['-filter_complex', fc, '-map', '[outv]', '-map', '[outa]']
                cmd_gpu = base + ['-c:v', 'h264_nvenc', '-preset', 'p1', '-cq', '32', '-c:a', 'aac', '-b:a', '96k', out_path]
                cmd_cpu = base + ['-c:v', 'libx264', '-preset', 'veryfast', '-crf', '30', '-c:a', 'aac', '-b:a', '96k', out_path]

            ok, err = self._run_ffmpeg(cmd_gpu, total_us, 0, 100, progress_fn='_onProxyProgress')
            if not ok and not self._export_cancelled:
                log('PROXY', '✕ GPU proxy render failed — retrying CPU')
                ok, err = self._run_ffmpeg(cmd_cpu, total_us, 0, 100, progress_fn='_onProxyProgress')

            if not ok:
                log('PROXY', f'✕ Proxy render failed: {err[-300:] if err else ""}')
                return {'success': False, 'error': err[-300:] if err else 'ffmpeg failed'}

            self._last_proxy_path = out_path
            size_mb = os.path.getsize(out_path) / 1_048_576 if os.path.exists(out_path) else 0
            log('PROXY', f'✓ Ready  ({size_mb:.1f} MB)')
            return {'success': True, 'path': out_path, 'duration': total_dur}
        except Exception as exc:
            import traceback
            log('PROXY', f'✕ UNCAUGHT EXCEPTION: {exc}')
            log('PROXY', traceback.format_exc())
            return {'success': False, 'error': str(exc)}

    def _make_proxy_filter_complex(self, segments, scale_vf):
        parts = []
        for i, seg in enumerate(segments):
            s, e = round(seg["start"], 3), round(seg["end"], 3)
            parts.append(f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{i}]")
            parts.append(f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}]")
        n = len(segments)
        interleaved = "".join(f"[v{i}][a{i}]" for i in range(n))
        parts.append(f"{interleaved}concat=n={n}:v=1:a=1[cv][outa]")
        parts.append(f"[cv]{scale_vf}[outv]")
        return ";".join(parts)


# ── Config hot-reload ─────────────────────────────────────────────────────────

def _config_watcher():
    """Poll config.json every 2s. On change: reload and tell JS to re-fetch."""
    cfg_path    = os.path.join(BASE_DIR, 'config.json')
    last_mtime  = os.path.getmtime(cfg_path) if os.path.exists(cfg_path) else 0
    while True:
        time.sleep(2)
        try:
            mtime = os.path.getmtime(cfg_path)
            if mtime != last_mtime:
                last_mtime = mtime
                log('CONFIG', 'config.json changed — hot-reloading')
                if webview.windows:
                    webview.windows[0].evaluate_js("loadConfig().then(()=>{ if(S.orKey) fetchOpenRouterModels(); toast('\u2699 Config reloaded'); })")
        except Exception as e:
            log('CONFIG', f'watcher error: {e}')

threading.Thread(target=_config_watcher, daemon=True).start()


# ── Startup ───────────────────────────────────────────────────────────────────

def start_http():
    os.chdir(BASE_DIR)
    with socketserver.TCPServer(('', HTTP_PORT), NoCacheHandler) as httpd:
        log('HTTP', f'Serving static files at http://localhost:{HTTP_PORT}')
        httpd.serve_forever()


print()
print('=' * 60)
print('  ClipCut')
print('=' * 60)
print(f'  Whisper model : {MODEL_SIZE}  ({DEVICE} / {COMPUTE_TYPE})')
print(f'  HTTP port     : {HTTP_PORT}')
print(f'  Base dir      : {BASE_DIR}')
print('  Flask         : REMOVED — all APIs via pywebview')
print('=' * 60)
print()

threading.Thread(target=start_http, daemon=True).start()

def _auto_ping_whisper():
    """Load the appropriate transcription model on startup and push status to the UI."""
    time.sleep(2)  # let the window finish loading
    log('WHISPER', f'Auto-ping: loading models (backend={WHISPER_BACKEND})...')
    try:
        if WHISPER_BACKEND == 'parakeet':
            _get_parakeet_model()
            model_label   = PARAKEET_MODEL_ID.split('/')[-1]
            backend_label = 'Parakeet'
        elif WHISPER_BACKEND == 'whisperx':
            _get_whisperx_model()
            model_label   = WHISPERX_MODEL
            backend_label = 'WhisperX'
        else:
            _get_whisper_model()
            model_label   = MODEL_SIZE
            backend_label = 'faster-whisper'
        _get_vad_model()
        status_text = f'\u2713 Ready \u00b7 {backend_label} \u00b7 {model_label} \u00b7 {DEVICE}'
        badge_text  = backend_label
        badge_color = ('var(--teal)' if WHISPER_BACKEND == 'parakeet'
                       else 'var(--blue-soft)' if WHISPER_BACKEND == 'whisperx'
                       else 'var(--text2)')
        js = (
            f"document.getElementById('whisperStatus').textContent={repr(status_text)};"
            f"document.getElementById('whisperStatus').style.color='var(--teal)';"
            f"var _b=document.getElementById('settingsBackendBadge');"
            f"if(_b){{_b.textContent={repr(badge_text)};_b.style.color='{badge_color}';}}"
        )
        log('WHISPER', f'\u2713 Auto-ping success — {backend_label} {model_label} {DEVICE}')
    except Exception as e:
        js = (
            f"document.getElementById('whisperStatus').textContent="
            f"{repr(chr(10005) + ' Load failed: ' + str(e)[:60])};"
            f"document.getElementById('whisperStatus').style.color='var(--red)'"
        )
        log('WHISPER', f'\u2715 Auto-ping failed: {e}')
    try:
        webview.windows[0].evaluate_js(js)
    except Exception:
        pass

threading.Thread(target=_auto_ping_whisper, daemon=True).start()

api    = API()
_storage_path = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.webview_data')
os.makedirs(_storage_path, exist_ok=True)

try:
    window = webview.create_window(
        'ClipCut',
        f'http://localhost:{HTTP_PORT}/clipcut.html',
        js_api=api,
        width=1920,
        height=1080,
        min_size=(1280, 720),
        confirm_close=True,
        shadow=True,
        storage_path=_storage_path,
    )
except TypeError:
    # Older pywebview — storage_path not supported, localStorage won't persist across sessions
    window = webview.create_window(
        'ClipCut',
        f'http://localhost:{HTTP_PORT}/clipcut.html',
        js_api=api,
        width=1920,
        height=1080,
        min_size=(1280, 720),
        confirm_close=True,
        shadow=True,
    )

# Remote DevTools — access at chrome://inspect after launch
webview.settings['REMOTE_DEBUGGING_PORT'] = 9222

# ── Native app menu ───────────────────────────────────────────────────────────
def _js(fn): return lambda: window.evaluate_js(fn)

try:
    # pywebview 5+ moved Menu/MenuAction/MenuSeparator into the webview.menu
    # submodule and stopped re-exporting them at the top level — webview.Menu
    # still resolves in some builds but webview.MenuAction/MenuSeparator raise
    # AttributeError, which previously made the whole menu setup fail and
    # fall back to no menu at all even though this build fully supports
    # native menus via the submodule import.
    from webview.menu import Menu, MenuAction, MenuSeparator

    menu = [
        Menu('File', [
            MenuAction('Open Video',        _js('onUploadZoneClick()')),
            MenuSeparator(),
            MenuAction('Save Project',      _js('saveProject()')),
            MenuAction('Open Project',      _js('openProject()')),
            MenuSeparator(),
            MenuAction('Export',            _js('openExportModal()')),
            MenuSeparator(),
            MenuAction('Quit',              lambda: window.destroy()),
        ]),
        Menu('Edit', [
            MenuAction('Undo  Ctrl+Z',      _js('undo()')),
            MenuAction('Redo  Ctrl+Shift+Z',_js('redo()')),
            MenuSeparator(),
            MenuAction('Delete Selected Cut',_js('deleteSelectedCut()')),
        ]),
        Menu('View', [
            MenuAction('Zoom Timeline In',  _js('zoomTL(1)')),
            MenuAction('Zoom Timeline Out', _js('zoomTL(-1)')),
            MenuAction('Zoom to Fit',       _js('zoomToFit()')),
            MenuSeparator(),
            MenuAction('Toggle DevTools',   lambda: window.evaluate_js('window.__devtools=!window.__devtools')),
        ]),
        Menu('Help', [
            MenuAction('About ClipCut',     _js("toast('ClipCut \u00b7 built by Vexxe')")),
        ]),
    ]
    webview.start(menu=menu)
except Exception as _menu_err:
    log('MENU', f'Native menu not supported in this pywebview build ({_menu_err}) — starting without menu')
    webview.start()
