#!/usr/bin/env python3
"""Transcrição/alinhamento da gravação REAL com faster-whisper (MIT; modelos Whisper MIT).

stdin: {"audio": "/master.wav", "language": "pt", "model": "small", "expected": "texto do roteiro"}
stdout: {"ok": true, "engine": "faster-whisper:<modelo>", "segments": [...], "words": [...]}
Cada palavra traz probability (confiança). Baixa confiança é sinalizada pelo backend.
"""
import json, os, sys


def main():
    req = json.load(sys.stdin)
    from faster_whisper import WhisperModel
    name = req.get("model") or os.environ.get("WHISPER_MODEL") or "small"
    model = WhisperModel(name, device="cpu", compute_type="int8", cpu_threads=max(1, (os.cpu_count() or 2) - 1))
    # decodificamos com o FFmpeg do sistema (evita incompatibilidades do PyAV)
    import subprocess, numpy as np
    raw = subprocess.run(["ffmpeg", "-v", "error", "-i", req["audio"], "-f", "f32le", "-ac", "1", "-ar", "16000", "-"],
                         check=True, capture_output=True).stdout
    audio = np.frombuffer(raw, dtype=np.float32)
    segs, info = model.transcribe(audio, language=req.get("language") or None, word_timestamps=True,
                                  vad_filter=False)  # sem prompt com o texto esperado: não enviesar a checagem
    out_s, out_w = [], []
    for s in segs:
        out_s.append({"t0": s.start, "t1": s.end, "text": s.text.strip(), "avg_logprob": s.avg_logprob})
        for w in (s.words or []):
            out_w.append({"t0": w.start, "t1": w.end, "word": w.word.strip(), "p": w.probability})
    print(json.dumps({"ok": True, "engine": f"faster-whisper:{name}", "language": info.language, "duration": info.duration,
                      "segments": out_s, "words": out_w}, ensure_ascii=False))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
