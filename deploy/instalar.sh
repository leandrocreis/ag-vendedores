#!/usr/bin/env bash
# Instala o E Se? Studio num servidor Linux (Ubuntu/Debian), com HTTPS automático.
# Uso (como root):  bash instalar.sh [dominio]
# Sem domínio, usa <IP>.sslip.io (certificado Let's Encrypt automático pelo Caddy).
set -euo pipefail
DIR=/opt/e-se-studio
REPO=https://github.com/leandrocreis/ag-vendedores.git
BRANCH=claude/new-session-7axq8c
if ! command -v docker >/dev/null; then curl -fsSL https://get.docker.com | sh; fi
if ! command -v git >/dev/null; then apt-get update && apt-get install -y git; fi
if [ -d "$DIR/.git" ]; then git -C "$DIR" fetch origin "$BRANCH" && git -C "$DIR" checkout -q "$BRANCH" && git -C "$DIR" pull -q origin "$BRANCH"; else git clone -b "$BRANCH" "$REPO" "$DIR"; fi
cd "$DIR"
IP=$(curl -fsS4 https://api.ipify.org)
DOMINIO=${1:-$(echo "$IP" | tr . -).sslip.io}
if [ ! -f .env ]; then
  SENHA=$(head -c 18 /dev/urandom | base64 | tr -d '/+=' | cut -c1-20)
  umask 077
  printf 'ESE_DOMINIO=%s\nESE_SENHA=%s\n# Chaves (opcional; também podem ser cadastradas pela interface):\n# ANTHROPIC_API_KEY=\n# OPENAI_API_KEY=\n# RUNPOD_API_KEY=\n' "$DOMINIO" "$SENHA" > .env
fi
docker compose up -d --build
echo
echo "E Se? Studio: https://$(grep ^ESE_DOMINIO .env | cut -d= -f2)"
echo "Senha: $(grep ^ESE_SENHA .env | cut -d= -f2)   (guardada em $DIR/.env, permissão 600)"
