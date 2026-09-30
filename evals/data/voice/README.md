# Voice-note eval set (WER)

Put anonymised voice notes here (never real customer audio without consent) and list them in
`manifest.jsonl`, one per line:

```json
{"id": "v-ur-1", "file": "v-ur-1.ogg", "language": "ur", "reference": "السلام علیکم میرا آرڈر کب آئے گا"}
```

`npm --prefix evals run eval` transcribes each file through `/v1/audio/transcriptions` and reports
WER per language plus language-detection accuracy. Audio files are git-ignored; keep them on the server.
