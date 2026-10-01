#!/bin/sh
# docker/scripts/check-envs.sh -- static invariant check for the dev / stage / prod compose
# projects (containerized-dev-env, design D11; infisical-secrets D5; spec "Static invariant
# check", 16 invariants; supabase-db D7).
#
#   docker/scripts/check-envs.sh [dev|stage|prod|all]      (default: all)
#
# Needs only docker (compose v2 plugin), jq and a POSIX sh (verified with dash). Every project is
# resolved with `docker compose config --no-env-resolution` (never inlines env_file contents)
# through docker/scripts/compose-env.sh, the same helper the Makefile uses (seam S2), with
# placeholder --env-file files written to a temp dir. It NEVER contacts Infisical and NEVER reads,
# opens or prints .env, .env.dev, .env.stage or any .env.infisical.* file. Failures are reported as "FAIL [invariant N] ..." on stderr; the exit
# status is non-zero if any invariant failed.
#
# Run from anywhere; the script cd's to the repo root.

# jq filters are deliberately single-quoted (their $vars are jq variables, not shell).
# shellcheck disable=SC2016
set -eu

ROOT=$(cd "$(dirname "$0")/../.." && pwd -P)
cd "$ROOT"
# shellcheck source=docker/scripts/compose-env.sh
. docker/scripts/compose-env.sh

# The caller's shell must not influence the result: every interpolated variable falls back to
# its compose default, and the placeholder env files below supply any non-default value.
unset DEV_PORT DEV_COMPANION_PORT STAGE_PORT ROUTER_PORT ROUTER_FRONT_GW ROUTER_BACK_GW \
  WEB_TAG API_TAG PUBLIC_BASE_URL E2E_ENV_FILE E2E_IP_ALLOWLIST HOST REQUIRE_LOGIN TRUST_PROXY \
  IP_ALLOWLIST DATA_DIR PORT 2>/dev/null || true
# supabase-db D4, supabase-services D4: one sentinel per Supabase secret, so invariant 16 can find
# each value anywhere; SB_SCOPE is the services each may appear in (same table as compose-run.mjs).
SB_SECRETS="POSTGRES_PASSWORD SUPABASE_ROLES_PASSWORD JWT_SECRET ANON_KEY SERVICE_ROLE_KEY SECRET_KEY_BASE REALTIME_DB_ENC_KEY"
for k in $SB_SECRETS; do eval "$k=sbsentinel_${k}_z; export $k"; done
SUPABASE_PORT=18790; export SUPABASE_PORT
SB_SCOPE='{"POSTGRES_PASSWORD":["db","migrate","realtime"],"SUPABASE_ROLES_PASSWORD":["db","auth","rest","storage"],"JWT_SECRET":["auth","rest","realtime","storage"],"ANON_KEY":["supabase-gw","realtime","storage"],"SERVICE_ROLE_KEY":["supabase-gw","storage"],"SECRET_KEY_BASE":["realtime"],"REALTIME_DB_ENC_KEY":["realtime"]}'

# The shared allowlist (infisical-secrets D2): every key a container may receive, one null
# passthrough per line. Those keys must not leak the caller's values into the resolved JSON, and
# the D4 sentinel gets a fixed placeholder so a hand-typed-compose refusal never trips the check.
ALLOWLIST=docker/secrets-env.yaml
allowlist_keys() { grep -E '^      [A-Z][A-Z0-9_]*:[[:space:]]*$' "$ALLOWLIST" | sed -E 's/^ *([A-Z0-9_]+):.*/\1/'; }
if [ -f "$ALLOWLIST" ]; then
  for k in $(allowlist_keys); do unset "$k"; done
fi
AUTOLOGGER_STACK=check; export AUTOLOGGER_STACK

WHAT=${1:-all}
case "$WHAT" in
  dev|stage|prod|all) ;;
  *) echo "usage: $0 [dev|stage|prod|all]" >&2; exit 2 ;;
esac

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
trap 'exit 130' INT TERM HUP

FAILS=0
fail() { # invariant-number message
  FAILS=$((FAILS + 1))
  echo "FAIL [invariant $1] $2" >&2
}

# Lexical path normalizer (jq), prepended to every filter. Compose does NOT clean an absolute
# bind source (it emits "/home/", "//home", "/./home", "//" verbatim, though it does absolutize
# and clean relative ones), yet Docker binds the same directory, so every comparison on a bind
# source (invariants 4 and 8) runs on the normalized form: split on "/", drop "" and ".",
# resolve ".." by popping (never above "/"), rejoin with a leading "/". A relative source is
# anchored at $root first. $home and $root are rebound to their normalized forms. Lexical only
# (no symlink resolution). envmap: a raw (--no-interpolate) environment is an array once
# `extends`/an overlay is involved (bare "KEY" = null passthrough, "KEY=v" = literal); map it back.
JQ_NORM='def envmap: if type=="array" then map(if test("=") then {key:(split("=")[0]),value:sub("^[^=]*=";"")} else {key:.,value:null} end)|from_entries else (.//{}) end;
  def norm: (if startswith("/") then . else $root+"/"+. end)
  | split("/") | reduce .[] as $p ([]; if $p=="" or $p=="." then . elif $p==".." then .[:-1] else .+[$p] end)
  | "/"+join("/");
  ($root|norm) as $root | ($home|norm) as $home | '

