import os
import re
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


# ── Logger ────────────────────────────────────────────────────────────────────

def log(category, msg, *extra):
    ts = time.strftime('%H:%M:%S')
    prefix = f'[{ts}] [{category}]'
    print(f'{prefix} {msg}')
    for line in extra:
        print(f'{" " * len(prefix)}   {line}')


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

def _make_filter_complex(segments, flip_filter, srt_path=None, aspect_filter=''):
    parts = []
    for i, seg in enumerate(segments):
        s, e = round(seg["start"], 3), round(seg["end"], 3)
        parts.append(f"[0:v]trim=start={s}:end={e},setpts=PTS-STARTPTS[v{i}]")
        parts.append(f"[0:a]atrim=start={s}:end={e},asetpts=PTS-STARTPTS[a{i}]")
    n = len(segments)
    interleaved = "".join(f"[v{i}][a{i}]" for i in range(n))
    parts.append(f"{interleaved}concat=n={n}:v=1:a=1[outv][outa]")
    out_v = "[outv]"
    if srt_path:
        esc = srt_path.replace("\\", "/").replace(":", "\\:")
        parts.append(f"[outv]subtitles='{esc}'[subv]")
        out_v = "[subv]"
    if aspect_filter:
        parts.append(f"{out_v}{aspect_filter}[av]")
        out_v = "[av]"
    if flip_filter:
        parts.append(f"{out_v}{flip_filter}[fv]")
        out_v = "[fv]"
    return ";".join(parts), out_v

