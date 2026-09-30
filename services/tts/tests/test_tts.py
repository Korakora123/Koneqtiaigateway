import io
import wave
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.main import Settings, create_app

LANGS = {
    "en": {"voice": "en_US-test", "mode": "native"},
    "ur": {"voice": "hi_IN-test", "mode": "transliterate", "transliterate": "ur-deva"},
}


def fake_wav(seconds=1.0, rate=16000) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"\0\0" * int(seconds * rate))
    return buf.getvalue()


@pytest.fixture()
def env(tmp_path: Path):
    for v in ("en_US-test", "hi_IN-test"):
        (tmp_path / f"{v}.onnx").write_bytes(b"x")
    seen: dict = {"texts": [], "loaded": []}

    def loader(path, threads):
        seen["loaded"].append(path.name)
        return path.stem

    def synth(voice, text, speed):
        seen["texts"].append((voice, text))
        return fake_wav(1.5)

    app = create_app(
        Settings(voices_dir=str(tmp_path), languages=dict(LANGS), max_loaded_voices=1),
        voice_loader=loader,
        synth=synth,
        encoder=lambda wav, fmt: wav if fmt == "wav" else b"OggS" + wav[:10],
    )
    return TestClient(app), seen, tmp_path


def test_synthesize_wav(env):
    c, seen, _ = env
    r = c.post("/synthesize", json={"text": "Your order is ready", "language": "en"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/wav"
    assert r.headers["x-audio-seconds"] == "1.50"
    assert r.headers["x-voice"] == "en_US-test"
    assert seen["texts"] == [("en_US-test", "Your order is ready")]


def test_urdu_is_transliterated_to_devanagari(env):
    c, seen, _ = env
    r = c.post("/synthesize", json={"text": "آپ کا آرڈر تیار ہے", "language": "ur", "format": "ogg"})
    assert r.status_code == 200
    assert r.headers["content-type"] == "audio/ogg"
    assert seen["texts"][-1] == ("hi_IN-test", "आप का ऑर्डर तयार है")


def test_unknown_language_422(env):
    c, _, _ = env
    r = c.post("/synthesize", json={"text": "x", "language": "zz"})
    assert r.status_code == 422
    assert r.json()["detail"]["code"] == "tts_language_unavailable"


def test_missing_voice_file_503_and_health_lists_it(env):
    c, _, tmp = env
    (tmp / "en_US-test.onnx").unlink()
    r = c.post("/synthesize", json={"text": "x", "language": "en"})
    assert r.status_code == 503
    assert c.get("/health").json()["voices_missing"] == ["en_US-test"]


def test_voice_cache_is_bounded(env):
    c, seen, _ = env
    for lang in ("en", "ur", "en"):
        c.post("/synthesize", json={"text": "a", "language": lang})
    assert seen["loaded"] == ["en_US-test.onnx", "hi_IN-test.onnx", "en_US-test.onnx"]


def test_no_text_in_logs(env, caplog):
    c, _, _ = env
    with caplog.at_level("INFO", logger="tts"):
        c.post("/synthesize", json={"text": "SECRET-TEXT", "language": "en"})
    assert "SECRET-TEXT" not in caplog.text
    assert "synthesized" in caplog.text
