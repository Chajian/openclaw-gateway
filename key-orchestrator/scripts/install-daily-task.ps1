param(
  [string]$TaskName = "OpenClaw-KeyOrchestrator-StableDaily",
  [string]$RunAt = "09:10",
  [string]$WorkDir = "D:\workspace\project\claw\key-orchestrator",
  [string]$OpenClawConfig = "C:\Users\KSG\.openclaw\openclaw.json",
  [string]$FeishuAccount = "main",
  [string]$FeishuTarget = "ou_7325bf2241781b2bb1381bd473c08c4f"
)

$ErrorActionPreference = "Stop"

$runner = Join-Path $WorkDir "scripts\run-stable-cycle.ps1"
if (-not (Test-Path $runner)) {
  throw "Runner script not found: $runner"
}

# Persist notification target in user env to avoid schtasks /TR length limit.
[Environment]::SetEnvironmentVariable("OPENCLAW_FEISHU_TARGET", $FeishuTarget, "User")

# Keep scheduled task command short (Windows /TR has 261-char limit).
$taskCmd = "powershell -NoProfile -ExecutionPolicy Bypass -File `"$runner`""

Write-Output "Creating/updating scheduled task: $TaskName"
schtasks /Create /TN "$TaskName" /SC DAILY /ST "$RunAt" /TR "$taskCmd" /F | Out-Null

if ($LASTEXITCODE -ne 0) {
  throw "Failed to create scheduled task."
}

Write-Output "Task installed."
Write-Output "Run once now: schtasks /Run /TN `"$TaskName`""
Write-Output "Query task:  schtasks /Query /TN `"$TaskName`" /V /FO LIST"
