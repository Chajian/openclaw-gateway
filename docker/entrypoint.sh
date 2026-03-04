#!/bin/sh
set -e

# 生成 supercronic crontab
SCHEDULE="${CRON_SCHEDULE:-0 10 9 * * *}"
echo "${SCHEDULE} cd /app && npx tsx packages/core/src/stable-cycle.ts --openclaw-config /config/openclaw.json" > /tmp/crontab

echo "[key-orchestrator] schedule = ${SCHEDULE}"
echo "[key-orchestrator] running initial sync..."

# 首次启动立即跑一轮
npx tsx packages/core/src/stable-cycle.ts --openclaw-config /config/openclaw.json || true

echo "[key-orchestrator] starting cron..."
exec supercronic /tmp/crontab
