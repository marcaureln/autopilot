FROM node:26.13.1

ARG CLAUDE_CODE_VERSION=2.1.325
# The pnpm version of mise.toml.
ARG PNPM_VERSION=12.21.0

RUN apt-get update -q \
  && apt-get install -y -q --no-install-recommends \
    git ca-certificates less procps unzip jq gnupg2 \
  && apt-get clean && rm -rf /var/lib/apt/lists/*

ENV DEVCONTAINER=true

RUN npm install -g pnpm@${PNPM_VERSION} && npm cache clean --force

RUN npm install -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}
