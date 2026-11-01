#!/usr/bin/env bash
#
# Build the reference sandbox image and print the immutable digest.
#
# The base image must be passed by digest in production. Example:
#
#   docker pull alpine:3.20
#   ALPINE_DIGEST=$(docker image inspect --format '{{index .RepoDigests 0}}' alpine:3.20)
#   BASE_IMAGE="$ALPINE_DIGEST" ./scripts/sandbox-image/build.sh
#
set -euo pipefail

BASE_IMAGE="${BASE_IMAGE:?set BASE_IMAGE to a pinned base image, e.g. alpine:3.20@sha256:...}"
TAG="${TAG:-eunoia-sandbox:general}"

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

docker build \
  --build-arg "BASE_IMAGE=${BASE_IMAGE}" \
  -t "${TAG}" \
  -f "${ROOT}/scripts/sandbox-image/Dockerfile" \
  "${ROOT}"

DIGEST="$(docker image inspect --format '{{.Id}}' "${TAG}")"
echo "image:  ${TAG}"
echo "digest: ${DIGEST}"
echo
echo "put this in .env:"
echo "SANDBOX_IMAGE_DIGEST=${DIGEST}"

# A quick sanity check: the image must run as the sandbox uid and have the
# toolchain the reference image promises.
docker run --rm --network none --read-only --cap-drop ALL \
  --security-opt no-new-privileges:true --user 1000:1000 "${DIGEST}" \
  sh -lc 'id -u; node --version; python3 --version; git --version'
