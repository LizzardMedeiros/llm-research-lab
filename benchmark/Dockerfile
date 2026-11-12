# Benchmark tool: downloads public videos/channel metadata (yt-dlp) and
# measures format, narration cadence, editing pace, loudness and layout frames.
# Isolated from the lab: never imported by the engine; outputs go to benchmarks/.
FROM node:22-bookworm

RUN apt-get update && apt-get install -y --no-install-recommends ffmpeg python3 python3-venv fonts-dejavu-core \
 && rm -rf /var/lib/apt/lists/*

# yt-dlp tracks YouTube changes closely: rebuild the image to update it
# (docker compose --profile benchmark build --no-cache benchmark).
RUN python3 -m venv /opt/bench && /opt/bench/bin/pip install --no-cache-dir -U "yt-dlp[default]" numpy
ENV PATH=/opt/bench/bin:$PATH

USER node
WORKDIR /app
CMD ["python3", "/app/benchmark/bench.py", "--help"]
