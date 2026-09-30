"""Downloads the Whisper model into WHISPER_MODEL_DIR (run once by the `setup` compose profile)."""
from faster_whisper.utils import download_model

from app.main import Settings

if __name__ == "__main__":
    s = Settings()
    path = download_model(s.model, cache_dir=s.model_dir)
    print(f"whisper model '{s.model}' ready at {path}")
