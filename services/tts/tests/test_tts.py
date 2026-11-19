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


@pytest.mark.parametrize(
    "fmt,ctype",
    [("ogg_opus", "audio/ogg"), ("ogg", "audio/ogg"), ("mulaw_8k", "audio/basic"), ("pcm_16k", "audio/L16; rate=16000; channels=1")],
)
def test_format_names_and_aliases(env, fmt, ctype):
    c, _, _ = env
    r = c.post("/synthesize", json={"text": "x", "language": "en", "format": fmt})
    assert r.status_code == 200
    assert r.headers["content-type"] == ctype


def test_unknown_format_400(env):
    c, _, _ = env
    assert c.post("/synthesize", json={"text": "x", "language": "en", "format": "flac"}).status_code == 400


@pytest.mark.skipif(__import__("shutil").which("ffmpeg") is None, reason="ffmpeg not installed")
def test_real_ffmpeg_encoding():
    from app.main import encode

    wav = fake_wav(1.0, rate=22050)  # Piper medium voices are 22.05 kHz
    assert encode(wav, "ogg_opus")[:4] == b"OggS"
    assert encode(wav, "mp3")[:3] in (b"ID3", b"\xff\xfb", b"\xff\xf3", b"\xff\xf2") or encode(wav, "mp3")[0] == 0xFF
    assert len(encode(wav, "mulaw_8k")) == 8000  # 1 s × 8000 samples × 1 byte
    assert len(encode(wav, "pcm_16k")) == 32000  # 1 s × 16000 samples × 2 bytes


def test_voices_load_lazily_and_unload_when_idle(tmp_path: Path):
    (tmp_path / "en_US-test.onnx").write_bytes(b"x")
    loaded = []
    app = create_app(
        Settings(voices_dir=str(tmp_path), languages={"en": {"voice": "en_US-test"}}, idle_unload_s=0.05),
        voice_loader=lambda path, threads: loaded.append(path.name) or path.stem,
        synth=lambda v, t, sp: fake_wav(0.1),
        encoder=lambda wav, fmt: wav,
    )
    with TestClient(app) as c:
        assert c.get("/health").json()["loaded"] == []
        c.post("/synthesize", json={"text": "a", "language": "en"})
        assert c.get("/health").json()["loaded"] == ["en_US-test"]
        assert app.state.reap() == []  # just used
        import time

        time.sleep(0.08)
        assert app.state.reap() == ["en_US-test"]
        assert c.get("/health").json()["loaded"] == []
        c.post("/synthesize", json={"text": "a", "language": "en"})
        assert loaded == ["en_US-test.onnx", "en_US-test.onnx"]