def _generate_srt(captions, seg_meta):
    def src_to_tl(t):
        for seg in seg_meta:
            if seg["sourceStart"] <= t <= seg["sourceEnd"]:
                return seg["timelineStart"] + (t - seg["sourceStart"])
        return None

    def fmt(s):
        h, m = int(s // 3600), int((s % 3600) // 60)
        sec = s % 60
        return f"{h:02d}:{m:02d}:{int(sec):02d},{int(round((sec % 1) * 1000)):03d}"

    lines, idx = [], 1
    for cap in captions:
        ts = src_to_tl(cap["start"])
        if ts is None:
            continue
        te = src_to_tl(cap["end"])
        if te is None:
            te = ts + (cap["end"] - cap["start"])
        lines += [str(idx), f"{fmt(ts)} --> {fmt(te)}", cap["text"], ""]
        idx += 1
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
                'webm':'video/webm','m4v':'video/mp4','avi':'video/x-msvideo'}.get(ext, 'application/octet-stream')
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

    def pick_folder(self):
        """Native OS folder picker. Returns absolute path or None."""
        log('DIALOG', 'pick_folder() — opening native folder picker')
        result = webview.windows[0].create_file_dialog(webview.FileDialog.FOLDER)
        path = result[0] if result else None
        log('DIALOG', f'✓ Folder selected: {path}' if path else 'Folder picker cancelled')
        return path

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
                     aspect='', aspect_mode='crop'):
        """
        Open native Save dialog, encode directly to disk with ffmpeg.

        Fast path (burn_captions=False):
          - Single segment  → one-pass hwaccel encode direct to save_path
          - Multi segment   → extract each segment (hwaccel) then concat -c copy

        Fallback (burn_captions=True):
          - filter_complex single-pass with SRT overlay

        aspect: target ratio like '9/16', or '' to export at source aspect
        (bug #21 — export previously ignored the preview's aspect entirely).
        aspect_mode: 'crop' (crop-to-fill, default) | 'pad' (pad-to-fit).
        """
        try:
            return self._export_video_inner(
                source_path, segments_json, output_name,
                preset, flip_h, flip_v,
                burn_captions, captions_json, seg_meta_json,
                aspect, aspect_mode
            )
        except Exception as exc:
            import traceback
            log('EXPORT', f'✕ UNCAUGHT EXCEPTION: {exc}')
            log('EXPORT', traceback.format_exc())
            return {'success': False, 'error': str(exc)}

    def _export_video_inner(self, source_path, segments_json, output_name,
                            preset, flip_h, flip_v,
                            burn_captions, captions_json, seg_meta_json,
                            aspect='', aspect_mode='crop'):
        self._export_cancelled = False

        log('EXPORT', f'source:       {source_path}')
        log('EXPORT', f'output_name:  {output_name}')
        log('EXPORT', f'preset:       {preset}  flip_h={flip_h}  flip_v={flip_v}  burn_captions={burn_captions}'
                       f'  aspect={aspect or "source"}  aspect_mode={aspect_mode}')

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
        log('EXPORT', f'Save path: {save_path}')

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
            log('EXPORT', 'Mode: filter_complex + SRT burn-in (single-pass)')
            return self._export_burnin(
                source_path, segments, save_path, p, flip_filter,
                json.loads(captions_json), json.loads(seg_meta_json), aspect_filter
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

    def _push_progress(self, pct, label=None):
        if label is None:
            label = 'Done!' if pct >= 100 else f'Encoding\u2026 {pct}%'
        safe = label.replace("'", "\\'")
        try:
            webview.windows[0].evaluate_js(f"setProgress({pct}, '{safe}')")
        except Exception:
            pass

    def _run_ffmpeg(self, cmd, seg_us, pct_start, pct_end):
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
                    self._push_progress(pct)
                    # Log every 10% milestone
                    if pct // 10 != last_pct // 10:
                        log('FFMPEG', f'  progress: {pct}%  ({time.time()-t0:.1f}s)')
                        last_pct = pct
                except Exception:
                    pass
            elif k == 'progress' and v == 'end':
                self._push_progress(pct_end)

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

    def _export_burnin(self, source_path, segments, save_path, p, flip_filter, captions, seg_meta, aspect_filter=''):
        """filter_complex single-pass with SRT caption burn-in."""
        total_dur = sum(seg['end'] - seg['start'] for seg in segments)
        total_us  = int(total_dur * 1_000_000)

        srt_path = None
        try:
            if captions and seg_meta:
                log('EXPORT', f'Generating SRT ({len(captions)} captions)...')
                srt = _generate_srt(captions, seg_meta)
                tmp = tempfile.NamedTemporaryFile(
                    suffix='.srt', delete=False, mode='w', encoding='utf-8'
                )
                tmp.write(srt)
                tmp.close()
                srt_path = tmp.name
                log('EXPORT', f'SRT written: {srt_path}')
        except Exception as e:
            log('EXPORT', f'SRT generation failed: {e}')

        prog_flags = ['-progress', 'pipe:1', '-nostats', '-threads', '0']

        if len(segments) == 1:
            seg = segments[0]
            dur = round(seg['end'] - seg['start'], 3)
            vf  = []
            if srt_path:
                esc = srt_path.replace('\\', '/').replace(':', '\\:')
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
            base           = ['ffmpeg', '-y', '-i', source_path] + prog_flags
            fc_gpu, ov_gpu = _make_filter_complex(segments, flip_filter, srt_path, aspect_filter)
            fc_cpu, ov_cpu = _make_filter_complex(segments, flip_filter, srt_path, aspect_filter)
            cmd_gpu = (base + ['-filter_complex', fc_gpu, '-map', ov_gpu, '-map', '[outa]']
                       + _nvenc_args(p) + ['-c:a', 'aac', save_path])
            cmd_cpu = (base + ['-filter_complex', fc_cpu, '-map', ov_cpu, '-map', '[outa]']
                       + _x264_args(p)  + ['-c:a', 'aac', save_path])

        log('EXPORT', 'Running GPU encode (filter_complex + burnin)...')
        ok, err = self._run_ffmpeg(cmd_gpu, total_us, 0, 100)
        if not ok and not self._export_cancelled:
            log('EXPORT', '✕ GPU burnin failed — retrying CPU')
            ok, err = self._run_ffmpeg(cmd_cpu, total_us, 0, 100)

        if srt_path:
            try:
                os.unlink(srt_path)
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
    menu = [
        webview.Menu('File', [
            webview.MenuAction('Open Video',        _js('onUploadZoneClick()')),
            webview.MenuAction('Export',            _js('openExportModal()')),
            webview.MenuSeparator(),
            webview.MenuAction('Quit',              lambda: window.destroy()),
        ]),
        webview.Menu('Edit', [
            webview.MenuAction('Undo  Ctrl+Z',      _js('undo()')),
            webview.MenuAction('Redo  Ctrl+Shift+Z',_js('redo()')),
            webview.MenuSeparator(),
            webview.MenuAction('Delete Selected Cut',_js('deleteSelectedCut()')),
        ]),
        webview.Menu('View', [
            webview.MenuAction('Zoom Timeline In',  _js('zoomTL(1)')),
            webview.MenuAction('Zoom Timeline Out', _js('zoomTL(-1)')),
            webview.MenuAction('Zoom to Fit',       _js('zoomToFit()')),
            webview.MenuSeparator(),
            webview.MenuAction('Toggle DevTools',   lambda: window.evaluate_js('window.__devtools=!window.__devtools')),
        ]),
        webview.Menu('Help', [
            webview.MenuAction('About ClipCut',     _js("toast('ClipCut \u00b7 built by Vexxe')")),
        ]),
    ]
    webview.start(menu=menu)
except Exception as _menu_err:
    log('MENU', f'Native menu not supported in this pywebview build ({_menu_err}) — starting without menu')
    webview.start()
