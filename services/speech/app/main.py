"""faster-whisper HTTP service (Stage 0: `small`, int8, 2 threads).

Called only by the gateway over the internal Docker network. Logs metadata only —
never transcripts or audio (CLAUDE.md rule 4).
"""
from __future__ import annotations

import io
import logging
import math
import os
import threading
import time
from contextlib import asynccontextmanager
from dataclasses import dataclass
from typing import Any, Callable, Optional

from fastapi import FastAPI, File, Form, HTTPException, UploadFile

log = logging.getLogger("speech")
logging.basicConfig(level=os.getenv("LOG_LEVEL", "INFO").upper(), format='{"ts":"%(asctime)s","level":"%(levelname)s","msg":%(message)s}')


@dataclass(frozen=True)
class Settings:
    model: str = os.getenv("WHISPER_MODEL", "small")
    model_dir: str = os.getenv("WHISPER_MODEL_DIR", "/models")
    compute_type: str = os.getenv("WHISPER_COMPUTE_TYPE", "int8")
    threads: int = int(os.getenv("WHISPER_THREADS", "2"))
    beam_size: int = int(os.getenv("WHISPER_BEAM_SIZE", "1"))
    vad_filter: bool = os.getenv("WHISPER_VAD_FILTER", "true").lower() == "true"
    max_audio_seconds: float = float(os.getenv("MAX_AUDIO_SECONDS", "300"))
    max_audio_bytes: int = int(os.getenv("MAX_AUDIO_BYTES", str(25 * 1024 * 1024)))


def load_whisper(s: Settings) -> Any:
    from faster_whisper import WhisperModel  # imported lazily so tests don't need it

    return WhisperModel(
        s.model,
        device="cpu",
        compute_type=s.compute_type,
        cpu_threads=s.threads,
        num_workers=1,
        download_root=s.model_dir,
        local_files_only=os.getenv("HF_HUB_OFFLINE", "0") == "1",
    )


def segment_confidence(segments: list[Any]) -> float:
    """Duration-weighted mean of exp(avg_logprob), in [0, 1]."""
    total, weighted = 0.0, 0.0
    for seg in segments:
        dur = max(0.01, float(seg.end) - float(seg.start))
        weighted += dur * math.exp(min(0.0, float(seg.avg_logprob)))
        total += dur
    return round(weighted / total, 3) if total else 0.0


def jlog(**kv: Any) -> None:
    import json

    log.info(json.dumps(kv))


def create_app(settings: Optional[Settings] = None, model_factory: Callable[[Settings], Any] = load_whisper) -> FastAPI:
    s = settings or Settings()
    state: dict[str, Any] = {"model": None, "error": None}
    lock = threading.Lock()  # one transcription at a time: the CPU budget is fixed

    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        try:
            state["model"] = model_factory(s)
            jlog(event="model_loaded", model=s.model, compute_type=s.compute_type, threads=s.threads)
        except Exception as exc:  # keep serving /health so the problem is visible
            state["error"] = type(exc).__name__
            log.error('"model load failed: %s"', type(exc).__name__)
        yield

    app = FastAPI(title="koneqti-speech", lifespan=lifespan, docs_url=None, redoc_url=None)

    @app.get("/health")
    def health() -> dict[str, Any]:
        if state["model"] is None:
            raise HTTPException(503, detail={"code": "model_not_loaded", "message": state["error"] or "loading"})
        return {"ok": True, "model": s.model, "compute_type": s.compute_type, "threads": s.threads}

    @app.post("/transcribe")
    def transcribe(
        file: UploadFile = File(...),
        language: Optional[str] = Form(None),
        prompt: Optional[str] = Form(None),
        segments: bool = Form(False),
    ) -> dict[str, Any]:
        model = state["model"]
        if model is None:
            raise HTTPException(503, detail={"code": "model_not_loaded", "message": "speech model not loaded"})
        data = file.file.read(s.max_audio_bytes + 1)
        if len(data) > s.max_audio_bytes:
            raise HTTPException(413, detail={"code": "audio_too_large", "message": "audio file too large"})
        if not data:
            raise HTTPException(400, detail={"code": "file_required", "message": "empty audio"})

        started = time.monotonic()
        with lock:
            try:
                seg_iter, info = model.transcribe(
                    io.BytesIO(data),
                    language=language or None,
                    initial_prompt=prompt or None,
                    beam_size=s.beam_size,
                    vad_filter=s.vad_filter,
                    condition_on_previous_text=False,
                )
            except Exception as exc:
                jlog(event="decode_failed", error=type(exc).__name__)
                raise HTTPException(400, detail={"code": "invalid_audio", "message": "could not decode audio"})
            if float(info.duration) > s.max_audio_seconds:
                raise HTTPException(413, detail={"code": "audio_too_long", "message": f"audio longer than {s.max_audio_seconds:.0f}s"})
            segs = list(seg_iter)

        text = "".join(seg.text for seg in segs).strip()
        result: dict[str, Any] = {
            "text": text,
            "language": info.language,
            "language_probability": round(float(info.language_probability), 3),
            "confidence": segment_confidence(segs),
            "duration": round(float(info.duration), 2),
        }
        if segments:
            result["segments"] = [
                {
                    "start": round(float(x.start), 2),
                    "end": round(float(x.end), 2),
                    "text": x.text,
                    "avg_logprob": round(float(x.avg_logprob), 3),
                    "no_speech_prob": round(float(x.no_speech_prob), 3),
                }
                for x in segs
            ]
        jlog(
            event="transcribed",
            language=info.language,
            audio_s=result["duration"],
            ms=int((time.monotonic() - started) * 1000),
            segments=len(segs),
        )
        return result

    return app


app = create_app()
