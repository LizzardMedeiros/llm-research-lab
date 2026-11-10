# Modelo local (ADR-0031): Ternary Bonsai 2 27B via llama-server do fork da
# PrismML — os formatos ternários (PTQ1_0/PQ2_0) não existem no llama.cpp
# upstream nem no Ollama. CUDA 12.8 (o 13.3 dá segfault, KNOWN_ISSUES do
# modelo); arquitetura 86 = RTX 30xx, troque via build arg em outra GPU.
FROM nvidia/cuda:12.8.1-devel-ubuntu22.04 AS build
ARG CUDA_ARCH=86
ARG PRISM_REF=prism
RUN apt-get update && apt-get install -y --no-install-recommends git cmake build-essential ca-certificates \
 && rm -rf /var/lib/apt/lists/*
RUN git clone --depth 1 -b ${PRISM_REF} https://github.com/PrismML-Eng/llama.cpp /src
WORKDIR /src
RUN cmake -B build -DCMAKE_BUILD_TYPE=Release -DGGML_CUDA=ON -DCMAKE_CUDA_ARCHITECTURES=${CUDA_ARCH} \
      -DGGML_CUDA_FA_ALL_QUANTS=ON -DLLAMA_CURL=OFF -DGGML_NATIVE=ON -DBUILD_SHARED_LIBS=OFF \
 && cmake --build build -j8 --target llama-server

FROM nvidia/cuda:12.8.1-runtime-ubuntu22.04
RUN apt-get update && apt-get install -y --no-install-recommends libgomp1 curl ca-certificates \
 && rm -rf /var/lib/apt/lists/*
COPY --from=build /src/build/bin/llama-server /app/llama-server
COPY entrypoint.sh /app/entrypoint.sh
ENTRYPOINT ["/app/entrypoint.sh"]
