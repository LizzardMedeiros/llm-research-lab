# Video pipeline: HyperFrames (HTML -> video) + ffmpeg + headless Chrome + Kokoro TTS.
FROM node:22-bookworm

ENV HYPERFRAMES_NO_TELEMETRY=1 \
    DO_NOT_TRACK=1 \
    npm_config_update_notifier=false

RUN apt-get update && apt-get install -y --no-install-recommends \
      ffmpeg unzip python3 python3-venv \
      fonts-dejavu fonts-noto-color-emoji \
      libnss3 libatk1.0-0 libatk-bridge2.0-0 libcups2 libdrm2 libxkbcommon0 \
      libxcomposite1 libxdamage1 libxfixes3 libxrandr2 libgbm1 libasound2 \
      libpango-1.0-0 libcairo2 \
 && rm -rf /var/lib/apt/lists/*

# Local text-to-speech (Kokoro-82M via ONNX) used by `hyperframes tts`.
RUN python3 -m venv /opt/tts && /opt/tts/bin/pip install --no-cache-dir kokoro-onnx soundfile
ENV PATH=/opt/tts/bin:$PATH

WORKDIR /video
RUN chown node:node /video
USER node
COPY --chown=node:node package.json package-lock.json ./
RUN npm ci
RUN npx hyperframes browser ensure
CMD ["npx", "hyperframes", "doctor"]
