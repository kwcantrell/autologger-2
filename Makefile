# AutoLogger container environments (containerized-dev-env, task 7.2; design D1, D14).
#   make            list targets
# Compose flags come from docker/scripts/compose-env.sh (seam S2, shared with check-envs.sh), always
# run through docker/scripts/compose-run.mjs, which fetches the stack's Infisical environment;
# secret-free guard logic lives in docker/scripts/make-guards.sh. Dev and stage targets always act on the
# WHOLE project. No target prunes; the only `down -v` are the guarded *-reset targets.
SHELL := /bin/sh
.DEFAULT_GOAL := help

BUILDER ?= autologger-multi
G       := sh docker/scripts/make-guards.sh
# Secrets come from Infisical through docker/scripts/compose-run.mjs (infisical-secrets D1). It is
# started under `env -i` so none of the operator's NODE_*, proxy or TLS variables reach it (H1);
# the node binary itself is resolved from the operator's PATH first (nvm installs live there).
NODE    := $(shell command -v node 2>/dev/null)
RUN     = @[ -n "$(NODE)" ] || { echo "make: node (22.12 or newer) is not on PATH" >&2; exit 1; }; \
          env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$(HOME)" TERM="$(TERM)" $(NODE) docker/scripts/compose-run.mjs
RUN_CONFIRM = @[ -n "$(NODE)" ] || { echo "make: node (22.12 or newer) is not on PATH" >&2; exit 1; }; \
          env -i PATH=/usr/local/bin:/usr/bin:/bin HOME="$(HOME)" TERM="$(TERM)" CONFIRM="$(CONFIRM)" $(NODE) docker/scripts/compose-run.mjs

.PHONY: help check dev-check dev-build dev-up dev-down dev-restart dev-logs dev-shell dev-reset dev-migrate dev-psql \
        stage-build stage-up stage-down stage-logs stage-claude-login stage-reset \
        prod-build prod-push prod-pull prod-up prod-down prod-logs prod-check

help: ## List targets
	@echo "AutoLogger container environments. Usage: make <target>"
	@grep -hE '^[a-z-]+:.*## ' $(MAKEFILE_LIST) | sed -E 's/^([a-z-]+):.*## (.*)$$/  \1|\2/' | awk -F'|' '{printf "  %-20s %s\n", $$1, $$2}'

check: ## Static invariant check of dev, stage and prod compose (no env files read)
	@sh docker/scripts/check-envs.sh all

dev-check: ## Dev invariants + credentials-inode drift warning
	@sh docker/scripts/check-envs.sh dev
	@$(G) creds-inode

dev-build: ## Rebuild the dev image (needed after dependency/lockfile/config changes)
	$(RUN) dev resolved 'compose build'

dev-up: ## Check, migrate the dev Postgres, then build and start the whole dev project (app, gate, Companion, Supabase)
	@$(G) creds-exists
	@sh docker/scripts/check-envs.sh dev
	@$(G) creds-inode
	$(RUN) dev resolved 'compose run --rm migrate' 'compose up -d --build' urls

dev-down: ## Stop and remove dev containers (volumes kept)
	$(RUN) dev 'compose down'

dev-restart: ## Restart dev: app then app-gate, companion then companion-gate
	$(RUN) dev 'compose restart app' 'compose restart app-gate' 'compose restart companion' 'compose restart companion-gate'

dev-logs: ## Follow dev logs
	$(RUN) dev 'compose logs -f --tail=200'

dev-shell: ## Open a shell in the dev app container
	$(RUN) dev 'compose exec app sh'

dev-migrate: ## Apply supabase/migrations to the dev Postgres (starts db if needed)
	$(RUN) dev resolved 'compose run --rm migrate'

dev-psql: ## psql in the dev Postgres (no history file)
	$(RUN) dev 'compose exec -e PSQL_HISTORY=/dev/null db psql -U postgres'

dev-reset: ## DESTROY dev volumes, incl. Postgres and Supabase storage (needs CONFIRM=yes)
	$(RUN_CONFIRM) dev reset 'compose down -v'

stage-build: ## Build the stage images (native arch, docker compose build)
	$(RUN) stage resolved 'compose build'

stage-up: ## Check, migrate the stage Postgres, then build and start the whole stage stack (incl. Supabase)
	@sh docker/scripts/check-envs.sh stage
	$(RUN) stage resolved 'compose run --rm migrate' 'compose up -d --build' urls

stage-down: ## Stop and remove stage containers (volumes kept)
	$(RUN) stage 'compose down'

stage-logs: ## Follow stage logs
	$(RUN) stage 'compose logs -f --tail=200'

stage-claude-login: ## Interactive Claude login inside the stage api container (stage keeps its own login)
	@docker exec -it autologger-stage-api claude auth login

stage-reset: ## DESTROY stage volumes, incl. Postgres and Supabase storage (needs CONFIRM=yes)
	$(RUN_CONFIRM) stage reset 'compose down -v'

prod-build: ## Native-arch build of both images, tagged :local only (no SHA tag, no push)
	@p=$$($(G) native-platform) && GIT_SHA=local docker buildx bake -f docker-bake.hcl --set "*.platform=$$p" --load

prod-push: ## Clean main only: multi-arch bake + push, tagged with the 12-char HEAD SHA
	@$(G) prod-git
	@$(G) prod-builder "$(BUILDER)"
	@GIT_SHA=$$(git rev-parse --short=12 HEAD) docker buildx bake -f docker-bake.hcl --builder "$(BUILDER)" --push

prod-check: ## Dry run (any branch): Infisical prod login + guards + compose config; starts nothing
	$(RUN) prod resolved prod-tags 'compose config --quiet'

prod-pull: ## Clean main only: pull the tags pinned in Infisical prod
	@$(G) prod-git
	$(RUN) prod prod-tags 'compose pull'

prod-up: ## Clean main only: start prod with the tags pinned in Infisical prod
	@$(G) prod-git
	$(RUN) prod prod-tags resolved 'compose up -d'

prod-down: ## Stop and remove prod containers (volumes kept)
	$(RUN) prod prod-tags 'compose down'

prod-logs: ## Follow prod logs
	$(RUN) prod prod-tags 'compose logs -f --tail=200'
