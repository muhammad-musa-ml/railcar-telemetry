#!/usr/bin/env sh
# Validates the Prometheus and Alertmanager configuration and runs the alert
# rule unit tests, using promtool and amtool from the same images the stack runs.
set -eu

root="$(cd "$(dirname "$0")/.." && { pwd -W 2>/dev/null || pwd; })"
# Git Bash on Windows would otherwise rewrite the container paths below.
export MSYS_NO_PATHCONV=1

prom_image="prom/prometheus:v3.5.0"
am_image="prom/alertmanager:v0.28.1"

docker run --rm -v "$root/observability/prometheus:/etc/prometheus:ro" \
  --entrypoint promtool "$prom_image" check config /etc/prometheus/prometheus.yml

docker run --rm -v "$root/observability/prometheus:/etc/prometheus:ro" \
  --entrypoint promtool "$prom_image" test rules /etc/prometheus/tests/railcar.rules.test.yml

if [ -f "$root/observability/alertmanager/alertmanager.yml" ]; then
  docker run --rm -v "$root/observability/alertmanager:/etc/alertmanager:ro" \
    --entrypoint amtool "$am_image" check-config /etc/alertmanager/alertmanager.yml
fi
