#!/usr/bin/env python3
"""Adaptador Kokoro (kokoro-onnx, pesos Apache-2.0) — TTS local, CPU.

Entrada (stdin, JSON):
  {"op": "voices"}  -> lista de vozes
  {"op": "speak", "text": "...", "voice": "pf_dora" | null,
   "blend": [{"voice": "pm_alex", "weight": 0.6}, ...] | null,
   "speed": 1.0, "lang": "pt-br", "out": "/caminho/arquivo.wav"}
Saída (stdout, JSON): {"ok": true, "duration": s, "sample_rate": 24000}

`blend` é interpolação REAL dos vetores de estilo (embeddings) das vozes Kokoro: só vozes
pré-definidas do próprio modelo, nunca referências de terceiros.
Integração derivada do uso de Kokoro em lemo-opuscar/core/tts/tts.py (MIT, LemoLab).
"""
import json, os, sys

HERE = os.path.dirname(os.path.abspath(__file__))
MODEL_DIR = os.environ.get("KOKORO_DIR") or os.path.join(os.path.dirname(HERE), "data", "modelos", "kokoro")


def load():
    from kokoro_onnx import Kokoro
    return Kokoro(os.path.join(MODEL_DIR, "kokoro-v1.0.onnx"), os.path.join(MODEL_DIR, "voices-v1.0.bin"))


def main():
    req = json.load(sys.stdin)
    k = load()
    if req.get("op") == "voices":
        print(json.dumps({"ok": True, "voices": sorted(k.get_voices())}))
        return
    import numpy as np
    import soundfile as sf
    voice = req.get("voice") or "pf_dora"
    blend = req.get("blend")
    if blend:
        total = sum(max(0.0, float(b["weight"])) for b in blend) or 1.0
        style = None
        for b in blend:
            v = k.get_voice_style(b["voice"]) * (float(b["weight"]) / total)
            style = v if style is None else style + v
        voice = style
    samples, sr = k.create(req["text"], voice=voice, speed=float(req.get("speed", 1.0)), lang=req.get("lang", "pt-br"))
    samples = np.asarray(samples, dtype=np.float32)
    out = req["out"]
    os.makedirs(os.path.dirname(out), exist_ok=True)
    sf.write(out, samples, sr, subtype="PCM_24")
    print(json.dumps({"ok": True, "duration": len(samples) / sr, "sample_rate": sr}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
