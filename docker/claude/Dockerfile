FROM node:26.13.1-slim

RUN apt-get update -q \
  && apt-get install -y -q --no-install-recommends git ca-certificates \
  && apt-get clean && find /var/lib/apt/lists -type f -delete

RUN npm install -g @anthropic-ai/claude-code@2.1.325 && npm cache clean --force

COPY managed-settings.json /etc/claude-code/managed-settings.json

WORKDIR /work
