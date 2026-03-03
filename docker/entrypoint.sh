#!/bin/sh
set -e

# 生成 supercronic crontab
SCHEDULE="${CRON_SCHEDULE:-0 10 9 * * *}"
echo "${SCHEDULE} cd /app && node packages/core/src/stable-cycle.mjs --openclaw-config /config/openclaw.json" > /tmp/crontab

echo "[key-orchestrator] schedule = ${SCHEDULE}"
echo "[key-orchestrator] running initial sync..."

# 首次启动立即跑一轮
node packages/core/src/stable-cycle.mjs --openclaw-config /config/openclaw.json || true

echo "[key-orchestrator] starting cron..."
exec supercronic /tmp/crontab
