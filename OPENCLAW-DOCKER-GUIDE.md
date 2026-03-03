# OpenClaw Docker 部署运维手册

## 概述

OpenClaw 是开源 AI Agent 网关（前身 Clawdbot/Moltbot），MIT 协议，TypeScript 实现。支持多渠道消息（Telegram/WhatsApp/Slack/Discord）、多模型路由、技能系统、定时任务等。

当前版本：**2026.2.25**，从源码构建的本地 Docker 镜像。

---

## 环境信息

| 项目 | 值 |
|------|-----|
| 宿主机 | Windows 11 Pro, WSL2 |
| Docker | Docker Desktop 29.1.3 + Compose v2.40.3 |
| 代理 | `http://127.0.0.1:7890`（容器内使用 `host.docker.internal:7890`）|
| 用户目录 | `C:\Users\KSG` |

---

## 目录结构

```
C:\Users\KSG\
├── openclaw\                          # OpenClaw 源码 + docker-compose
│   ├── docker-compose.yml
│   ├── .env
│   ├── Dockerfile
│   └── docker-setup.sh
├── .openclaw\                         # OpenClaw 运行时配置和数据
│   ├── openclaw.json                  # 主配置文件（核心）
│   ├── workspace\                     # Agent 工作空间
│   ├── agents\                        # Agent 会话数据
│   └── cron\                          # 定时任务存储
├── .docker\
│   └── daemon.json                    # Docker 守护进程代理配置
└── AppData\Roaming\Docker\
    └── settings-store.json            # Docker Desktop 代理设置

D:\workspace\leetcode\array\54\
└── linuxdo-monitor\                   # LinuxDo 羊毛监控服务
    ├── monitor.js                     # Node.js 监控脚本
    ├── monitor.py                     # Python 版（备用）
    ├── Dockerfile
    ├── docker-compose.yml
    └── .env
```

---

## 运行中的容器

| 容器名 | 镜像 | 端口 | 用途 |
|--------|------|------|------|
| `openclaw-openclaw-gateway-1` | `openclaw:local` | 18789, 18790 | OpenClaw 网关 |
| `linuxdo-monitor` | `linuxdo-monitor-linuxdo-monitor` | 无 | LinuxDo RSS 监控 + Telegram 推送 |

---

## OpenClaw 配置详解

### 主配置文件：`C:\Users\KSG\.openclaw\openclaw.json`

```json
{
  "gateway": {
    "mode": "local",
    "controlUi": {
      "allowedOrigins": ["http://localhost:18789", "http://127.0.0.1:18789"],
      "dangerouslyAllowHostHeaderOriginFallback": true
    }
  },
  "models": {
    "providers": {
      "anthropic": {
        "baseUrl": "https://anyrouter.top",
        "apiKey": "sk-zSv6D1...（第三方中转）",
        "models": []
      },
      "openai": {
        "baseUrl": "https://stephecurry.asia",
        "apiKey": "sk-dRuLmv...（Codex 专用，当前站点不可用 error 1033）",
        "models": []
      }
    }
  },
  "channels": {
    "telegram": {
      "botToken": "8680614958:AAGWo0jy...（@lingyang4_bot）",
      "enabled": true,
      "dmPolicy": "open",
      "allowFrom": ["*"]
    }
  },
  "cron": {
    "enabled": true,
    "maxConcurrentRuns": 5
  },
  "agents": {
    "defaults": {
      "workspace": "/home/node/.openclaw/workspace",
      "model": {
        "primary": "anthropic/claude-opus-4-6",
        "fallbacks": ["openai/gpt-4o"]
      }
    }
  },
  "tools": {
    "media": {
      "audio": {
        "enabled": true,
        "models": [
          {
            "provider": "openai",
            "model": "FunAudioLLM/SenseVoiceSmall",
            "baseUrl": "https://api.siliconflow.cn/v1",
            "headers": {
              "Authorization": "Bearer sk-lbvrmt...（硅基流动）"
            },
            "language": "zh",
            "timeoutSeconds": 60
          }
        ]
      }
    }
  }
}
```

### 环境变量：`C:\Users\KSG\openclaw\.env`

