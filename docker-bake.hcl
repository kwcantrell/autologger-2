# Bake definition for the split images (containerize-split-images D5/D8).
#   GIT_SHA=$(git rev-parse --short=12 HEAD) docker buildx bake -f docker-bake.hcl
#   ... docker buildx bake -f docker-bake.hcl --builder autologger-multi --push   (task 6.1; never here)
# Always pass -f docker-bake.hcl: bare `bake` auto-loads compose.yaml first and fails on its
# required variables. Platforms (amd64 + arm64) are set once, in target "_common".
variable "GIT_SHA" { default = "dev" }
variable "REGISTRY" { default = "ghcr.io/kwcantrell" }

group "default" { targets = ["web", "api"] }

target "_common" {
  context    = "."
  dockerfile = "docker/Dockerfile"
  platforms  = ["linux/amd64", "linux/arm64"]
}

target "web" {
  inherits = ["_common"]
  target   = "web"
  tags     = ["${REGISTRY}/autologger-web:${GIT_SHA}"]
}

target "api" {
  inherits = ["_common"]
  target   = "api"
  tags     = ["${REGISTRY}/autologger-api:${GIT_SHA}"]
}