# jq_ok INV MESSAGE JSONFILE FILTER [jq args...]: FILTER must evaluate to true.
jq_ok() {
  _inv=$1; _msg=$2; _file=$3; _flt=$4
  shift 4
  if ! jq -e --arg home "$HOME" --arg root "$ROOT" "$@" "$JQ_NORM $_flt" "$_file" >/dev/null 2>"$TMP/jq.err"; then
    fail "$_inv" "$_msg"
    if [ -s "$TMP/jq.err" ]; then sed 's/^/    jq: /' "$TMP/jq.err" >&2; fi
  fi
  return 0
}

# Prod with the test-only e2e overlay layered on (still project "autologger").
compose_prod_e2e() {
  _e=$1; shift
  compose_prod "$_e" -f "$AL_E2E_OVERLAY" "$@"
}

# resolve OUT LABEL FN ENVFILE [config flags...]: resolve one project to JSON, no env resolution.
resolve() {
  _out=$1; _label=$2; _fn=$3; _envf=$4
  shift 4
  if ! "$_fn" "$_envf" --profile '*' config --no-env-resolution --format json "$@" >"$_out" 2>"$TMP/resolve.err"; then
    fail 0 "could not resolve $_label with compose config:"
    sed 's/^/    /' "$TMP/resolve.err" >&2
    return 1
  fi
}

# ---------------------------------------------------------------- placeholder env files ------
# Empty files force every default; the *custom* files use non-default, distinct numeric ports so
# the published-port / GATE_PORT / PUBLIC_BASE_URL coupling is proven, not coincidental. The
# HOST/REQUIRE_LOGIN/... lines would win over a mutated `${HOST:-...}` style pin.
: >"$TMP/empty.env"
cat >"$TMP/dev-custom.env" <<'EOF'
DEV_PORT=18787
DEV_COMPANION_PORT=18000
HOST=0.0.0.0
REQUIRE_LOGIN=1
TRUST_PROXY=1
IP_ALLOWLIST=0.0.0.0/0
DATA_DIR=/x
PORT=1
EOF
printf 'STAGE_PORT=18788\n' >"$TMP/stage-custom.env"
printf 'WEB_TAG=abcdef123456\nAPI_TAG=abcdef123456\nPUBLIC_BASE_URL=https://example.invalid\n' >"$TMP/prod.env"
E2E_ENV_FILE="$TMP/e2e-throwaway.env"; export E2E_ENV_FILE

# ---------------------------------------------------------------- shared assertions -----------
# Invariant 1 (any project): every published port is on the literal 127.0.0.1.
check_loopback_ports() { # json label
  jq_ok 1 "$2: a published port is not bound to 127.0.0.1" "$1" \
    '[.services[]|(.ports//[])[]|select(.host_ip!="127.0.0.1")]|length==0'
}

# Invariant 2 (dev, stage): no published port is 8080 (prod's; the collision is silent while
# prod is down), and every published value is a single number 1-65535.
check_no_8080_numeric() { # json label
  jq_ok 2 "$2: a published port is 8080" "$1" \
    '[.services[]|(.ports//[])[]|select((.published|tostring)=="8080")]|length==0'
  jq_ok 2 "$2: a published port is not a single number 1-65535" "$1" \
    '[.services[]|(.ports//[])[]|.published|tostring]|all(test("^[1-9][0-9]{0,4}$") and (tonumber<=65535))'
}

# Invariant 7 (stage, prod): the api posture pins survive.
check_posture_prodlike() { # json label
  jq_ok 7 "$2: api REQUIRE_LOGIN is not \"1\"" "$1" '.services.api.environment.REQUIRE_LOGIN=="1"'
  jq_ok 7 "$2: api TRUST_PROXY is not \"1\"" "$1" '.services.api.environment.TRUST_PROXY=="1"'
}

# Invariant 6 (dev, stage): no service uses the host network namespace or runs privileged.
check_no_host_priv() { # json label
  jq_ok 6 "$2: a service uses network_mode host or privileged: true" "$1" \
    '[.services[]|select(.network_mode=="host" or .privileged==true)]|length==0'
}

# Invariant 9: a file resolves (no -p) to its declared project name.
check_name() { # json label expected
  jq_ok 9 "$2: resolves without -p to a project name other than \"$3\"" "$1" '.name==$n' --arg n "$3"
}

