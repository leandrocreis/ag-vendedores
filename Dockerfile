# E Se? Studio — imagem para servidor (modo ESE_MODO=servidor, atrás do Caddy com HTTPS).
FROM node:22-bookworm
ENV DEBIAN_FRONTEND=noninteractive PLAYWRIGHT_BROWSERS_PATH=/ms-playwright KOKORO_DIR=/opt/modelos/kokoro ESE_DATA_DIR=/dados
RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv git ca-certificates curl fonts-dejavu && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
COPY server/package.json server/
COPY web/package.json web/
RUN npm ci
RUN npx playwright-core install --with-deps chromium
COPY python/requirements.txt python/
RUN python3 -m venv .venv && .venv/bin/pip install --no-cache-dir -r python/requirements.txt
RUN mkdir -p $KOKORO_DIR && for f in kokoro-v1.0.onnx voices-v1.0.bin; do curl -fsSL -o $KOKORO_DIR/$f https://github.com/thewh1teagle/kokoro-onnx/releases/download/model-files-v1.0/$f; done
COPY refs.lock.json scripts/fetch-refs.mjs scripts/
RUN mv scripts/refs.lock.json . && node scripts/fetch-refs.mjs
COPY . .
RUN cd web && npx vite build
ENV ESE_MODO=servidor PORTA=4870
EXPOSE 4870
CMD ["npx", "tsx", "server/src/index.ts"]
