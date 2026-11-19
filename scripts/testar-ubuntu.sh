#!/usr/bin/env bash
# Prova de compatibilidade com Ubuntu 24.04: instala Node 22 num container ubuntu:24.04 limpo, faz npm ci,
# build, testes unitários e e2e (fila em memória e com Redis) contra o PostgreSQL/Redis do docker compose.
# Uso (na raiz do projeto, com "npm run db:up" já executado):  bash scripts/testar-ubuntu.sh
set -euo pipefail
REDE="$(docker inspect greencode-av3-db --format '{{range $k, $v := .NetworkSettings.Networks}}{{$k}}{{end}}')"
docker run --rm --network "$REDE" -v "$PWD":/origem:ro ubuntu:24.04 bash -euo pipefail -c '
  export DEBIAN_FRONTEND=noninteractive
  apt-get update -qq && apt-get install -y -qq curl ca-certificates xz-utils rsync >/dev/null
  ARQ=$(uname -m | sed -e s/x86_64/x64/ -e s/aarch64/arm64/)
  VER=$(curl -fsSL https://nodejs.org/dist/latest-v22.x/SHASUMS256.txt | grep -o "node-v22[0-9.]*-linux-$ARQ.tar.xz" | head -1)
  curl -fsSL "https://nodejs.org/dist/latest-v22.x/$VER" | tar -xJ -C /opt && export PATH="/opt/${VER%.tar.xz}/bin:$PATH"
  echo "== $(. /etc/os-release; echo $PRETTY_NAME) | node $(node -v) | npm $(npm -v) | $(uname -m)"
  rsync -a --exclude node_modules --exclude dist --exclude .env --exclude .git /origem/ /app/ && cd /app
  export DATABASE_URL="postgresql://greencode:greencode@greencode-av3-db:5432/greencode?schema=ubuntu"
  export DATABASE_URL_TESTE="postgresql://greencode:greencode@greencode-av3-db:5432/greencode?schema=teste_ubuntu"
  # mesmo formato de saída em qualquer versão do Node (no 22, sem terminal, o padrão seria TAP)
  export NODE_OPTIONS="--test-reporter=spec"
  export REDIS_URL="redis://greencode-av3-redis:6379" JWT_SECRET="segredo-de-teste-com-mais-de-32-caracteres-ok"
  npm ci --no-audit --no-fund --loglevel=error
  npm test > /tmp/unit.log 2>&1 || { tail -40 /tmp/unit.log; exit 1; }; grep -E "^ℹ (tests|pass|fail)" /tmp/unit.log
  echo "== e2e (fila em memória)"; npm run test:e2e 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"
  echo "== e2e (BullMQ + Redis)"; TESTE_COM_REDIS=1 npm run test:e2e 2>&1 | grep -E "^ℹ (tests|pass|fail)|✖"
'
