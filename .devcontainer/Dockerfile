# Dev container for OpenPacker CI parity (build stage).
# Pinned toolchain; non-root runtime. Do not COPY the repo — Dev Containers mount it.
FROM rust:1-bookworm AS rust-base
RUN rustup default 1.88.0

FROM debian:bookworm-slim AS node-base
ARG NODE_VERSION=22.19.0
ENV DEBIAN_FRONTEND=noninteractive
RUN apt-get update \
  && apt-get install -y --no-install-recommends ca-certificates curl xz-utils \
  && rm -rf /var/lib/apt/lists/* \
  && curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz" \
    | tar -xJ -C /usr/local --strip-components=1

FROM rust-base AS dev
RUN apt-get update \
  && apt-get install -y --no-install-recommends git sudo \
  && rm -rf /var/lib/apt/lists/*
COPY --from=node-base /usr/local /usr/local
RUN corepack enable \
  && rustup component add rustfmt clippy \
  && rustup target add wasm32-unknown-unknown
RUN useradd -m -u 1000 -s /bin/bash vscode \
  && echo "vscode ALL=(ALL) NOPASSWD:ALL" > /etc/sudoers.d/vscode \
  && chmod 0440 /etc/sudoers.d/vscode
USER vscode
WORKDIR /workspaces/OpenPacker
