#!/usr/bin/env bash
# Builds the Docker image, runs it with a throwaway service-account key, and performs a real MCP
# handshake + tools/list with the MCP Inspector CLI. Used by CI; safe to run locally.
# No Google API calls are made (tools/list needs none), so the fake key is never used.
set -euo pipefail

IMAGE="${IMAGE:-gsclaw:smoke}"
PORT="${PORT:-3917}"
INSPECTOR="@modelcontextprotocol/inspector@2.9.0"
NAME="gsclaw-smoke-$$"
WORK="$(mktemp -d)"
cleanup() { docker rm -f "$NAME" >/dev/null 2>&1 || true; rm -rf "$WORK"; }
trap cleanup EXIT

if [[ "${SKIP_BUILD:-}" != "1" ]]; then
  docker build ${NODE_IMAGE:+--build-arg NODE_IMAGE="$NODE_IMAGE"} -t "$IMAGE" .
fi

node -e '
const { generateKeyPairSync } = require("node:crypto");
const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, privateKeyEncoding: { type: "pkcs8", format: "pem" }, publicKeyEncoding: { type: "spki", format: "pem" } });
process.stdout.write(JSON.stringify({ type: "service_account", project_id: "smoke-test", private_key: privateKey, client_email: "smoke@smoke-test.iam.gserviceaccount.com" }));
' > "$WORK/sa.json"
TOKEN="$(node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))')"

docker run -d --name "$NAME" -p "127.0.0.1:$PORT:3000" \
  -e GOOGLE_SERVICE_ACCOUNT_JSON="$(cat "$WORK/sa.json")" \
  -e GSCLAW_ACCESS_TOKEN="$TOKEN" \
  "$IMAGE" >/dev/null

for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:$PORT/healthz" >/dev/null 2>&1; then break; fi
  sleep 1
done
curl -fsS "http://127.0.0.1:$PORT/healthz"; echo

# Unauthenticated requests must be rejected.
status="$(curl -s -o /dev/null -w '%{http_code}' -X POST "http://127.0.0.1:$PORT/mcp")"
[[ "$status" == "401" ]] || { echo "expected 401 without token, got $status"; exit 1; }

npx -y "$INSPECTOR" --cli "http://127.0.0.1:$PORT/mcp" --transport http --method tools/list \
  --header "Authorization: Bearer $TOKEN" > "$WORK/tools.json"
count="$(node -e 'const d=JSON.parse(require("node:fs").readFileSync(process.argv[1],"utf8")); console.log((d.tools||[]).length)' "$WORK/tools.json")"
echo "tools/list returned $count tools"
[[ "$count" -ge 12 ]] || { cat "$WORK/tools.json"; exit 1; }
echo "Docker smoke test passed."