```bash
OPENCLAW_CONFIG_DIR=/c/Users/KSG/.openclaw
OPENCLAW_WORKSPACE_DIR=/c/Users/KSG/.openclaw/workspace
OPENCLAW_GATEWAY_PORT=18789
OPENCLAW_BRIDGE_PORT=18790
OPENCLAW_GATEWAY_BIND=lan
OPENCLAW_GATEWAY_TOKEN=8ef286d348814d24ea2a10e25e08cee0be2402b0ce9184f9e17054fe4efea26f
OPENCLAW_IMAGE=openclaw:local
```

---

## 配置说明

### LLM Providers

| Provider | Base URL | API Key 前缀 | 状态 | 用途 |
|----------|----------|-------------|------|------|
| anthropic | `https://anyrouter.top` | `sk-zSv6D1...` | 正常 | Claude Opus 4.6（默认主模型）|
| openai | `https://stephecurry.asia` | `sk-dRuLmv...` | 不可用（CF 1033）| GPT Codex（fallback）|

**模型格式**：`provider/model-name`，如 `anthropic/claude-opus-4-6`、`openai/gpt-4o`

**切换默认模型**：修改 `agents.defaults.model`：
```json
// 简单字符串
"model": "anthropic/claude-opus-4-6"

// 带 fallback
"model": {
  "primary": "openai/gpt-4o",
  "fallbacks": ["anthropic/claude-opus-4-6"]
}
```

**内置别名**：`opus` → claude-opus-4-6, `sonnet` → claude-sonnet-4-6, `gpt` → gpt-5.2

### Telegram Channel

- Bot: `@lingyang4_bot`（ID: 8680614958）
- 用户 Chat ID: `1156180724`（用户名 @wakuwakuba，Li Ning）
- `dmPolicy: "open"` + `allowFrom: ["*"]` 表示接受所有人 DM
- **注意**：`dmPolicy: "open"` 必须配合 `allowFrom: ["*"]`，否则网关启动报错

### 语音识别 (STT)

- Provider: 硅基流动 SiliconFlow
- Model: `FunAudioLLM/SenseVoiceSmall`（免费中文语音识别）
- 使用 OpenAI 兼容接口（`provider: "openai"` + 自定义 `baseUrl`）
- Telegram 语音消息自动调用此配置转文字

### Cron 定时任务

已启用，支持三种调度类型：
```json
// 每N毫秒
{ "kind": "every", "everyMs": 60000 }

// Cron 表达式
{ "kind": "cron", "expr": "0 9 * * *", "tz": "Asia/Shanghai" }

// 一次性
{ "kind": "at", "at": "2025-02-27T14:30:00Z" }
```

投递模式：`announce`（发送到 Telegram）、`webhook`（HTTP POST）、`none`

---

## 常用运维命令

### OpenClaw 网关

```bash
# 进入源码目录
cd ~/openclaw

# 启动/停止/重启
docker compose up -d openclaw-gateway
docker compose down openclaw-gateway
docker compose restart openclaw-gateway

# 查看日志
docker compose logs openclaw-gateway --tail 30
docker compose logs openclaw-gateway -f

# 容器内执行 CLI（重要：必须用 exec gateway，不要用 run cli）
docker compose exec openclaw-gateway node dist/index.js status
docker compose exec openclaw-gateway node dist/index.js status --deep
docker compose exec openclaw-gateway node dist/index.js health
docker compose exec openclaw-gateway node dist/index.js models --help
docker compose exec openclaw-gateway node dist/index.js channels --help
docker compose exec openclaw-gateway node dist/index.js cron --help

# 设备管理（Web 控制台配对）
docker compose exec openclaw-gateway node dist/index.js devices list
docker compose exec openclaw-gateway node dist/index.js devices approve <requestId>

# 查看详细日志文件（容器内）
docker compose exec openclaw-gateway sh -c "cat /tmp/openclaw/openclaw-$(date +%Y-%m-%d).log"
```

### LinuxDo 监控

