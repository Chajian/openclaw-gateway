# Key Orchestrator (Authorized-only)

This module helps you run a compliant "self-supply" key pipeline:

1. You authorize accounts manually (official OAuth/API only).
2. The orchestrator syncs API keys and quota from allowed endpoints.
3. It stores secrets in an encrypted local store.
4. It exports best keys to OpenClaw providers.

It does **not** implement bypass/abuse automation (captcha bypass, fake registration, credential stuffing).

## 1) Setup

```bash
cd key-orchestrator
cp config/sites.example.json config/sites.json
cp config/provider-map.example.json config/provider-map.json
```

Set the master key (required):

```bash
export KEYHUB_MASTER_KEY="replace-with-a-long-random-passphrase"
```

PowerShell:

```powershell
$env:KEYHUB_MASTER_KEY="replace-with-a-long-random-passphrase"
```

## 2) Import session/access secrets

Store your authorized token/session value:

```bash
npm run import:token -- --name provider_a_access_token --value "YOUR_ACCESS_TOKEN"
```

You can also read from stdin:

```bash
echo "YOUR_ACCESS_TOKEN" | npm run import:token -- --name provider_a_access_token --stdin
```

## 3) Sync keys and quota

```bash
npm run sync
```

For each enabled site in `config/sites.json`:
- `mock` adapter produces deterministic demo data.
- `http` adapter calls official API endpoints that you configure.
- `new-api` adapter supports QuantumNous/new-api style consoles.

## 3.1) One-shot onboard for new-api sites

When a site is based on `new-api` and exposes similar API routes:

```bash
npm run onboard:newapi -- \
  --site "https://example-newapi.site/console" \
  --site-id "example-newapi" \
  --provider openai
```

Before onboarding, store username/password secrets:

```bash
npm run import:token -- --name example-newapi_username --value "YOUR_USERNAME"
npm run import:token -- --name example-newapi_password --value "YOUR_PASSWORD"
```

If you need Turnstile token query for login/register, store it and pass:

```bash
npm run import:token -- --name example-newapi_turnstile --value "TURNSTILE_TOKEN"
npm run onboard:newapi -- --site "https://example-newapi.site/console" --site-id "example-newapi" --turnstile-secret example-newapi_turnstile
```

### 3.2) OAuth token-only flow (recommended for LinuxDo OAuth sites)

For sites that disable password registration/login but allow LinuxDo OAuth:

1. Complete login once in browser.
2. Copy the authorized access token from the site session.
3. Import token only (user id can be auto-derived on next sync):

```bash
npm run import:token -- --name dkjsiogu_access_token --value "YOUR_ACCESS_TOKEN"
```

4. Run sync/cycle:

```bash
npm run cycle:auto -- --openclaw-config "C:\Users\KSG\.openclaw\openclaw.json"
```

If token is valid, `new-api` adapter will call `/api/user/self`, infer `user_id`, and persist it to `dkjsiogu_user_id`.

## 4) Export to OpenClaw

## LinuxDo 公益站自动发现与入库

基于 LinuxDo RSS（绕过 Cloudflare challenge 限制）自动发现“福利羊毛/公益站”帖子里的外链站点，然后写入 `sites.json` / `provider-map.json`。

1. 发现站点：

```bash
npm run discover:linuxdo
```

输出：`data/linuxdo-public-sites.json`

2. 入库并识别已注册状态（依赖 `KEYHUB_MASTER_KEY` 读取密钥仓库）：

```bash
npm run upsert:linuxdo
```

输出：`data/linuxdo-site-upsert-report.json`

3. 对未注册站点尝试 LinuxDo OAuth 登录，成功后自动写入 `<siteId>_access_token`/`<siteId>_user_id`：

```bash
npm run onboard:linuxdo -- --openclaw-cli "C:\\Users\\KSG\\openclaw\\dist\\index.js" --browser-profile openclaw
```

输出：`data/linuxdo-onboard-report.json`

> 说明：部分站点会出现验证码、人工授权确认或页面结构差异，脚本会标记 `manual_required`，你完成手动授权后可重复执行 `onboard:linuxdo` 继续收敛。

### Option A: export env file

```bash
npm run export:env -- --map config/provider-map.json --out data/openclaw-provider.env
```

Output example:

```bash
OPENCLAW_PROVIDER_OPENAI_API_KEY=sk-...
OPENCLAW_PROVIDER_OPENAI_SOURCE=provider-a:key-id
```

### Option B: patch `openclaw.json` directly

```bash
npm run export:json -- --map config/provider-map.json --openclaw-config "C:\Users\KSG\.openclaw\openclaw.json"
```

This command creates a timestamped backup first.

## 5) Connect to your Docker OpenClaw deployment

Recommended flow:

1. Run sync/export from this module.
2. Write provider keys to your OpenClaw config (Option B), or wire env references.
3. Restart gateway:

```bash
cd C:\Users\KSG\openclaw
docker compose restart openclaw-gateway
```

## 6) Let OpenClaw run this for you (not manual shell)

Put this module into OpenClaw workspace, then create a skill that calls:

1. `onboard:newapi` when you send a new site URL.
2. `sync` on schedule.
3. `export:json` after sync.

For example, from Telegram you can ask:
- "新增站点 https://foo.example/console 并同步 key"
- "现在刷新所有公益站 key 并更新 OpenClaw provider"

The agent executes the commands on your host (with your approved tool policy), so you do not run shell commands manually.

Underlying command for full cycle:

```bash
npm run cycle:auto -- --openclaw-config "C:\Users\KSG\.openclaw\openclaw.json"
```

## Stable daily mode (recommended)

For a stable production loop (retry + lock + report + log):

```bash
npm run cycle:stable -- --openclaw-config "C:\Users\KSG\.openclaw\openclaw.json"
```

Windows scheduled task helpers:

```powershell
powershell -File .\scripts\install-daily-task.ps1 -RunAt "09:10"
```

Feishu daily notification:
- default account: `main`
- target priority:
  1. script arg `-FeishuTarget`
  2. user env `OPENCLAW_FEISHU_TARGET`
  3. built-in fallback target

Set custom target:

```powershell
[Environment]::SetEnvironmentVariable("OPENCLAW_FEISHU_TARGET", "ou_xxx", "User")
```

Manual run entry:

```powershell
powershell -File .\scripts\run-stable-cycle.ps1 -FeishuAccount main -FeishuTarget "ou_xxx"
```

Outputs:
- `data/stable-cycle-report.json`
- `data/stable-cycle-history/*.json`
- `data/logs/stable-cycle-*.log`

## Config reference

`config/sites.json`:
- `id`: unique site id
- `type`: `mock` or `http`
- `enabled`: boolean
- `auth.tokenSecret`: secret name in encrypted store
- `baseUrl`: required for `http`
- `settings.*`: endpoint paths and response mapping fields

`config/provider-map.json`:
- `siteId`: site source
- `provider`: OpenClaw provider id (for example `openai`, `anthropic`)
- `strategy`: `highest_quota` (default) or `latest_seen`

## Security notes

- Never commit `data/` and real `config/sites.json`.
- Rotate tokens and API keys regularly.
- Keep `KEYHUB_MASTER_KEY` outside repo and logs.
- Treat third-party adapters as untrusted code.
- If a site enforces CAPTCHA/Turnstile/OAuth interactive approval, full zero-touch login is not guaranteed; keep a manual approval fallback.
