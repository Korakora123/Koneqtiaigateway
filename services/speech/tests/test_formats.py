"""Real decoding of the audio formats MesgAI sends (handover §1.2). No Whisper model needed:
faster-whisper decodes with PyAV and resamples to 16 kHz mono before the model sees it."""
import io
import math
import shutil
import struct
import subprocess
import wave

import pytest

decode_audio = pytest.importorskip("faster_whisper.audio").decode_audio


def tone_wav(rate: int, seconds: float = 1.0) -> bytes:
    buf = io.BytesIO()
    with wave.open(buf, "wb") as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(b"".join(struct.pack("<h", int(8000 * math.sin(2 * math.pi * 440 * i / rate))) for i in range(int(rate * seconds))))
    return buf.getvalue()


@pytest.mark.parametrize("rate", [8000, 16000, 44100])
def test_wav_any_rate_becomes_16k(rate):
    samples = decode_audio(io.BytesIO(tone_wav(rate)), sampling_rate=16000)
    assert abs(len(samples) - 16000) < 400  # ≈ 1 s at 16 kHz


FFMPEG = {
    "ogg_opus": ["-c:a", "libopus", "-f", "ogg"],
    "mp3": ["-c:a", "libmp3lame", "-f", "mp3"],
    "m4a": ["-c:a", "aac", "-movflags", "frag_keyframe+empty_moov", "-f", "ipod"],
    "webm": ["-c:a", "libopus", "-f", "webm"],
}


@pytest.mark.skipif(shutil.which("ffmpeg") is None, reason="ffmpeg not installed")
@pytest.mark.parametrize("fmt", list(FFMPEG))
def test_compressed_formats_decode(fmt):
    enc = subprocess.run(
        ["ffmpeg", "-loglevel", "error", "-i", "pipe:0", *FFMPEG[fmt], "pipe:1"],
        input=tone_wav(16000), capture_output=True, check=True,
    ).stdout
    samples = decode_audio(io.BytesIO(enc), sampling_rate=16000)
    assert abs(len(samples) - 16000) < 1600
