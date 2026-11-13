# Codeatrophy development tasks. Run `make help` for the list.
#
# Go and Node are used from the host when installed; otherwise the Go and npm
# targets run inside the official Docker images (Docker is then required).

SHELL := /bin/bash
.DEFAULT_GOAL := help

GO_VERSION   ?= 1.27.4
NODE_VERSION ?= 22
VERSION      ?= 0.1.0
BIN          := bin/codeatrophy
COMPOSE      ?= docker compose

GO_IMAGE   := golang:$(GO_VERSION)-bookworm
NODE_IMAGE := node:$(NODE_VERSION)-alpine
# PostgreSQL server of test-postgres; keep it at the major version of the
# db service in compose.yaml.
PG_IMAGE   ?= postgres:18.7
DOCKER_USER := --user $(shell id -u):$(shell id -g)
CGO         ?= 0

ifneq ($(shell command -v go 2>/dev/null),)
GO_RUN      :=
GO_PREREQ   :=
else
GO_RUN      := docker run --rm -i $(DOCKER_USER) $(GO_DOCKER_FLAGS) -v "$(CURDIR)":/src -w /src \
               -v codeatrophy-gomod:/cache/mod -v codeatrophy-gocache:/cache/build \
               -e GOMODCACHE=/cache/mod -e GOCACHE=/cache/build -e HOME=/tmp -e GOFLAGS=-buildvcs=false \
               -e GOTOOLCHAIN=local -e CGO_ENABLED=$(CGO) $(GO_IMAGE)
GO_PREREQ   := docker-go-cache
endif
GO    := $(GO_RUN) go
GOFMT := $(GO_RUN) gofmt

ifneq ($(shell command -v npm 2>/dev/null),)
NPM         := cd web && npm
else
NPM         := docker run --rm -i $(DOCKER_USER) -v "$(CURDIR)/web":/web -w /web -e HOME=/tmp \
               -e npm_config_cache=/tmp/.npm $(NODE_IMAGE) npm
endif

.PHONY: help
help: ## Show this help
	@echo "Usage: make <target>"
	@echo
	@awk 'BEGIN {FS = ":.*## "} /^[a-zA-Z0-9_-]+:.*## / {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}' $(MAKEFILE_LIST)
	@echo
	@echo "Go: $(if $(GO_PREREQ),Docker image $(GO_IMAGE),host toolchain)   npm: $(if $(findstring docker,$(NPM)),Docker image $(NODE_IMAGE),host)"

.PHONY: docker-go-cache
docker-go-cache:
	@docker volume create codeatrophy-gomod >/dev/null
	@docker volume create codeatrophy-gocache >/dev/null
	@docker run --rm -v codeatrophy-gomod:/cache/mod -v codeatrophy-gocache:/cache/build $(GO_IMAGE) \
		sh -c 'chown $(shell id -u):$(shell id -g) /cache/mod /cache/build'

## ---- Server ----------------------------------------------------------------

.PHONY: build
build: web embed build-server ## Build the UI and a server binary with it embedded (bin/codeatrophy)

.PHONY: build-server
build-server: $(GO_PREREQ) ## Build the server binary only (serves a placeholder page if the UI was never embedded)
	$(GO) build -trimpath -ldflags "-s -w -X main.version=$(VERSION)" -o $(BIN) ./cmd/codeatrophy

.PHONY: embed
embed: ## Copy web/dist into the server's embed directory
	@test -f web/dist/index.html || { echo "web/dist is missing; run 'make web' first"; exit 1; }
	find internal/webui/dist -mindepth 1 ! -name .gitkeep -delete
	cp -R web/dist/. internal/webui/dist/

.PHONY: unembed
unembed: ## Remove the embedded UI copy (back to the placeholder page)
	find internal/webui/dist -mindepth 1 ! -name .gitkeep -delete

.PHONY: run
run: build-server ## Run the server locally with data in ./data (judge engine: none unless configured)
	CODEATROPHY_DATA_DIR=./data ./$(BIN) serve

.PHONY: test
test: $(GO_PREREQ) ## Run the Go tests (on SQLite)
	$(GO) test ./...

