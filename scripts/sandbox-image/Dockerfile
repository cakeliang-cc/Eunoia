# syntax=docker/dockerfile:1
#
# The reference sandbox base image: one non-root user, one writable workspace,
# and the runtimes a coding task normally needs (Node, Python, git, a shell).
#
# Build with the base image pinned by digest, e.g.:
#
#   docker build \
#     --build-arg BASE_IMAGE=alpine:3.20@sha256:<alpine-digest> \
#     -t eunoia-sandbox:general \
#     -f scripts/sandbox-image/Dockerfile .
#
# Then record the immutable ID and put it in SANDBOX_IMAGE_DIGEST:
#
#   docker image inspect --format '{{.Id}}' eunoia-sandbox:general
#
# Do not use a floating tag in production. The runtime refuses anything that is
# not a sha256: digest and starts containers with --pull=never, so recovery can
# never fetch a changed image.

ARG BASE_IMAGE=alpine:3.20
FROM ${BASE_IMAGE}

# uid/gid 1000 matches the sandbox runtime's fixed user. If an operator changes
# the runtime user, this image must change with it.
RUN apk add --no-cache \
      bash \
      ca-certificates \
      curl \
      git \
      nodejs \
      npm \
      py3-pip \
      python3 \
      ripgrep \
      tini \
    && addgroup -g 1000 sandbox \
    && adduser -D -u 1000 -G sandbox -h /tmp sandbox \
    && mkdir -p /workspace \
    && chown sandbox:sandbox /workspace

ENV HOME=/tmp \
    LANG=C.UTF-8 \
    PATH=/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin

USER sandbox
WORKDIR /workspace

# The Controller overrides this command; it is here so the image is a valid
# container by itself and can be smoke-tested.
CMD ["sleep", "2147483647"]
