#!/usr/bin/env bash
set -euo pipefail

WORK="$(mktemp -d)"
NAME="network-sync-smoke-$$"
cleanup() {
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  # Files created by the container are root-owned on the CI runner.
  docker run --rm --entrypoint sh -v "$WORK:/work" network-sync:test -c "chmod -R a+rwX /work" >/dev/null 2>&1 || true
  rm -rf "$WORK" || true
}
trap cleanup EXIT

mkdir -p "$WORK/source/OneDrive 1/Photos/2026/01" \
         "$WORK/source/OneDrive 2/Photos/2026/01" \
         "$WORK/destination" "$WORK/data"
printf 'AAA' > "$WORK/source/OneDrive 1/Photos/2026/01/photo.jpg"
printf 'BBBBBBBB' > "$WORK/source/OneDrive 2/Photos/2026/01/photo.jpg"

docker run -d --rm --name "$NAME" -p 127.0.0.1:18080:8080 \
  -e APP_USERNAME=smoke -e APP_PASSWORD='smokepassword1234' \
  -v "$WORK/source:/volume1/OneDrive:ro" \
  -v "$WORK/destination:/volumeUSB1/usbshare:rw" \
  -v "$WORK/data:/app/data:rw" network-sync:test >/dev/null

READY=0
for _ in $(seq 1 25); do
  if curl -fsS http://127.0.0.1:18080/api/health >/dev/null 2>&1; then
    READY=1
    break
  fi
  sleep 1
done
if [[ "$READY" != 1 ]]; then
  docker logs "$NAME"
  echo 'Application did not become ready' >&2
  exit 1
fi

AUTH='smoke:smokepassword1234'
SETTINGS=$(curl -fsS -u "$AUTH" http://127.0.0.1:18080/api/settings)
[[ "$SETTINGS" == *'/volume1'* && "$SETTINGS" == *'/volumeUSB1'* ]] || {
  echo 'Expected configurable NAS mount points in API settings' >&2
  exit 1
}
curl -fsS -u "$AUTH" -H 'Content-Type: application/json' \
  -d '{"parent":"/volumeUSB1/usbshare","name":"Generated from browser"}' \
  http://127.0.0.1:18080/api/folders >/dev/null
[[ -d "$WORK/destination/Generated from browser" ]] || { echo 'Folder creation failed' >&2; exit 1; }
STATUS=$(curl -sS -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/jobs)
[[ "$STATUS" == 401 ]] || { echo 'Unauthenticated access was not blocked' >&2; exit 1; }

RESPONSE=$(curl -fsS -u "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Smoke test","sources":["/volume1/OneDrive/OneDrive 1/Photos","/volume1/OneDrive/OneDrive 2/Photos"],"destination":"/volumeUSB1/usbshare/Photos","conflictPolicy":"rename","compareMode":"size","enabled":true}' \
  http://127.0.0.1:18080/api/jobs)
ID=$(node -p 'JSON.parse(process.argv[1]).job.id' "$RESPONSE")
curl -fsS -u "$AUTH" -H 'Content-Type: application/json' -d '{"dryRun":false}' \
  "http://127.0.0.1:18080/api/jobs/$ID/run" >/dev/null

FINISHED=0
for _ in $(seq 1 40); do
  STATUS=$(curl -fsS -u "$AUTH" http://127.0.0.1:18080/api/status)
  if [[ "$STATUS" == *'"active":null'* ]]; then
    FINISHED=1
    break
  fi
  sleep 1
done
[[ "$FINISHED" == 1 ]] || { echo 'Sync timeout' >&2; exit 1; }

FOLDER="$WORK/destination/Photos/2026/01"
[[ "$(find "$FOLDER" -type f | wc -l)" -eq 2 ]] || { echo 'Expected two merged files' >&2; exit 1; }
[[ "$(cat "$FOLDER/photo.jpg")" == 'AAA' ]] || { echo 'Source content mismatch' >&2; exit 1; }

RUNS=$(curl -fsS -u "$AUTH" "http://127.0.0.1:18080/api/jobs/$ID/runs")
[[ "$RUNS" == *'"status":"completed"'* ]] || { echo "Unexpected sync status: $RUNS" >&2; exit 1; }
echo 'Docker smoke test passed (auth, API, multiple sources, conflict rename, persistence).'
