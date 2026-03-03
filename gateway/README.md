# OpenClaw Gateway

LLM routing gateway for OpenClaw — handles Telegram / Feishu / Discord conversations and routes them to LLM providers.

## Quick Start

```bash
docker build -t openclaw-gateway .
docker run -p 3000:3000 --env-file .env openclaw-gateway
```

## Environment Variables

| Variable | Description |
|----------|-------------|
| `OPENAI_API_KEY` | OpenAI API key |
| `OPENAI_API_BASE` | OpenAI API base URL |
| `TELEGRAM_BOT_TOKEN` | Telegram bot token |
| `TELEGRAM_CHAT_ID` | Allowed Telegram chat ID |
| `FEISHU_APP_ID` | Feishu app ID (optional) |
| `FEISHU_APP_SECRET` | Feishu app secret (optional) |

## Used as submodule

This repo is included as a git submodule in the main claw monorepo for one-click Docker deployment.
