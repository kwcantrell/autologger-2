# AutoLogger container environments (containerized-dev-env, task 7.2; design D1, D14).
#   make            list targets
# Compose flags come from docker/scripts/compose-env.sh (seam S2, shared with check-envs.sh);
# guard logic lives in docker/scripts/make-guards.sh. Dev and stage targets always act on the
# WHOLE project. No target prunes; the only `down -v` are the guarded *-reset targets.
SHELL := /bin/sh
.DEFAULT_GOAL := help

BUILDER ?= autologger-multi
G       := sh docker/scripts/make-guards.sh
CE      := . docker/scripts/compose-env.sh
DEV     := $(CE) && compose_dev .env.dev
STAGE   := $(CE) && compose_stage .env.stage
PROD    := $(CE) && compose_prod .env

.PHONY: help check dev-check dev-build dev-up dev-down dev-restart dev-logs dev-shell dev-reset \
        stage-build stage-up stage-down stage-logs stage-claude-login stage-reset \
        prod-build prod-push prod-pull prod-up prod-down prod-logs

help: ## List targets
	@echo "AutoLogger container environments. Usage: make <target>"
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/^([a-z-]+):.*## (.*)$$/  \1|\2/' | awk -F'|' '{printf "  %-20s %s\n", $$1, $$2}'

check: ## Static invariant check of dev, stage and prod compose (no env files read)
	@sh docker/scripts/check-envs.sh all

dev-check: ## Dev invariants + credentials-inode drift warning
	@sh docker/scripts/check-envs.sh dev
	@$(G) creds-inode

dev-build: ## Rebuild the dev image (needed after dependency/lockfile/config changes)
	@$(G) envfile dev
	@$(DEV) build

dev-up: ## Check, then build and start the whole dev project (app, gate, Companion)
	@$(G) envfile dev
	@$(G) creds-exists
	@sh docker/scripts/check-envs.sh dev
	@$(G) creds-inode
	@$(DEV) up -d --build
	@$(G) urls dev

dev-down: ## Stop and remove dev containers (volumes kept)
	@$(G) envfile dev
	@$(DEV) down

dev-restart: ## Restart dev: app then app-gate, companion then companion-gate
	@$(G) envfile dev
	@$(DEV) restart app
	@$(DEV) restart app-gate
	@$(DEV) restart companion
	@$(DEV) restart companion-gate

dev-logs: ## Follow dev logs
	@$(G) envfile dev
	@$(DEV) logs -f --tail=200

dev-shell: ## Open a shell in the dev app container
	@$(G) envfile dev
	@$(DEV) exec app sh

dev-reset: ## DESTROY dev volumes (needs CONFIRM=yes)
	@set -e; f=$$($(G) reset dev); $(CE); compose_dev "$$f" down -v

stage-build: ## Build the stage images (native arch, docker compose build)
	@$(G) envfile stage
	@$(STAGE) build

stage-up: ## Check, then build and start the whole stage stack
	@$(G) envfile stage
	@sh docker/scripts/check-envs.sh stage
	@$(STAGE) up -d --build
	@$(G) urls stage

stage-down: ## Stop and remove stage containers (volumes kept)
	@$(G) envfile stage
	@$(STAGE) down

stage-logs: ## Follow stage logs
	@$(G) envfile stage
	@$(STAGE) logs -f --tail=200

stage-claude-login: ## Interactive Claude login inside the stage api container (stage keeps its own login)
	@docker exec -it autologger-stage-api claude auth login

stage-reset: ## DESTROY stage volumes (needs CONFIRM=yes)
	@set -e; f=$$($(G) reset stage); $(CE); compose_stage "$$f" down -v

prod-build: ## Native-arch build of both images, tagged :local only (no SHA tag, no push)
	@p=$$($(G) native-platform) && GIT_SHA=local docker buildx bake -f docker-bake.hcl --set "*.platform=$$p" --load

prod-push: ## Clean main only: multi-arch bake + push, tagged with the 12-char HEAD SHA
	@$(G) prod-git
	@$(G) prod-builder "$(BUILDER)"
	@GIT_SHA=$$(git rev-parse --short=12 HEAD) docker buildx bake -f docker-bake.hcl --builder "$(BUILDER)" --push

prod-pull: ## Clean main only: pull the tags pinned in .env
	@$(G) prod-git
	@$(G) prod-tags
	@$(PROD) pull

prod-up: ## Clean main only: start prod with the tags pinned in .env
	@$(G) prod-git
	@$(G) prod-tags
	@$(PROD) up -d

prod-down: ## Stop and remove prod containers (volumes kept)
	@$(G) prod-tags
	@$(PROD) down

prod-logs: ## Follow prod logs
	@$(G) prod-tags
	@$(PROD) logs -f --tail=200
