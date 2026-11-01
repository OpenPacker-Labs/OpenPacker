# syntax=docker/dockerfile:1.7
# Runtime image for the publishable @openpacker/cli bundle (multi-stage, non-root).
#
# Build from repository root:
#   docker build -f apps/openpacker-cli/Dockerfile -t openpacker-cli:local .
#
# Base images are pinned by digest (amd64). Re-resolve digests when bumping Node.
ARG NODE_BUILD_IMAGE=node@sha256:cff78eb5aa1cf27dc2b6aeea9d31366415a43e9a9ea0ddec00d780b2b66fad0f
ARG NODE_RUNTIME_IMAGE=node@sha256:cff78eb5aa1cf27dc2b6aeea9d31366415a43e9a9ea0ddec00d780b2b66fad0f

FROM ${NODE_BUILD_IMAGE} AS build
WORKDIR /repo
ENV OPENPACKER_OFFLINE=1
ENV CI=true
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 make g++ curl ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --default-toolchain 1.88.0 --profile minimal \
  && . "$HOME/.cargo/env" \
  && rustup target add wasm32-unknown-unknown \
  && cargo install --locked wasm-bindgen-cli --version 0.2.126
ENV PATH="/root/.cargo/bin:${PATH}"
COPY package.json package-lock.json turbo.json tsconfig.base.json ./
COPY scripts scripts
COPY apps apps
COPY packages packages
COPY crates crates
COPY spec spec
RUN npm ci --ignore-scripts
RUN npm run bundle --workspace @openpacker/cli

FROM ${NODE_RUNTIME_IMAGE} AS runtime
WORKDIR /app
ENV NODE_ENV=production
ENV OPENPACKER_OFFLINE=1
RUN groupadd --gid 65532 openpacker \
  && useradd --uid 65532 --gid openpacker --shell /usr/sbin/nologin --create-home openpacker
COPY --from=build /repo/apps/openpacker-cli/release/package.json ./package.json
COPY --from=build /repo/apps/openpacker-cli/release/dist ./dist
RUN npm install --omit=dev --ignore-scripts \
  && npm cache clean --force \
  && chown -R openpacker:openpacker /app
USER 65532:65532
ENTRYPOINT ["node", "dist/index.js"]
CMD ["--help"]
