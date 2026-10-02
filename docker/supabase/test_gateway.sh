#!/bin/sh
# docker/supabase/test_gateway.sh ENV -- cases for the Supabase gateway (supabase-services task 3.3;
# spec "Supabase gateway routes and key checks"). Needs a running stack (make ENV-up); run by hand:
#
#   sh docker/supabase/test_gateway.sh dev|stage
#
# Key values are read from the gateway container and written only to a mode-600 curl header file
# in a temp dir; they are never printed or put on a command line. Output: case names and statuses.
set -eu
ENV=${1:?usage: test_gateway.sh dev|stage}
case $ENV in dev) P=autologger-dev ;; stage) P=autologger-stage ;; *) echo "dev or stage" >&2; exit 2 ;; esac
GW=$P-supabase-gw-1
PORT=$(docker exec "$GW" printenv SUPABASE_PORT)
B=http://127.0.0.1:$PORT
T=$(mktemp -d); chmod 700 "$T"
trap 'rm -rf "$T"' EXIT
umask 077
printf 'apikey: %s\n' "$(docker exec "$GW" printenv ANON_KEY)" >"$T/anon"
printf 'apikey: %s\n' "$(docker exec "$GW" printenv SERVICE_ROLE_KEY)" >"$T/svc"
printf 'apikey: %s\n' "x.y.z" >"$T/wrong"
printf 'Authorization: Bearer %s\n' "$(docker exec "$GW" printenv SERVICE_ROLE_KEY)" >"$T/svcbearer"
printf 'Authorization:\n' >"$T/emptyauth"
: >"$T/none"
PASS=0; FAILED=0

# req KEYFILE PATH [curl args...]: prints the HTTP status; body in $T/body.
req() { _k=$1; _p=$2; shift 2; curl -s -o "$T/body" -w '%{http_code}' -H "@$T/$_k" "$@" "$B$_p" || echo 000; }
check() { # NAME WANT GOT
  if [ "$3" = "$2" ]; then PASS=$((PASS + 1)); echo "ok   $1 ($3)"; else FAILED=$((FAILED + 1)); echo "FAIL $1 (wanted $2, got $3)"; fi
}
check_in() { # NAME "A B" GOT: GOT is one of the listed statuses
  case " $2 " in *" $3 "*) PASS=$((PASS + 1)); echo "ok   $1 ($3)" ;; *) FAILED=$((FAILED + 1)); echo "FAIL $1 (wanted one of $2, got $3)" ;; esac
}
from_service() { grep -q '"' "$T/body"; } # upstream answers are JSON; gateway refusals have no body

# Host and Origin (before any routing)
check "evil Host refused" 403 "$(req anon /rest/v1/x -H "Host: evil.example:$PORT")"
check "other environment's Host refused" 403 "$(req anon /rest/v1/x -H "Host: localhost:$((PORT == 8790 ? 8791 : 8790))")"
check_in "missing Host refused" "400 403" "$(req anon /rest/v1/x --http1.0 -H 'Host:')"
check "foreign Origin refused" 403 "$(req anon /rest/v1/x -H "Origin: https://evil.example")"
check "own Origin allowed" 404 "$(req anon /rest/v1/x -H "Origin: http://localhost:$PORT")"

# rest
check "rest without a key" 401 "$(req none /rest/v1/x)"
check "rest with a wrong key" 401 "$(req wrong /rest/v1/x)"
check "rest with the anon key reaches rest (PGRST205)" 404 "$(req anon /rest/v1/x)"
grep -q PGRST205 "$T/body" && check "rest body is PostgREST's" yes yes || check "rest body is PostgREST's" yes no
check "rest root with the anon key" 403 "$(req anon /rest/v1/)"
check "rest root with the service key" 200 "$(req svc /rest/v1/)"
for p in /REST/v1/ /rest/v1// /rest/v1/%2F /Rest/V1/; do check_in "rest root trick $p with the anon key" "401 403" "$(req anon "$p")"; done

# auth
check "auth without a key" 401 "$(req none /auth/v1/health)"
check "auth health with the anon key" 200 "$(req anon /auth/v1/health)"
check "auth settings with the anon key" 200 "$(req anon /auth/v1/settings)"
# gotrue-sign-in D3: Google is the only provider and the only way to sign up; auto-confirm is off.
for want in '"disable_signup":false' '"google":true' '"email":false' '"phone":false' '"anonymous_users":false' '"mailer_autoconfirm":false'; do
  grep -q "$want" "$T/body" && check "settings: $want" yes yes || check "settings: $want" yes no
done
for p in /auth/v1/verify /auth/v1/callback /auth/v1/authorize; do
  s=$(req none "$p")
  if [ "$s" != 401 ] && [ "$s" != 403 ] && [ "$s" != 404 ] && from_service; then check "open route $p reaches auth without a key" yes yes; else check "open route $p reaches auth without a key" yes "no ($s)"; fi
