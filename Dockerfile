# syntax=docker/dockerfile:1

ARG GO_VERSION=1.27.4
ARG NODE_VERSION=22

# The UI and server stages run on the build machine, whatever the target
# platform: the UI is the same everywhere, and Go cross-compiles. The final
# stage runs nothing, so an image for another architecture needs no emulation.

# 1. Web UI: production build of web/ into /web/dist.
FROM --platform=$BUILDPLATFORM node:${NODE_VERSION}-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN if [ -f package-lock.json ]; then npm ci; else npm install; fi
COPY web/ ./
RUN npm run build

# 2. Server: a static binary with the UI embedded, for the target platform.
FROM --platform=$BUILDPLATFORM golang:${GO_VERSION}-alpine AS build
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY cmd ./cmd
COPY internal ./internal
COPY --from=web /web/dist/ ./internal/webui/dist/
ARG VERSION=0.1.0
ARG TARGETOS TARGETARCH
RUN test -f internal/webui/dist/index.html \
 && CGO_ENABLED=0 GOOS=$TARGETOS GOARCH=$TARGETARCH go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/codeatrophy ./cmd/codeatrophy \
 && mkdir -p /out/data

# 3. Runtime: distroless, non-root.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/codeatrophy /usr/local/bin/codeatrophy
COPY --from=build --chown=65532:65532 /out/data /data
COPY LICENSE /usr/share/doc/codeatrophy/LICENSE
ENV CODEATROPHY_ADDR=:8484 \
    CODEATROPHY_DATA_DIR=/data
VOLUME ["/data"]
EXPOSE 8484
USER 65532:65532
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD ["/usr/local/bin/codeatrophy", "healthcheck"]
ENTRYPOINT ["/usr/local/bin/codeatrophy"]
CMD ["serve"]
