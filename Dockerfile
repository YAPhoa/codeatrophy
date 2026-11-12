# syntax=docker/dockerfile:1

ARG GO_VERSION=1.27.4
ARG NODE_VERSION=22

# 1. Web UI: production build of web/ into /web/dist.
FROM node:${NODE_VERSION}-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY web/ ./
RUN npm run build

# 2. Server: a static binary with the UI embedded.
FROM golang:${GO_VERSION}-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=web /web/dist/ ./internal/webui/dist/
ARG VERSION=0.1.0
RUN test -f internal/webui/dist/index.html \
 && CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/codeathropy ./cmd/codeathropy \
 && mkdir -p /out/data

# 3. Runtime: distroless, non-root.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/codeathropy /usr/local/bin/codeathropy
COPY --from=build --chown=65532:65532 /out/data /data
COPY LICENSE /usr/share/doc/codeathropy/LICENSE
ENV CODEATHROPY_ADDR=:8080 \
    CODEATHROPY_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8080
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/codeathropy", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/codeathropy"]
CMD ["serve"]