```bash
cd "D:/workspace/leetcode/array/54/linuxdo-monitor"

# 启动/停止
docker compose up -d
docker compose down

# 查看日志
docker logs -f linuxdo-monitor
docker logs linuxdo-monitor --tail 20

# 清空已推送记录重新扫描
docker compose down && docker volume rm linuxdo-monitor_monitor-data && docker compose up -d

# 重新构建（修改代码后）
docker compose up -d --build
```

### Docker 代理

```bash
# Docker daemon 代理配置：~/.docker/daemon.json
# Docker Desktop 代理设置：AppData/Roaming/Docker/settings-store.json
#   ProxyHTTPMode: "manual"
#   OverrideProxyHTTP / OverrideProxyHTTPS: "http://host.docker.internal:7890"

# 重启 Docker Desktop（PowerShell）
Stop-Process -Name "Docker Desktop" -Force; Start-Process "C:\Program Files\Docker\Docker\Docker Desktop.exe"
```

---

## 踩坑记录

### 1. 网关启动 "Missing config"
原因：`~/.openclaw/openclaw.json` 不存在或缺少 `gateway.mode`。
修复：创建配置文件，至少包含 `{ "gateway": { "mode": "local" } }`

### 2. "non-loopback Control UI requires allowedOrigins"
原因：`OPENCLAW_GATEWAY_BIND=lan` 绑定到 LAN，需要配置允许的来源。
修复：添加 `controlUi.allowedOrigins` + `dangerouslyAllowHostHeaderOriginFallback: true`

### 3. CLI 容器无法连接网关
原因：`openclaw-cli` 容器用 `ws://127.0.0.1:18789` 连接的是自己的 localhost。
修复：**始终用 `docker compose exec openclaw-gateway` 而不是 `docker compose run openclaw-cli`**

### 4. Telegram "chat not found"
原因：用户未给 bot 发送过消息，Telegram bot 只能回复主动发过消息的用户。
修复：用户先在 Telegram 给 bot 发 `/start` 或任意消息

### 5. Telegram getUpdates 409 冲突
原因：OpenClaw 网关正在用长轮询消费 Telegram updates，外部 `getUpdates` 调用冲突。
修复：不要同时用 API 调 `getUpdates`；如需获取 Chat ID，先临时禁用 Telegram（`enabled: false`）

### 6. Docker build 拉不到镜像（EOF / DNS 失败）
原因：Docker Hub 需要代理才能访问。
修复：`~/.docker/daemon.json` 配置 `proxies`，Docker Desktop settings 设为 `manual` 代理

### 7. LinuxDo RSS 返回 0 篇帖子
原因：Cloudflare 限流（HTTP 429），频繁请求触发。
修复：增大检查间隔（当前 600 秒），请求间加 3 秒延迟，使用浏览器 UA

### 8. `dmPolicy: "open"` 报错
原因：`dmPolicy: "open"` 必须配合 `allowFrom: ["*"]`。
修复：同时设置 `"allowFrom": ["*"]`

---

## LinuxDo 监控系统详情

### 功能
- 每 10 分钟检查 LinuxDo `latest.rss` + `top.rss`
- 双层关键词过滤：高置信词（单个命中即推送）+ 中置信词（需2个以上）
- 自动推送到 Telegram（@lingyang4_bot → Chat ID 1156180724）
- Docker 持久化存储已推送帖子，避免重复

### 关键词

**高置信（29个）**：薅羊毛、白嫖、公益服、抽奖、giveaway、免费送/领/用/拿/得、白送、0元、邀请码、兑换码、激活码、优惠码、福利、赠送、羊毛、公益、免费分享、限免、买一送、拼车、合租、车位

**中置信（13个，需≥2个同时命中）**：免费、名额、限时、限量、coupon、试用、体验金、新人、首月、分享、开源、送、领取

**排除词**：求助、出售、转让、付费、收费、代购、有偿、求购、收购、购买、招聘、求职、怎么、如何、报错、bug、求推荐

### 已知限制
- LinuxDo 分类 RSS（如 `/c/welfare/36.rss`）被 Cloudflare 拦截，只能用全站 `latest.rss` + `top.rss`
- 全站 RSS 每源只返回最新 30 篇，非常热门的老帖可能漏掉
