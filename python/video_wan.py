#!/usr/bin/env python3
"""Geração de clipes com Wan 2.1 (pesos Apache-2.0) via diffusers — usada LOCALMENTE e no worker RunPod.

Modelo padrão: Wan-AI/Wan2.1-T2V-1.3B-Diffusers (texto→vídeo, ~8 GB de VRAM a 480p).
Imagem inicial (image→vídeo) só existe nos modelos Wan2.1-I2V-14B (exigem GPU de 24–80 GB);
com o 1.3B o campo `image_b64` é recusado com explicação, nunca ignorado em silêncio.

stdin (JSON): {"op": "check"} | {"op": "generate", "prompt": "...", "negative_prompt": "...",
  "width": 832, "height": 480, "num_frames": 81, "fps": 16, "seed": 42, "steps": 30, "guidance": 5.0,
  "model": "...", "out": "/caminho/clipe.mp4"}
stdout (JSON): {"ok": true, ...}
"""
import json, os, sys

DEFAULT_MODEL = "Wan-AI/Wan2.1-T2V-1.3B-Diffusers"


def check():
    info = {"ok": True, "torch": None, "cuda": False, "gpus": [], "diffusers": None}
    try:
        import torch
        info["torch"] = torch.__version__
        info["cuda"] = bool(torch.cuda.is_available())
        if info["cuda"]:
            for i in range(torch.cuda.device_count()):
                p = torch.cuda.get_device_properties(i)
                info["gpus"].append({"name": p.name, "vram_gb": round(p.total_memory / 1e9, 1)})
        info["mps"] = bool(getattr(torch.backends, "mps", None) and torch.backends.mps.is_available())
    except Exception as e:  # noqa: BLE001
        info["torch_error"] = str(e)
    try:
        import diffusers
        info["diffusers"] = diffusers.__version__
    except Exception as e:  # noqa: BLE001
        info["diffusers_error"] = str(e)
    return info


def generate(req):
    import torch
    from diffusers import AutoencoderKLWan, WanPipeline
    from diffusers.utils import export_to_video
    if req.get("image_b64"):
        raise ValueError("O modelo Wan2.1-T2V-1.3B não aceita imagem inicial; use um modelo I2V-14B em GPU compatível.")
    if not torch.cuda.is_available():
        raise RuntimeError("GPU CUDA não encontrada: este modelo não roda de forma prática em CPU.")
    model = req.get("model") or DEFAULT_MODEL
    vae = AutoencoderKLWan.from_pretrained(model, subfolder="vae", torch_dtype=torch.float32)
    pipe = WanPipeline.from_pretrained(model, vae=vae, torch_dtype=torch.bfloat16).to("cuda")
    seed = int(req.get("seed", 42))
    g = torch.Generator("cuda").manual_seed(seed)
    frames = pipe(prompt=req["prompt"], negative_prompt=req.get("negative_prompt", ""), height=int(req.get("height", 480)),
                  width=int(req.get("width", 832)), num_frames=int(req.get("num_frames", 81)),
                  guidance_scale=float(req.get("guidance", 5.0)), num_inference_steps=int(req.get("steps", 30)), generator=g).frames[0]
    out = req["out"]
    export_to_video(frames, out, fps=int(req.get("fps", 16)))
    return {"ok": True, "out": out, "seed": seed, "model": model, "frames": len(frames), "fps": int(req.get("fps", 16))}


def main():
    req = json.load(sys.stdin)
    if req.get("op") == "check":
        print(json.dumps(check()))
        return
    print(json.dumps(generate(req)))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:  # noqa: BLE001
        print(json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}))
        sys.exit(1)
