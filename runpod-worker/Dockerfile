# Worker RunPod Serverless — Wan 2.1 T2V 1.3B (pesos Apache-2.0).
# Construa e publique em um registro seu:  docker build -t <seu-registro>/ese-wan-worker:0.1.0 -f runpod-worker/Dockerfile .
# Depois crie um endpoint Serverless no console RunPod apontando para essa imagem (GPU ≥ 16 GB recomendada).
FROM pytorch/pytorch:2.5.1-cuda12.4-cudnn9-runtime
ENV PYTHONUNBUFFERED=1 HF_HOME=/runpod-volume/hf
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg && rm -rf /var/lib/apt/lists/*
RUN pip install --no-cache-dir runpod==1.12.0 diffusers==0.42.1 transformers accelerate ftfy imageio imageio-ffmpeg sentencepiece
COPY python/video_wan.py /app/video_wan.py
COPY runpod-worker/handler.py /app/handler.py
WORKDIR /app
# Opcional: pré-baixar os pesos na imagem para reduzir partida a frio
# RUN python -c "from diffusers import WanPipeline; WanPipeline.from_pretrained('Wan-AI/Wan2.1-T2V-1.3B-Diffusers')"
CMD ["python", "-u", "handler.py"]
