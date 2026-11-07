"""Worker RunPod Serverless do E Se? Studio.

Contrato de ENTRADA (job["input"]):
  prompt (str, obrigatório), negative_prompt (str), width (int, múltiplo de 16), height (int),
  num_frames (int, 4k+1, máx. 81), fps (int), seed (int), steps (int), guidance (float), model (str)
Contrato de SAÍDA:
  {"video_b64": "<mp4 em base64>", "seed": int, "model": str, "frames": int, "fps": int, "bytes": int}
  ou {"error": "..."} em falha.
Armazenamento: nada persiste no worker; o MP4 volta em base64 na resposta e é apagado do disco.
"""
import base64, os, sys, tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import runpod  # noqa: E402
from video_wan import generate  # noqa: E402

MAX_FRAMES = 81


def handler(job):
    inp = job.get("input") or {}
    if not inp.get("prompt"):
        return {"error": "prompt obrigatório"}
    if int(inp.get("num_frames", 81)) > MAX_FRAMES:
        return {"error": f"num_frames acima do máximo suportado ({MAX_FRAMES})"}
    with tempfile.TemporaryDirectory() as d:
        out = os.path.join(d, "clipe.mp4")
        r = generate({**inp, "out": out})
        data = open(out, "rb").read()
    return {"video_b64": base64.b64encode(data).decode(), "seed": r["seed"], "model": r["model"], "frames": r["frames"], "fps": r["fps"], "bytes": len(data)}


if __name__ == "__main__":
    runpod.serverless.start({"handler": handler})