# Invariant 14 (dev, stage, prod; the prod + e2e overlay is exempt): no service has an env_file.
# Secrets reach compose from Infisical and containers through the shared allowlist.
check_no_env_file() { # json label
  jq_ok 14 "$2: a service has an env_file (secrets come from Infisical through $ALLOWLIST)" "$1" \
    '[.services|to_entries[]|select((.value.env_file//[])|length>0)|.key]|length==0'
}

# Invariant 15: the allowlist file's keys equal the service's null passthroughs, less the keys the
# service pins with a literal. RAW is a --no-interpolate resolve (both shapes, see envmap).
check_allowlist() { # rawjson label service
  if [ ! -f "$ALLOWLIST" ]; then fail 15 "$2: $ALLOWLIST is missing"; return 0; fi
  allowlist_keys | jq -R . | jq -s . >"$TMP/allow.json"
  jq_ok 15 "$2: $3's null-passthrough names differ from the keys in $ALLOWLIST (less its literal pins)" "$1" \
    '$allowf[0] as $allow
     | (.services[$svc].environment|envmap) as $e
     | ([$e|to_entries[]|select(.value==null)|.key]) as $p
     | ([$e|to_entries[]|select(.value!=null)|.key]) as $l
     | ($p - $allow == []) and ($allow - $p - $l == [])' \
    --arg svc "$3" --slurpfile allowf "$TMP/allow.json"
}

# Invariant 6 (dev, stage): a container_name that other tooling hard-codes (make-guards.sh
# creds_inode, the Makefile's stage-claude-login) must match the compose file exactly.
check_container_name() { # json label service name
  jq_ok 6 "$2: service $3 container_name is not exactly $4 (make-guards.sh / the Makefile hard-code it)" "$1" \
    '.services[$svc].container_name==$n' --arg svc "$3" --arg n "$4"
}

# Invariant 10 (any project): a router gateway variable is only ever a strict single dotted
# IPv4 (no empty, CIDR, keyword, list). Exact names: ROUTER_PORT is not one of them.
IPV4='^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])\\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9]?[0-9])$'
check_gw_values() { # json label
  jq_ok 10 "$2: ROUTER_FRONT_GW/ROUTER_BACK_GW is set to something other than a single non-empty dotted IPv4 (or 0.0.0.0)" "$1" \
    "[.services[]|(.environment//{})|to_entries[]|select(.key|test(\"^ROUTER_(FRONT|BACK)_GW\$\"))|.value]|all(type==\"string\" and test(\"$IPV4\") and .!=\"0.0.0.0\")"
}

