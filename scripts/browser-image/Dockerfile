# Build once, then configure EUNOIA_BROWSER_IMAGE_DIGEST with its immutable ID.
# The base is supplied by the operator; production never pulls a floating tag.
ARG BASE_IMAGE=eunoia-sandbox:general
FROM ${BASE_IMAGE}
USER root
RUN apk add --no-cache chromium \
 && mkdir -p /opt/browser \
 && npm install --prefix /opt/browser --ignore-scripts --omit=dev @playwright/mcp@0.0.80 \
 && npm cache clean --force
ENV HOME=/tmp LANG=C.UTF-8
USER 1000:1000
WORKDIR /tmp
CMD ["sleep", "2147483647"]
