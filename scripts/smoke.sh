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
printf 'EXCLUDED' > "$WORK/source/OneDrive 1/Photos/2026/01/document.pdf"

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
  -d '{"name":"Smoke test","sources":["/volume1/OneDrive/OneDrive 1/Photos","/volume1/OneDrive/OneDrive 2/Photos"],"destination":"/volumeUSB1/usbshare/Photos","conflictPolicy":"rename","compareMode":"size","extensions":[".JPG","jpg"],"enabled":true}' \
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
[[ "$RUNS" == *'"excluded":1'* ]] || { echo "Expected one filtered file: $RUNS" >&2; exit 1; }
[[ ! -e "$FOLDER/document.pdf" ]] || { echo 'Excluded PDF was copied' >&2; exit 1; }
JOBS=$(curl -fsS -u "$AUTH" http://127.0.0.1:18080/api/jobs)
[[ "$JOBS" == *'"extensions":["jpg"]'* ]] || { echo "Extension normalization failed: $JOBS" >&2; exit 1; }
INVALID=$(curl -sS -u "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Bad extension","sources":["/volume1/OneDrive/OneDrive 1/Photos"],"destination":"/volumeUSB1/usbshare/Other","extensions":[]}' \
  -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/jobs)
[[ "$INVALID" == 400 ]] || { echo "Expected invalid extension filter to fail: $INVALID" >&2; exit 1; }

# A second rule combines strict size and a regex on the basename.
RESPONSE=$(curl -fsS -u "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Filtered","sources":["/volume1/OneDrive/OneDrive 1/Photos","/volume1/OneDrive/OneDrive 2/Photos"],"destination":"/volumeUSB1/usbshare/Filtered","sizeFilter":{"operator":"gt","megabytes":0.000005},"filenameRegex":"^photo\\.jpg$"}' \
  http://127.0.0.1:18080/api/jobs)
FILTERED_ID=$(node -p 'JSON.parse(process.argv[1]).job.id' "$RESPONSE")
curl -fsS -u "$AUTH" -H 'Content-Type: application/json' -d '{"dryRun":false}' \
  "http://127.0.0.1:18080/api/jobs/$FILTERED_ID/run" >/dev/null
FINISHED=0
for _ in $(seq 1 40); do
  STATUS=$(curl -fsS -u "$AUTH" http://127.0.0.1:18080/api/status)
  if [[ "$STATUS" == *'"active":null'* ]]; then FINISHED=1; break; fi
  sleep 1
done
[[ "$FINISHED" == 1 ]] || { echo 'Filtered sync timeout' >&2; exit 1; }
[[ "$(cat "$WORK/destination/Filtered/2026/01/photo.jpg")" == 'BBBBBBBB' ]] || {
  echo 'Size and regex filters did not select the expected file' >&2; exit 1;
}
FILTERED_RUNS=$(curl -fsS -u "$AUTH" "http://127.0.0.1:18080/api/jobs/$FILTERED_ID/runs")
[[ "$FILTERED_RUNS" == *'"excluded":2'* ]] || { echo "Expected 2 excluded files: $FILTERED_RUNS" >&2; exit 1; }
INVALID=$(curl -sS -u "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Invalid","sources":["/volume1/OneDrive/OneDrive 1/Photos"],"destination":"/volumeUSB1/usbshare/Invalid","sizeFilter":{"operator":"gte","megabytes":1}}' \
  -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/jobs)
[[ "$INVALID" == 400 ]] || { echo "Expected invalid size filter 400, got $INVALID" >&2; exit 1; }
INVALID=$(curl -sS -u "$AUTH" -H 'Content-Type: application/json' \
  -d '{"name":"Invalid regex","sources":["/volume1/OneDrive/OneDrive 1/Photos"],"destination":"/volumeUSB1/usbshare/InvalidRegex","filenameRegex":"(a+)+$"}' \
  -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/api/jobs)
[[ "$INVALID" == 400 ]] || { echo "Expected invalid regex 400, got $INVALID" >&2; exit 1; }
echo 'Docker smoke test passed (auth, API, conflicts, extension/size/regex filters, persistence).'