# Invariant 16 (dev, stage, prod; supabase-db D1-D4, supabase-services D1-D4): Postgres and the
# Supabase services are reachable only through the gateway, and each secret stays in its services.
# The value check covers every string in a service (env, command, labels, healthcheck, build args).
check_supabase() { # json label db-subnet supabase-subnet edge-subnet
  jq_ok 16 "$2: db or migrate is missing, publishes a port, or joins a network other than db" "$1" \
    '(.services.db and .services.migrate)
     and ([.services.db,.services.migrate]|all(((.ports//[])|length==0) and ((.networks//{})|keys==["db"])))'
  jq_ok 16 "$2: auth, rest, realtime or storage is missing, publishes a port, or joins networks other than db and supabase" "$1" \
    '[.services.auth,.services.rest,.services.realtime,.services.storage]
     |all(. != null and ((.ports//[])|length==0) and ((.networks//{})|keys==["db","supabase"]))'
  jq_ok 16 "$2: supabase-gw does not publish exactly one 127.0.0.1 port to 8000, or joins networks other than edge and supabase" "$1" \
    '.services["supabase-gw"]|((.networks//{})|keys==["edge","supabase"])
     and ((.ports//[])|length==1 and .[0].host_ip=="127.0.0.1" and .[0].target==8000)'
  jq_ok 16 "$2: a service outside db, migrate, auth, rest, realtime and storage joins the db network; or outside supabase-gw and those four joins supabase; or one other than supabase-gw joins edge" "$1" \
    '([.services|to_entries[]|select((.value.networks//{})|has("db"))|.key] - ["db","migrate","auth","rest","realtime","storage"] == [])
     and ([.services|to_entries[]|select((.value.networks//{})|has("supabase"))|.key] - ["supabase-gw","auth","rest","realtime","storage"] == [])
     and ([.services|to_entries[]|select((.value.networks//{})|has("edge"))|.key] == ["supabase-gw"])'
  for n in db supabase; do
    [ "$n" = db ] && sn=$3 || sn=$4
    jq_ok 16 "$2: the $n network is not internal, not host-isolated (gateway_mode_ipv4/ipv6 isolated), or not on $sn" "$1" \
      '.networks[$n]|.internal==true
       and .driver_opts["com.docker.network.bridge.gateway_mode_ipv4"]=="isolated"
       and .driver_opts["com.docker.network.bridge.gateway_mode_ipv6"]=="isolated"
       and .ipam.config==[{"subnet":$sn}]' --arg n "$n" --arg sn "$sn"
  done
  jq_ok 16 "$2: the edge network is not on $5" "$1" '.networks.edge.ipam.config==[{"subnet":$sn}]' --arg sn "$5"
  jq_ok 16 "$2: a Supabase image (db, migrate, auth, rest, realtime, storage, supabase-gw) is not pinned by @sha256: digest" "$1" \
    '[.services|(.db,.migrate,.auth,.rest,.realtime,.storage,.["supabase-gw"])|.image]|all(type=="string" and test("@sha256:[0-9a-f]{64}$"))'
  for k in $SB_SECRETS; do
    jq_ok 16 "$2: the $k value appears in a service outside its allowed set" "$1" \
      '($scope[$k]) as $ok | [.services|to_entries[]|select(.key as $n|$ok|index($n)|not)|select([.value|..|strings|contains($v)]|any)]|length==0' \
      --arg k "$k" --arg v "sbsentinel_${k}_z" --argjson scope "$SB_SCOPE"
  done
}

# ---------------------------------------------------------------- DEV ------------------------
check_dev() {
  echo "== dev (autologger-dev)"
  resolve "$TMP/dev.json" "dev (defaults)" compose_dev "$TMP/empty.env" || return 0
  resolve "$TMP/dev-c.json" "dev (custom ports)" compose_dev "$TMP/dev-custom.env" || return 0
  resolve "$TMP/dev-raw.json" "dev (raw, --no-interpolate)" compose_dev "$TMP/dev-custom.env" --no-interpolate || return 0
  D=$TMP/dev.json; C=$TMP/dev-c.json; R=$TMP/dev-raw.json

  check_name "$C" dev autologger-dev                                   # 9
  for f in "$D" "$C"; do
    check_loopback_ports "$f" dev                                      # 1
    check_no_8080_numeric "$f" dev                                     # 2
  done
  check_gw_values "$C" dev                                             # 10 (dev sets none)

  # 3: ports appear only on app/companion, one each, targeting the gate ports 8787/8001 (never
  # the app's 8786 or Companion's ungated 8000); the raw mapping pins the env var AND default.
  for f in "$D" "$C"; do
    jq_ok 3 "dev: published ports are not exactly app->8787, companion->8001 and supabase-gw->8000 (a published port is not a gate port)" "$f" \
      '([.services|to_entries[]|select((.value.ports//[])|length>0)|.key]|sort)==["app","companion","supabase-gw"]
       and (.services.app.ports|length==1 and .[0].target==8787)
       and (.services.companion.ports|length==1 and .[0].target==8001)'
  done
  jq_ok 3 "dev: raw published-port mappings are not exactly 127.0.0.1:\${DEV_PORT:-8787}:8787 / 127.0.0.1:\${DEV_COMPANION_PORT:-8000}:8001" "$R" \
    '(.services.app.ports==["127.0.0.1:${DEV_PORT:-8787}:8787"])
     and (.services.companion.ports==["127.0.0.1:${DEV_COMPANION_PORT:-8000}:8001"])
     and (.services["supabase-gw"].ports==["127.0.0.1:${SUPABASE_PORT}:8000"])'
  jq_ok 3 "dev: the gates do not share their gated service's network namespace, or a gate/app joins a network other than dev" "$D" \
    '.services["app-gate"].network_mode=="service:app" and .services["companion-gate"].network_mode=="service:companion"
     and ((.services.app.networks//{})|keys)==["dev"] and ((.services.companion.networks//{})|keys)==["dev"]'
  # Port variables: numeric 1-65535 when they resolve, distinct, defaults distinct.
  jq_ok 2 "dev: DEV_PORT / DEV_COMPANION_PORT do not resolve to numbers 1-65535, or are equal (custom or default)" "$C" \
    '[.services.app.ports[0].published,.services.companion.ports[0].published,.services["supabase-gw"].ports[0].published]|all(test("^[1-9][0-9]{0,4}$") and (tonumber<=65535)) and (unique|length==3)'
  jq_ok 2 "dev: default DEV_PORT equals default DEV_COMPANION_PORT" "$D" \
    '.services.app.ports[0].published!=.services.companion.ports[0].published'
  # Gate coupling (seam S1): GATE_PORT is the browser-facing published port; LISTEN_PORT the
  # container-side target; UPSTREAM_PORT the port the gated process binds.
  for f in "$D" "$C"; do
    jq_ok 3 "dev: a gate's GATE_PORT does not equal its service's published host port" "$f" \
      '.services["app-gate"].environment.GATE_PORT==.services.app.ports[0].published
       and .services["companion-gate"].environment.GATE_PORT==.services.companion.ports[0].published'
  done
  jq_ok 3 "dev: gate LISTEN_PORT/UPSTREAM_PORT are not the literals app-gate 8787/8786, companion-gate 8001/8000" "$R" \
    '(.services["app-gate"].environment|.LISTEN_PORT=="8787" and .UPSTREAM_PORT=="8786")
     and (.services["companion-gate"].environment|.LISTEN_PORT=="8001" and .UPSTREAM_PORT=="8000")
     and (.services.app.environment|envmap|.PORT=="8786")'
  jq_ok 6 "dev: a gate GATE_PORT is not exactly \${DEV_PORT:-8787} / \${DEV_COMPANION_PORT:-8000}, or another gate env value is not a literal" "$R" \
    '(.services["app-gate"].environment|.GATE_PORT=="${DEV_PORT:-8787}" and ([to_entries[]|select(.key!="GATE_PORT")|.value|contains("$")]|any|not))
     and (.services["companion-gate"].environment|.GATE_PORT=="${DEV_COMPANION_PORT:-8000}" and ([to_entries[]|select(.key!="GATE_PORT")|.value|contains("$")]|any|not))'
  jq_ok 6 "dev: companion command is not exactly [\"--admin-address\",\"127.0.0.1\"]" "$D" \
    '.services.companion.command==["--admin-address","127.0.0.1"]'
  # 6: the dev service set is exactly the four expected services (no extra/privileged sidecar).
  jq_ok 6 "dev: the service set is not exactly app, app-gate, auth, companion, companion-gate, db, migrate, realtime, rest, storage, supabase-gw" "$D" \
    '(.services|keys|sort)==["app","app-gate","auth","companion","companion-gate","db","migrate","realtime","rest","storage","supabase-gw"]'
  check_supabase "$D" dev 172.28.31.0/24 172.28.32.0/24 172.28.33.0/24      # 16
  check_no_host_priv "$D" dev
  check_no_env_file "$D" dev                                           # 14
  check_allowlist "$R" dev app                                         # 15
  check_container_name "$D" dev app autologger-dev-app                 # 6 (container name pinned)
  # 3 (seam S1): the app gate's extra allowed Host is "app:" + its LISTEN_PORT (resolved, both
  # default and custom-port configs), so the Companion -> app container-network path is admitted.
  for f in "$D" "$C"; do
    jq_ok 3 "dev: app-gate GATE_EXTRA_HOST is not exactly \"app:\" + its LISTEN_PORT" "$f" \
      '.services["app-gate"].environment|.GATE_EXTRA_HOST==("app:"+.LISTEN_PORT)'
  done

  # 6: dev posture pins are literals in the raw file (only PUBLIC_BASE_URL and the D4
  # AUTOLOGGER_STACK sentinel may hold a variable),
  # and the resolved values match (the custom env file tries to flip every one of them).
  jq_ok 6 "dev: a posture pin (HOST/REQUIRE_LOGIN/TRUST_PROXY/IP_ALLOWLIST/DATA_DIR/PORT) is not a literal in the raw file, or another app env value contains a variable" "$R" \
    '.services.app.environment|envmap
     | .HOST=="127.0.0.1" and .REQUIRE_LOGIN=="0" and .TRUST_PROXY=="0" and .IP_ALLOWLIST=="" and .DATA_DIR=="/data" and .PORT=="8786"
       and .PUBLIC_BASE_URL=="http://localhost:${DEV_PORT:-8787}"
       and (.AUTOLOGGER_STACK//""|startswith("${AUTOLOGGER_STACK:?"))
       and ([to_entries[]|select(.key!="PUBLIC_BASE_URL" and .key!="AUTOLOGGER_STACK")|.value|tostring|contains("$")]|any|not)'
  for f in "$D" "$C"; do
    jq_ok 6 "dev: a resolved posture pin differs from HOST=127.0.0.1 REQUIRE_LOGIN=0 TRUST_PROXY=0 IP_ALLOWLIST= DATA_DIR=/data PORT=8786" "$f" \
      '.services.app.environment
       | .HOST=="127.0.0.1" and .REQUIRE_LOGIN=="0" and .TRUST_PROXY=="0" and .IP_ALLOWLIST=="" and .DATA_DIR=="/data" and .PORT=="8786"'
  done
  jq_ok 6 "dev: resolved PUBLIC_BASE_URL is not http://localhost:<published DEV_PORT>" "$C" \
    '.services.app.environment.PUBLIC_BASE_URL==("http://localhost:"+.services.app.ports[0].published)'

  # 4: bind mounts. Read-only sources must sit under an allowed source subtree (or be the gate
  # Caddyfile), never repo root / a data segment / a .env file; the ONLY rw bind is the Claude
  # credentials file. DATA_DIR and the runtime home are named volumes.
  BINDS='[.services|to_entries[]|.key as $s|(.value.volumes//[])[]|select(.type=="bind")|{s:$s,src:(.source|norm),tgt:.target,ro:(.read_only//false),cp:(.bind.create_host_path)}]'
  jq_ok 4 "dev: the read-write bind mounts are not exactly app's \${HOME}/.claude/.credentials.json -> /home/node/.claude/.credentials.json with create_host_path false" "$D" \
    "$BINDS | map(select(.ro|not)) == [{s:\"app\",src:(\$home+\"/.claude/.credentials.json\"),tgt:\"/home/node/.claude/.credentials.json\",ro:false,cp:false}]"
  ALLOW='^(server/(src|scripts)|web/(src|public)|packages/[a-z0-9-]+/(src|migrations)|docker/dev-gate\\.Caddyfile|docker/supabase/migrate\\.sh|supabase/migrations|docker/supabase-gw\\.Caddyfile|docker/supabase/init/[a-z]+\\.sql)(/.*)?$'
  jq_ok 4 "dev: a read-only bind source is not under server/src, server/scripts, web/src, web/public, packages/*/src, packages/catalog/migrations, docker/dev-gate.Caddyfile, docker/supabase/migrate.sh, supabase/migrations, docker/supabase-gw.Caddyfile or docker/supabase/init/*.sql (or names repo root, a data segment, .. or a .env file)" "$D" \
    "$BINDS | map(select(.ro)) | all(.src | startswith(\$root+\"/\") and (ltrimstr(\$root+\"/\") | test(\"$ALLOW\") and (test(\"(^|/)(data|\\\\.\\\\.|\\\\.)(/|\$)\")|not) and (test(\"(^|/)\\\\.env[^/]*\$\")|not)))"
  jq_ok 4 "dev: the gate Caddyfile bind is not read-only" "$D" \
    "$BINDS | map(select(.src|endswith(\"/docker/dev-gate.Caddyfile\"))) | length==2 and all(.ro)"
  jq_ok 4 "dev: docker/supabase/migrate.sh or supabase/migrations is mounted into a service other than migrate" "$D" \
    "$BINDS | map(select(.src==(\$root+\"/docker/supabase/migrate.sh\") or (.src|startswith(\$root+\"/supabase/migrations\")))) | all(.s==\"migrate\")"
  jq_ok 4 "dev: docker/supabase-gw.Caddyfile is mounted into a service other than supabase-gw, or docker/supabase/init into one other than db" "$D" \
    "($BINDS | map(select(.src==(\$root+\"/docker/supabase-gw.Caddyfile\"))) | all(.s==\"supabase-gw\")) and ($BINDS | map(select(.src|startswith(\$root+\"/docker/supabase/init/\"))) | all(.s==\"db\"))"
  jq -r --arg root "$ROOT" --arg home "$HOME" "$JQ_NORM $BINDS | map(select(.ro)) | .[].src" "$D" >"$TMP/ro-sources.txt"
  while IFS= read -r p; do
    [ -e "$p" ] || fail 4 "dev: read-only source mount names a path that does not exist: ${p#"$ROOT"/}"
  done <"$TMP/ro-sources.txt"
  jq_ok 4 "dev: DATA_DIR (/data) is not the dev-data named volume, or /home/node is not the dev-home named volume" "$D" \
    '.services.app.volumes as $v
     | ($v|map(select(.target=="/data"))|length==1 and .[0].type=="volume" and .[0].source=="dev-data")
       and ($v|map(select(.target=="/home/node"))|length==1 and .[0].type=="volume" and .[0].source=="dev-home")'

  # 5: every packages/* directory has its src mounted (and, for catalog, its migrations).
  for d in packages/*/; do
    n=$(basename "$d")
    jq_ok 5 "dev: packages/$n/src is not mounted read-only at /app/packages/$n/src" "$D" \
      '.services.app.volumes|map(select(.type=="bind" and .source==($root+"/packages/"+$n+"/src") and .target==("/app/packages/"+$n+"/src") and (.read_only==true)))|length==1' --arg n "$n"
  done
  jq_ok 5 "dev: packages/catalog/migrations is not mounted read-only" "$D" \
    '.services.app.volumes|map(select(.type=="bind" and .source==($root+"/packages/catalog/migrations") and .target=="/app/packages/catalog/migrations" and (.read_only==true)))|length==1'

  hostile_ports dev compose_dev DEV_PORT
  hostile_ports dev compose_dev DEV_COMPANION_PORT
}

# Hostile port values: compose itself must reject them, or (if it accepts) every place the value
# lands (published port, GATE_PORT, PUBLIC_BASE_URL) must still be a bare number. Proves a
# value like `1"] || true || ["x` cannot reach the gate's Caddy CEL expression.
hostile_ports() { # label fn varname
  _hl=$1; _hf=$2; _hv=$3
  for hv in '1"] || true || ["x' '8787"' '1 } evil {' '${HOME}' '8787;id'; do
    printf '%s=%s\n' "$_hv" "$hv" >"$TMP/hostile.env"
    if "$_hf" "$TMP/hostile.env" config --no-env-resolution --format json >"$TMP/hostile.json" 2>/dev/null; then
      if [ "$_hl" = dev ]; then
        jq_ok 2 "dev: hostile $_hv value [$hv] was accepted and reached a non-numeric port / GATE_PORT" "$TMP/hostile.json" \
          '([.services[]|(.ports//[])[]|.published|tostring]+[.services["app-gate"].environment.GATE_PORT,.services["companion-gate"].environment.GATE_PORT])|all(test("^[0-9]+$"))' || true
      else
        jq_ok 2 "stage: hostile $_hv value [$hv] was accepted and reached a non-numeric port / PUBLIC_BASE_URL" "$TMP/hostile.json" \
          '([.services[]|(.ports//[])[]|.published|tostring]|all(test("^[0-9]+$"))) and (.services.api.environment.PUBLIC_BASE_URL|test("^http://localhost:[0-9]+$"))' || true
      fi
    fi
  done
}

# ---------------------------------------------------------------- STAGE ----------------------
check_stage() {
  echo "== stage (autologger-stage)"
  resolve "$TMP/stage.json" "stage (defaults)" compose_stage "$TMP/empty.env" || return 0
  resolve "$TMP/stage-c.json" "stage (custom port)" compose_stage "$TMP/stage-custom.env" || return 0
  resolve "$TMP/stage-raw.json" "stage (raw, --no-interpolate)" compose_stage "$TMP/stage-custom.env" --no-interpolate || return 0
  resolve "$TMP/prod-d.json" "prod (defaults, for the STAGE_PORT != ROUTER_PORT compare)" compose_prod "$TMP/prod.env" || return 0
  S=$TMP/stage.json; SC=$TMP/stage-c.json; SR=$TMP/stage-raw.json

  check_name "$S" stage autologger-stage                               # 9
  check_no_host_priv "$S" stage                                        # 6
  check_no_env_file "$S" stage                                         # 14
  check_container_name "$S" stage api autologger-stage-api            # 6 (container name pinned)
  check_supabase "$S" stage 172.28.22.0/24 172.28.23.0/24 172.28.24.0/24    # 16
  for f in "$S" "$SC"; do
    check_loopback_ports "$f" stage                                    # 1
    check_no_8080_numeric "$f" stage                                   # 2
    check_posture_prodlike "$f" stage                                  # 7
    check_gw_values "$f" stage                                         # 10
    jq_ok 3 "stage: published ports are not exactly the router's and supabase-gw's (web/api must publish none)" "$f" \
      '([.services|to_entries[]|select((.value.ports//[])|length>0)|.key]|sort)==["router","supabase-gw"] and (.services.router.ports|length==1 and .[0].target==8080)'
  done
  jq_ok 2 "stage: raw router mapping is not exactly 127.0.0.1:\${STAGE_PORT:-8788}:8080" "$SR" \
    '.services.router.ports==["127.0.0.1:${STAGE_PORT:-8788}:8080"]'
  spub=$(jq -r '.services.router.ports[0].published' "$S")
  ppub=$(jq -r '.services.router.ports[0].published' "$TMP/prod-d.json")
  if [ "$spub" = "$ppub" ] || [ "$spub" = 8080 ]; then
    fail 2 "stage: default STAGE_PORT ($spub) equals prod's default ROUTER_PORT ($ppub) or 8080"
  fi
  jq_ok 2 "stage: STAGE_PORT does not drive both the published port and PUBLIC_BASE_URL" "$SC" \
    '.services.router.ports[0].published=="18788" and .services.api.environment.PUBLIC_BASE_URL=="http://localhost:18788"'

  # 8: stage mounts no host path that is, contains or sits under the home directory (outside the
  # repo), and none from a .claude path. Evaluated per bind source: "/" and any ancestor of
  # $HOME (a bind of /home or / exposes ~/.claude), $HOME itself, anything below $HOME that is
  # not under the repo root (the repo's own docker/Caddyfile is the one bind, and the repo root
  # may itself be under $HOME).
  jq_ok 8 "stage: a bind mount sources / , the home directory or one of its ancestors, a host path under the home directory (outside the repo), or a .claude path" "$SC" \
    '[.services[]|(.volumes//[])[]|select(.type=="bind")|.source|norm]
     | all(. as $s
           | ($s=="/" or $s==$home or ($home|startswith($s+"/"))
              or ($s|startswith($home+"/")) and ($s|startswith($root+"/")|not)
              or ($s|contains("/.claude")))|not)'
  jq_ok 8 "stage: /home/node is not a named volume (stage must keep its own login, not the host ~/.claude)" "$SC" \
    '.services.api.volumes|map(select(.target=="/home/node"))|length==1 and .[0].type=="volume"'

  # 10: the stage gateway values are set, and EQUAL the stage ipam gateways of front/back.
  jq_ok 10 "stage: router ROUTER_FRONT_GW/ROUTER_BACK_GW are missing, or do not equal the stage front/back ipam gateways" "$S" \
    '.services.router.environment as $e
     | ($e.ROUTER_FRONT_GW|type)=="string" and ($e.ROUTER_BACK_GW|type)=="string"
       and $e.ROUTER_FRONT_GW==(.networks.front.ipam.config|if length==1 then .[0].gateway else null end)
       and $e.ROUTER_BACK_GW==(.networks.back.ipam.config|if length==1 then .[0].gateway else null end)
       and ($e.ROUTER_FRONT_GW!=$e.ROUTER_BACK_GW)'

  hostile_ports stage compose_stage STAGE_PORT
}

# ---------------------------------------------------------------- PROD -----------------------
check_prod() {
  echo "== prod (autologger)"
  resolve "$TMP/prod.json" "prod" compose_prod "$TMP/prod.env" || return 0
  resolve "$TMP/prod-e2e.json" "prod + e2e overlay" compose_prod_e2e "$TMP/prod.env" || return 0
  resolve "$TMP/prod-raw.json" "prod (raw, --no-interpolate)" compose_prod "$TMP/prod.env" --no-interpolate || return 0
  check_allowlist "$TMP/prod-raw.json" prod api                        # 15
  check_supabase "$TMP/prod.json" prod 172.28.12.0/24 172.28.13.0/24 172.28.14.0/24 # 16
  for pair in "$TMP/prod.json:prod" "$TMP/prod-e2e.json:prod+e2e"; do
    f=${pair%%:*}; l=${pair#*:}
    check_name "$f" "$l" autologger                                    # 9
    check_loopback_ports "$f" "$l"                                     # 1
    check_posture_prodlike "$f" "$l"                                   # 7
    check_gw_values "$f" "$l"                                          # 10
    # The e2e overlay keeps a throwaway env_file (out of scope, ADR 0021), so only plain prod.
    if [ "$l" = prod ]; then check_no_env_file "$f" "$l"; fi           # 14
    jq_ok 10 "$l: compose.yaml must never set ROUTER_FRONT_GW/ROUTER_BACK_GW: the resolved router environment is not empty" "$f" \
      '.services.router.environment==null'
  done
  if grep -Eq 'ROUTER_(FRONT|BACK)_GW' compose.yaml "$AL_E2E_OVERLAY"; then
    fail 10 "prod: compose.yaml (or the e2e overlay) names ROUTER_FRONT_GW/ROUTER_BACK_GW"
  fi

  # 13: the Caddyfile adapted with NO gateway variables equals the committed baseline. Exact
  # command of task 3.1 (--pretty, stdout only, stderr discarded, no -e flags), on the router's
  # own digest-pinned image.
  img=$(jq -r '.services.router.image' "$TMP/prod.json")
  case "$img" in
    *@sha256:*) ;;
    *) fail 13 "prod: router image is not digest-pinned ($img)" ;;
  esac
  if docker run --rm -v "$ROOT/docker/Caddyfile:/etc/caddy/Caddyfile:ro" "$img" \
       caddy adapt --config /etc/caddy/Caddyfile --pretty 2>/dev/null >"$TMP/adapt.json"; then
    cmp -s "$TMP/adapt.json" docker/scripts/caddy-adapt.baseline.json ||
      fail 13 "prod: docker/Caddyfile adapted with no ROUTER_* variables differs from docker/scripts/caddy-adapt.baseline.json"
  else
    fail 13 "prod: 'caddy adapt' failed (docker run of $img)"
  fi
}

# ---------------------------------------------------------------- global ---------------------
check_global() {
  echo "== global"
  # 11: compose auto-reads .env from the project directory (docker/ when compose.dev.yaml is run
  # without --project-directory .), which would feed prod values into dev interpolation.
  if [ -e docker/.env ] || [ -L docker/.env ]; then
    fail 11 "docker/.env exists (compose would auto-read it as the project .env for a hand-typed dev invocation)"
  fi
  # 12: the Companion build-context ignore file starts (first non-comment line) with `*`.
  ign=docker/companion.Dockerfile.dockerignore
  if [ ! -f "$ign" ]; then
    fail 12 "$ign is missing"
  else
    first=$(awk '/^[ \t]*#/ {next} /^[ \t]*$/ {next} {sub(/[ \t]+$/, ""); print; exit}' "$ign")
    [ "$first" = '*' ] || fail 12 "$ign does not begin with an exclude-all line (first non-comment line is [$first], expected [*])"
  fi
}

check_global
case "$WHAT" in dev|all) check_dev ;; esac
case "$WHAT" in stage|all) check_stage ;; esac
case "$WHAT" in prod|all) check_prod ;; esac

if [ "$FAILS" -gt 0 ]; then
  echo "check-envs: $FAILS invariant violation(s)" >&2
  exit 1
fi
echo "check-envs: ok ($WHAT)"