done
s=$(req anon /auth/v1/admin/users)
if { [ "$s" = 401 ] || [ "$s" = 403 ]; } && from_service; then check "admin API with the anon key is refused by auth itself" yes yes; else check "admin API with the anon key is refused by auth itself" yes "no ($s)"; fi
check "a client token is passed through (anon apikey, service bearer)" 200 "$(req anon /auth/v1/admin/users -H "@$T/svcbearer")"
check "an empty Authorization is treated as absent (service apikey)" 200 "$(req svc /auth/v1/admin/users -H "@$T/emptyauth")"

# realtime
for p in /realtime/v1/api/tenants /realtime/v1/api//tenants /realtime/v1/api/%2Ftenants /realtime/v1/api/Tenants /realtime/v1/api/openapi; do
  check_in "realtime tenant API $p with the service key" "401 403" "$(req svc "$p")"
done
check "realtime broadcast without a key" 401 "$(req none /realtime/v1/api/broadcast -X POST -H 'Content-Type: application/json' -d '{"messages":[]}')"
check "realtime broadcast with the anon key" 202 "$(req anon /realtime/v1/api/broadcast -X POST -H 'Content-Type: application/json' -d '{"messages":[{"topic":"t","event":"e","payload":{}}]}')"
ws() { # KEYFILE -> ok | failed
  KEYFILE="$T/$1" PORT="$PORT" node --input-type=module -e '
    import { readFileSync } from "node:fs";
    const key = readFileSync(process.env.KEYFILE, "utf8").replace(/^apikey: /, "").trim();
    const s = new WebSocket(`ws://localhost:${process.env.PORT}/realtime/v1/websocket?apikey=${key}&vsn=1.0.0`);
    const done = (r) => { console.log(r); process.exit(0); };
    setTimeout(() => done("failed"), 8000);
    s.onerror = () => done("failed");
    s.onclose = () => done("failed");
    s.onopen = () => s.send(JSON.stringify({ topic: "realtime:t", event: "phx_join", payload: { config: {} }, ref: "1" }));
    s.onmessage = (m) => { const d = JSON.parse(m.data); if (d.event === "phx_reply" && d.ref === "1") done(d.payload.status === "ok" ? "ok" : "failed"); };' 2>/dev/null || echo failed
}
check "realtime websocket join with the anon key" ok "$(ws anon)"
check "realtime websocket with a wrong key" failed "$(ws wrong)"

# storage
check "storage bucket list with the service key" 200 "$(req svc /storage/v1/bucket -H "@$T/svcbearer")"
req svc /storage/v1/bucket -H "@$T/svcbearer" -X POST -H 'Content-Type: application/json' -d '{"name":"gwtest","public":false}' >/dev/null
check "storage upload with the service key" 200 "$(req svc /storage/v1/object/gwtest/a.txt -H "@$T/svcbearer" -X POST -H 'Content-Type: text/plain' --data-binary hello)"
check "storage download" 200 "$(req svc /storage/v1/object/gwtest/a.txt -H "@$T/svcbearer")"
req svc /storage/v1/object/gwtest -H "@$T/svcbearer" -X DELETE -H 'Content-Type: application/json' -d '{"prefixes":["a.txt"]}' >/dev/null
req svc /storage/v1/bucket/gwtest -H "@$T/svcbearer" -X DELETE >/dev/null

# everything else
check "unknown path" 404 "$(req svc /pg/tables)"
check "Studio path" 404 "$(req none /)"

# the host cannot bypass the gateway
for s in auth:9999 rest:3000 realtime:4000 storage:5000; do
  ip=$(docker inspect "$P-${s%%:*}-1" -f '{{range .NetworkSettings.Networks}}{{.IPAddress}} {{end}}')
  r=reachable
  for a in $ip; do timeout 3 sh -c "curl -s -o /dev/null --connect-timeout 2 http://$a:${s#*:}/" 2>/dev/null || r=unreachable; done
  check "host to ${s%%:*} directly" unreachable "$r"
done

# keys stay out of the gateway log on an upstream error
docker stop "$P-rest-1" >/dev/null
check "rest down gives 502 through the gateway" 502 "$(req svc /rest/v1/x)"
docker start "$P-rest-1" >/dev/null
n=0
for f in anon svc; do n=$((n + $(docker logs "$GW" 2>&1 | grep -cF -- "$(sed 's/^apikey: //' "$T/$f")" || true))); done
check "API keys in the gateway log" 0 "$n"

echo "test_gateway ($ENV): $PASS passed, $FAILED failed"
[ "$FAILED" -eq 0 ]
