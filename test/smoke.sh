#!/usr/bin/env bash
# Smoke test for the Docker image. Needs Docker and network access.
set -euo pipefail
img="alarm-clock:smoke"
docker build -t "$img" .

# Node uses its own bundled time zone data (ICU), not the OS files.
# Test the behaviour: BC is on permanent UTC-7 (offset 420) all year.
for d in 2026-07-01T12:00:00Z 2026-12-01T12:00:00Z; do
  off=$(docker run --rm -e TZ=America/Vancouver --entrypoint node "$img" \
        -p "new Date('$d').getTimezoneOffset()")
  [[ "$off" == "420" ]] \
    || { echo "FAIL: America/Vancouver offset at $d is $off, expected 420" >&2; exit 1; }
done

docker run --rm --entrypoint node "$img" --check alarm-clock.js
ver=$(node -p "require('./package.json').version")
grep -q "display_version.*${ver}" alarm-clock.js \
  || { echo "FAIL: display_version does not match package.json ${ver}" >&2; exit 1; }
echo "PASS"