.PHONY: test-postgres
test-postgres: $(GO_PREREQ) ## Run the Go tests on PostgreSQL, against a throwaway server in Docker
	@$(GO) mod download
	@set -u; id=$$$$-$$RANDOM; name=codeatrophy-test-pg-$$id; net=codeatrophy-test-net-$$id; \
	cleanup() { docker rm -f $$name >/dev/null 2>&1; docker network rm $$net >/dev/null 2>&1; }; \
	trap cleanup EXIT INT TERM; \
	if [ -n "$(GO_PREREQ)" ]; then internal=--internal; publish=; else internal=; publish="-p 127.0.0.1::5432"; fi; \
	docker network create $$internal $$net >/dev/null || exit 1; \
	docker run -d --name $$name --network $$net $$publish -e POSTGRES_PASSWORD=test --tmpfs /var/lib/postgresql \
		$(PG_IMAGE) -c fsync=off -c synchronous_commit=off -c full_page_writes=off -c max_connections=400 >/dev/null || exit 1; \
	for i in $$(seq 60); do docker exec $$name pg_isready -U postgres -h 127.0.0.1 >/dev/null 2>&1 && break; sleep 1; done; \
	docker exec $$name pg_isready -U postgres -h 127.0.0.1 >/dev/null || { echo "PostgreSQL did not start"; docker logs $$name; exit 1; }; \
	if [ -n "$(GO_PREREQ)" ]; then \
		url="postgres://postgres:test@$$name:5432/postgres?sslmode=disable"; \
		$(MAKE) --no-print-directory _test-postgres GO_DOCKER_FLAGS="--network $$net -e CODEATROPHY_TEST_POSTGRES_URL=$$url"; \
	else \
		url="postgres://postgres:test@$$(docker port $$name 5432/tcp | head -n1)/postgres?sslmode=disable"; \
		CODEATROPHY_TEST_POSTGRES_URL=$$url $(MAKE) --no-print-directory _test-postgres; \
	fi

.PHONY: _test-postgres
_test-postgres:
	$(GO) test -count=1 ./...

.PHONY: test-race
test-race: ## Run the Go tests with the race detector (needs cgo; uses Docker if Go is not installed)
	$(MAKE) CGO=1 _test-race

.PHONY: _test-race
_test-race: $(GO_PREREQ)
	CGO_ENABLED=1 $(GO) test -race ./...

.PHONY: vet
vet: $(GO_PREREQ) ## Run go vet
	$(GO) vet ./...

.PHONY: fmt
fmt: $(GO_PREREQ) ## Format Go code
	$(GOFMT) -w cmd internal

.PHONY: fmt-check
fmt-check: $(GO_PREREQ) ## Fail if Go code is not formatted
	@out="$$($(GOFMT) -l cmd internal)"; \
	if [ -n "$$out" ]; then echo "Not formatted:"; echo "$$out"; exit 1; fi

.PHONY: tidy
tidy: $(GO_PREREQ) ## Tidy go.mod and go.sum
	$(GO) mod tidy

## ---- Web UI ----------------------------------------------------------------

.PHONY: web-deps
web-deps: ## Install the UI's npm dependencies
	$(NPM) ci

.PHONY: web
web: web-deps ## Build the UI (web/dist)
	$(NPM) run build

.PHONY: web-dev
web-dev: ## Run the Vite dev server against a running backend
	$(NPM) run dev

.PHONY: web-dev-mock
web-dev-mock: ## Run the Vite dev server with the in-memory API mock
	$(NPM) run dev:mock

.PHONY: web-test
web-test: ## Run the UI tests
	$(NPM) test

.PHONY: web-typecheck
web-typecheck: ## Type-check the UI
	$(NPM) run typecheck

.PHONY: web-lint
web-lint: ## Lint the UI
	$(NPM) run lint

## ---- All -------------------------------------------------------------------

.PHONY: lint
lint: vet fmt-check web-lint web-typecheck ## Run all linters and type checks

.PHONY: check
check: lint test test-postgres web-test ## Lint and test everything (the Go tests on SQLite and on PostgreSQL)

## ---- Docker ----------------------------------------------------------------

.PHONY: image
image: ## Build the Docker image (UI + server)
	$(COMPOSE) build app

.PHONY: up
up: ## Start the Compose stack (cp .env.example .env first)
	$(COMPOSE) up -d --build

.PHONY: down
down: ## Stop the Compose stack (data volumes are kept)
	$(COMPOSE) down

.PHONY: logs
logs: ## Follow the app's logs
	$(COMPOSE) logs -f app

.PHONY: ps
ps: ## Show the stack's containers
	$(COMPOSE) ps

.PHONY: clean
clean: unembed ## Remove build output
	rm -rf bin web/dist
