FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    VOICES_DIR=/voices TTS_LANGUAGES_FILE=/config/tts_languages.yaml TTS_THREADS=1 OMP_NUM_THREADS=1

# ffmpeg: wav → mp3 / ogg-opus (WhatsApp voice notes)
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

RUN useradd --system --uid 10002 tts && mkdir -p /voices && chown tts /voices
USER tts
EXPOSE 9002
CMD ["nice", "-n", "10", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9002", "--workers", "1", "--no-access-log"]
