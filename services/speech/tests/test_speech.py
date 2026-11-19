import time
from types import SimpleNamespace

import pytest
from fastapi.testclient import TestClient

from app.main import Settings, create_app, segment_confidence


class FakeModel:
    def __init__(self, duration=4.0, fail=False):
        self.duration = duration
        self.fail = fail
        self.calls = []

    def transcribe(self, audio, **kw):
        self.calls.append(kw)
        if self.fail:
            raise ValueError("bad audio")
        segs = [
            SimpleNamespace(start=0.0, end=2.0, text=" Assalam o alaikum,", avg_logprob=-0.1, no_speech_prob=0.01),
            SimpleNamespace(start=2.0, end=4.0, text=" order kab aayega?", avg_logprob=-0.4, no_speech_prob=0.02),
        ]
        info = SimpleNamespace(language=kw.get("language") or "ur", language_probability=0.91, duration=self.duration)
        return iter(segs), info


def client(model=None, **settings):
    fake = model or FakeModel()
    app = create_app(Settings(**settings), model_factory=lambda s: fake, model_check=lambda s: True)
    return TestClient(app), fake


def test_health_ok():
    with client()[0] as c:
        assert c.get("/health").json()["ok"] is True


def test_load_failure_is_503_and_visible_in_health():
    def boom(_s):
        raise RuntimeError("no model")

    with TestClient(create_app(Settings(), model_factory=boom, model_check=lambda s: True)) as c:
        assert c.get("/health").status_code == 200  # nothing tried yet (lazy)
        r = c.post("/transcribe", files={"file": ("a.ogg", b"x")})
        assert r.status_code == 503
        assert r.json()["detail"]["code"] == "model_load_failed"
        assert c.get("/health").json()["detail"]["code"] == "model_load_failed"


def test_health_503_when_model_not_downloaded():
    with TestClient(create_app(Settings(), model_factory=lambda s: FakeModel(), model_check=lambda s: False)) as c:
        assert c.get("/health").json()["detail"]["code"] == "model_not_downloaded"


def test_lazy_load_then_idle_unload_then_reload():
    loads = []

    def factory(_s):
        loads.append(1)
        return FakeModel()

    app = create_app(Settings(idle_unload_s=0.05), model_factory=factory, model_check=lambda s: True)
    with TestClient(app) as c:
        assert loads == []  # not loaded at start-up
        assert c.get("/health").json()["loaded"] is False
        assert c.post("/transcribe", files={"file": ("n.ogg", b"x")}).status_code == 200
        assert len(loads) == 1 and c.get("/health").json()["loaded"] is True
        app.state.reap()  # used just now → stays
        assert app.state.lazy.loaded
        time.sleep(0.08)
        app.state.reap()
        assert c.get("/health").json()["loaded"] is False
        assert c.post("/transcribe", files={"file": ("n.ogg", b"x")}).status_code == 200
        assert len(loads) == 2


def test_preload_and_never_unload():
    loads = []
    app = create_app(Settings(idle_unload_s=0, preload=True), model_factory=lambda s: loads.append(1) or FakeModel(),
                     model_check=lambda s: True)
    with TestClient(app) as c:
        assert len(loads) == 1
        app.state.reap()
        assert c.get("/health").json()["loaded"] is True


def test_transcribe_returns_text_language_confidence():
    with client()[0] as c:
        r = c.post("/transcribe", files={"file": ("note.ogg", b"OggS...", "audio/ogg")})
        assert r.status_code == 200
        b = r.json()
        assert b["text"] == "Assalam o alaikum, order kab aayega?"
        assert b["language"] == "ur"
        assert b["language_probability"] == 0.91
        assert 0 < b["confidence"] <= 1
        assert b["duration"] == 4.0  # gateway also returns it as duration_sec
        assert "segments" not in b


def test_language_hint_and_segments():
    c_, fake = client()
    with c_ as c:
        r = c.post("/transcribe", files={"file": ("n.ogg", b"x")}, data={"language": "ar", "segments": "true"})
        assert r.json()["language"] == "ar"
        assert len(r.json()["segments"]) == 2
    assert fake.calls[0]["language"] == "ar"
    assert fake.calls[0]["beam_size"] == 1


def test_bad_audio_400_and_too_long_413():
    with client(FakeModel(fail=True))[0] as c:
        r = c.post("/transcribe", files={"file": ("n.ogg", b"x")})
        assert r.status_code == 400
        assert r.json()["detail"]["code"] == "invalid_audio"
    with client(FakeModel(duration=999))[0] as c:
        r = c.post("/transcribe", files={"file": ("n.ogg", b"x")})
        assert r.status_code == 413
        assert r.json()["detail"]["code"] == "audio_too_long"


def test_too_large_upload_413():
    with client(max_audio_bytes=10)[0] as c:
        r = c.post("/transcribe", files={"file": ("n.ogg", b"x" * 11)})
        assert r.status_code == 413


def test_no_transcript_in_logs(caplog):
    with client()[0] as c, caplog.at_level("INFO", logger="speech"):
        c.post("/transcribe", files={"file": ("n.ogg", b"x")})
    assert "alaikum" not in caplog.text
    assert "transcribed" in caplog.text


def test_segment_confidence():
    segs = [SimpleNamespace(start=0, end=1, avg_logprob=0.0)]
    assert segment_confidence(segs) == 1.0
    assert segment_confidence([]) == 0.0
    assert segment_confidence([SimpleNamespace(start=0, end=1, avg_logprob=-100)]) == pytest.approx(0.0, abs=1e-3)
