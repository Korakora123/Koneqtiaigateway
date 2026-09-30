import os

os.environ.setdefault("TTS_SKIP_APP", "1")  # don't build the module-level app (needs /config) during tests
