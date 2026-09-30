"""Piper text-to-speech HTTP service (Stage 0).

Called only by the gateway over the internal Docker network. Logs metadata only —
never the text (CLAUDE.md rule 4).
"""
from __future__ import annotations

import io
import json
import logging
import os
import subprocess
import threading
import time
import wave
from collections import OrderedDict
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Optional

import yaml
from fastapi import FastAPI, HTTPException
from fastapi.responses import Response
from pydantic import BaseModel, Field

from app.translit import TRANSLITERATORS

log = logging.getLogger("tts")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(), format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":%(message)s}')

CONTENT_TYPES = {"wav": "audio/wav", "mp3": "audio/mpeg", "ogg": "audio/ogg", "opus": "audio/ogg"}
FFMPEG_ARGS = {
    "mp3": ["-c:a", "libmp3lame", "-b:a", "48k", "-f", "mp3"],
    # WhatsApp voice notes: Opus in Ogg, mono.
    "ogg": ["-c:a", "libopus", "-b:a", "24k", "-application", "voip", "-f", "ogg"],
    "opus": ["-c:a", "libopus", "-b:a", "24k", "-application", "voip", "-f", "ogg"],
}


@dataclass
class Settings:
    languages_file: str = os.getenv("TTS_LANGUAGES_FILE", "/config/tts_languages.yaml")
    voices_dir: str = os.getenv("VOICES_DIR", "/voices")
    threads: int = int(os.getenv("TTS_THREADS", "1"))
    max_loaded_voices: int = int(os.getenv("TTS_MAX_LOADED_VOICES", "2"))
    max_chars: int = int(os.getenv("MAX_TTS_CHARS", "1500"))
    languages: dict[str, Any] = field(default_factory=dict)

    def load_languages(self) -> None:
        with open(self.languages_file, encoding="utf-8") as f:
            data = yaml.safe_load(f) or {}
        self.languages = {k: v for k, v in (data.get("languages") or {}).items() if v.get("enabled", True)}


class SynthRequest(BaseModel):
    text: str = Field(min_length=1)
    language: str
    voice: Optional[str] = None
    format: str = "wav"
    speed: Optional[float] = Field(default=None, ge=0.5, le=2.0)


def load_piper_voice(path: Path, threads: int) -> Any:
    import onnxruntime
    from piper.config import PiperConfig
    from piper.voice import PiperVoice

    opts = onnxruntime.SessionOptions()
    opts.intra_op_num_threads = threads
    opts.inter_op_num_threads = 1
    with open(f"{path}.json", encoding="utf-8") as f:
        config = PiperConfig.from_dict(json.load(f))
    session = onnxruntime.InferenceSession(str(path), sess_options=opts, providers=["CPUExecutionProvider"])
    return PiperVoice(config=config, session=session)


def piper_synth(voice: Any, text: str, speed: Optional[float]) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as wav:
        voice.synthesize(text, wav, length_scale=(1.0 / speed) if speed else None, sentence_silence=0.15)
    return buf.getvalue()


def wav_seconds(wav_bytes: bytes) -> float:
    with wave.open(io.BytesIO(wav_bytes), "rb") as w:
        return w.getnframes() / float(w.getframerate() or 1)


def encode(wav_bytes: bytes, fmt: str) -> bytes:
    if fmt == "wav":
        return wav_bytes
    proc = subprocess.run(
        ["ffmpeg", "-hide_banner", "-loglevel", "error", "-i", "pipe:0", "-ac", "1", *FFMPEG_ARGS[fmt], "pipe:1"],
        input=wav_bytes,
        capture_output=True,
        timeout=30,
        check=False,
    )
    if proc.returncode != 0:
        raise RuntimeError("ffmpeg failed")
    return proc.stdout


def jlog(**kv: Any) -> None:
    log.info(json.dumps(kv))


def create_app(
    settings: Optional[Settings] = None,
    voice_loader: Callable[[Path, int], Any] = load_piper_voice,
    synth: Callable[[Any, str, Optional[float]], bytes] = piper_synth,
    encoder: Callable[[bytes, str], bytes] = encode,
) -> FastAPI:
    s = settings or Settings()
    if not s.languages:
        s.load_languages()
    cache: "OrderedDict[str, Any]" = OrderedDict()
    lock = threading.Lock()

    def voice_path(name: str) -> Path:
        return Path(s.voices_dir) / f"{name}.onnx"

    def get_voice(name: str) -> Any:
        if name in cache:
            cache.move_to_end(name)
            return cache[name]
        path = voice_path(name)
        if not path.exists():
            raise HTTPException(503, detail={"code": "voice_not_downloaded", "message": f"voice {name} missing (run setup profile)"})
        v = voice_loader(path, s.threads)
        cache[name] = v
        while len(cache) > s.max_loaded_voices:
            cache.popitem(last=False)
        return v

    app = FastAPI(title="koneqti-tts", docs_url=None, redoc_url=None)

    @app.get("/health")
    def health() -> dict[str, Any]:
        missing = sorted({c["voice"] for c in s.languages.values() if not voice_path(c["voice"]).exists()})
        return {"ok": True, "languages": sorted(s.languages), "voices_missing": missing, "loaded": list(cache)}

    @app.post("/synthesize")
    def synthesize(req: SynthRequest) -> Response:
        lang = s.languages.get(req.language.lower())
        if not lang:
            raise HTTPException(422, detail={"code": "tts_language_unavailable", "message": f"no voice for {req.language}"})
        if req.format not in CONTENT_TYPES:
            raise HTTPException(400, detail={"code": "unsupported_format", "message": "format must be wav, mp3, ogg or opus"})
        if len(req.text) > s.max_chars:
            raise HTTPException(413, detail={"code": "text_too_long", "message": f"text longer than {s.max_chars}"})
        voice_name = lang["voice"]
        if req.voice and req.voice != voice_name:
            raise HTTPException(422, detail={"code": "tts_voice_unavailable", "message": "voice not configured for language"})

        text = req.text
        if lang.get("mode") == "transliterate":
            fn = TRANSLITERATORS.get(lang.get("transliterate", ""))
            if fn is None:
                raise HTTPException(500, detail={"code": "misconfigured_language", "message": "unknown transliteration"})
            text = fn(text)

        started = time.monotonic()
        with lock:  # one synthesis at a time: fixed CPU budget
            voice = get_voice(voice_name)
            wav_bytes = synth(voice, text, req.speed)
        seconds = wav_seconds(wav_bytes)
        try:
            audio = encoder(wav_bytes, req.format)
        except Exception:
            raise HTTPException(500, detail={"code": "encode_failed", "message": "audio encoding failed"})
        jlog(event="synthesized", language=req.language, voice=voice_name, chars=len(req.text), audio_s=round(seconds, 2),
             format=req.format, ms=int((time.monotonic() - started) * 1000))
        return Response(
            content=audio,
            media_type=CONTENT_TYPES[req.format],
            headers={"x-audio-seconds": f"{seconds:.2f}", "x-voice": voice_name},
        )

    return app


app = create_app() if os.getenv("TTS_SKIP_APP") != "1" else None
