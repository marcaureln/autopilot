FROM debian:13.4-slim

# The agent works in a git checkout, and the official image (ghcr.io/anomalyco/opencode) has no git.
# Without ripgrep on the PATH, OpenCode downloads it on each run.
RUN apt-get update -q \
  && apt-get install -y -q --no-install-recommends git ca-certificates curl ripgrep \
  && apt-get clean && find /var/lib/apt/lists -type f -delete

# The dev container feature's script, so both places install the same checked binary.
COPY feature/install.sh /tmp/install-opencode.sh
ARG OPENCODE_VERSION=2.3.0
RUN VERSION=$OPENCODE_VERSION sh /tmp/install-opencode.sh && rm /tmp/install-opencode.sh

COPY opencode.json /etc/opencode/opencode.json

WORKDIR /work
