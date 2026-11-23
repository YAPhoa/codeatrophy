#!/usr/bin/env bash
# Builds the app image of this checkout for linux/amd64 and linux/arm64,
# labelled, and pushes it to ghcr.io/yaphoa/codeatrophy under each tag
# given. The staging job (workflows/ci.yml) and the release
# (workflows/release.yml) both publish through it, so that they build and
# label the image the same way.
#
#   .github/publish-image.sh <version> <tag>...
set -euo pipefail

version=$1
shift
image=ghcr.io/yaphoa/codeatrophy
description="Self-hosted library of coding challenges and technical readings"
tags=()
for tag in "$@"; do
  tags+=(-t "$image:$tag")
done
docker buildx create --use
docker buildx build --platform linux/amd64,linux/arm64 --push \
  --build-arg VERSION="$version" \
  --label org.opencontainers.image.source="$GITHUB_SERVER_URL/$GITHUB_REPOSITORY" \
  --label org.opencontainers.image.version="$version" \
  --label org.opencontainers.image.revision="$(git rev-parse HEAD)" \
  --label org.opencontainers.image.licenses=AGPL-3.0-only \
  --label org.opencontainers.image.description="$description" \
  --annotation "index:org.opencontainers.image.description=$description" \
  "${tags[@]}" .
