# OpenClaw + LinuxDO OAuth API Key Runbook

## Goal
Use OpenClaw Browser Relay with your local browser session to:
1. Log in to a target site (example: `stephecurry.asia`) via LinuxDO OAuth
2. Return to the site console after OAuth approval
3. Read and return site API keys

## Preconditions
1. Chrome has OpenClaw extension installed and connected (no red `!`)
2. OpenClaw gateway/relay is running (example: gateway `19089`, relay `19092`)
3. Browser can access LinuxDO OAuth page (`connect.linux.do`)

## Quick health check
```powershell
$token = "<OPENCLAW_GATEWAY_TOKEN>"
Invoke-WebRequest -UseBasicParsing http://127.0.0.1:19092/extension/status `
  -Headers @{ "x-openclaw-relay-token" = $token } |
  Select-Object -ExpandProperty Content
```

Expected response:
```json
{"connected":true}
```

## Standard flow (example: stephecurry.asia)
1. Open `https://stephecurry.asia/login`
2. Start LinuxDO OAuth (`/oauth/linuxdo` -> `connect.linux.do/oauth2/authorize...`)
3. On `connect.linux.do`, click `Allow` (or open `.../oauth2/approve/...`)
4. Confirm callback is `https://stephecurry.asia/console/token`
5. Confirm `localStorage.user` exists
6. Read user id from `JSON.parse(localStorage.user).id`
7. Call APIs with header `New-Api-User: <id>`:
   - `/api/user/self`
   - `/api/token/?p=0&size=100`
8. Read keys from `data.items[].key`

## API constraint
This site requires header `New-Api-User` for user/token endpoints.
Without it, API returns 401.

Example:
```json
{"success":false,"message":"unauthorized: missing New-Api-User"}
```

## Verified result (2026-02-28)
User id: `183`

Captured keys:
1. `claw` -> `dRuLmv0GRoia4OYCAUldGPwqcnAyfsFwDfmECriarMsQUGJz`
2. `docker` -> `KzZlKBcGYU1Nf1gL6NJVr5OupHMDnZuKOnvXGVTh2XYSqdO3`

## Troubleshooting
1. Extension shows red `!`
   - Verify relay port and gateway token match extension settings
   - Recheck extension options: port `19092`, correct gateway token
2. Click on LinuxDO login does nothing
   - Frontend may use `window.open` and popup is blocked
   - Use direct navigation to `/oauth/linuxdo` or direct OAuth URL via `location.href`
3. OAuth page opens but no callback
   - Click `Allow`
   - Or open `.../oauth2/approve/<id>` directly
4. Callback succeeded but API is 401
   - Ensure header `New-Api-User: <localStorage.user.id>` is present
   - Ensure you are logged in (`localStorage.user` exists)

## Security notes
1. Do not commit API keys to a public repository
2. Store keys only in local private config (for example `~/.openclaw/openclaw.json`)
3. If a key leaks, revoke it from token console and create a new one
