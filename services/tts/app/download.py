"""Downloads every Piper voice named in tts_languages.yaml into VOICES_DIR.

Run once by `docker compose --profile setup run --rm tts-setup`. Checks each voice exists in
the upstream catalogue and prints its MODEL_CARD so the licence can be checked (spec §3).
"""
from __future__ import annotations

import json
import os
import sys
import urllib.request
from pathlib import Path

import yaml

CFG = os.getenv("TTS_LANGUAGES_FILE", "/config/tts_languages.yaml")
OUT = Path(os.getenv("VOICES_DIR", "/voices"))


def fetch(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=120) as r:  # noqa: S310 — fixed https host from config
        return r.read()


def main() -> int:
    cfg = yaml.safe_load(open(CFG, encoding="utf-8"))
    base = cfg.get("voice_base_url", "https://huggingface.co/rhasspy/piper-voices/resolve/main").rstrip("/")
    catalogue = json.loads(fetch(f"{base}/voices.json"))
    OUT.mkdir(parents=True, exist_ok=True)
    voices = sorted({v["voice"] for v in cfg["languages"].values() if v.get("enabled", True)})
    failed = False
    for name in voices:
        entry = catalogue.get(name)
        if not entry:
            family = name.split("-")[0]
            alts = sorted(k for k in catalogue if k.startswith(family))
            print(f"!! voice {name} not in catalogue. Available for {family}: {alts or 'none'}")
            failed = True
            continue
        files = entry["files"]
        onnx = next(p for p in files if p.endswith(".onnx"))
        for rel, suffix in ((onnx, ".onnx"), (f"{onnx}.json", ".onnx.json")):
            dest = OUT / f"{name}{suffix}"
            if dest.exists():
                continue
            print(f"downloading {rel}")
            dest.write_bytes(fetch(f"{base}/{rel}"))
        card = next((p for p in files if p.endswith("MODEL_CARD")), None)
        if card:
            text = fetch(f"{base}/{card}").decode("utf-8", "replace")
            (OUT / f"{name}.MODEL_CARD").write_text(text, encoding="utf-8")
            lic = [line for line in text.splitlines() if "licen" in line.lower()]
            print(f"   {name} licence lines: {lic or 'NOT FOUND — read the card'}")
    print(f"voices in {OUT}: {sorted(p.name for p in OUT.glob('*.onnx'))}")
    print("Check every MODEL_CARD, then set licence_checked: true in tts_languages.yaml.")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
