#!/bin/sh
# Baixa o GGUF na primeira subida (o volume persiste entre restarts) e sobe
# o llama-server com os parâmetros medidos na RTX 3050 6 GB (ADR-0031).
set -e
MODEL_PATH="/models/${MODEL_FILE}"
if [ ! -s "$MODEL_PATH" ]; then
  echo "Baixando ${MODEL_FILE} (~6 GB) de ${MODEL_REPO}..."
  curl -fL --retry 5 -o "${MODEL_PATH}.part" "https://huggingface.co/${MODEL_REPO}/resolve/main/${MODEL_FILE}"
  mv "${MODEL_PATH}.part" "$MODEL_PATH"
fi
# --jinja: tool calling nativo. --reasoning auto: deixa o cliente desligar o
# thinking com reasoning_effort "none" (com --reasoning on o servidor ignora
# isso). -fitt: margem de VRAM que o fit automático deixa livre — 256 MiB
# põe o máximo de camadas na GPU (~5,8 tok/s vs ~4,5 com a margem padrão).
exec /app/llama-server -m "$MODEL_PATH" --host 0.0.0.0 --port 8080 \
  -c "${CTX_SIZE}" -fa on -ctk q8_0 -ctv q8_0 --jinja -np 1 --reasoning auto \
  -fitt "${FIT_TARGET_MIB}" "$@"
