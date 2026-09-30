FROM python:3.11-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 \
    WHISPER_MODEL=small WHISPER_COMPUTE_TYPE=int8 WHISPER_THREADS=2 WHISPER_MODEL_DIR=/models \
    OMP_NUM_THREADS=2

WORKDIR /srv
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY app ./app

RUN useradd --system --uid 10001 speech && mkdir -p /models && chown speech /models
USER speech
EXPOSE 9001
# nice: web (PHP/MySQL) always wins the CPU on the shared server.
CMD ["nice", "-n", "10", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9001", "--workers", "1", "--no-access-log"]
