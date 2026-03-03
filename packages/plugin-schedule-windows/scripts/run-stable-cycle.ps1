param(
  [string]$WorkDir = "D:\workspace\project\claw\packages\core",
  [string]$OpenClawConfig = "C:\Users\KSG\.openclaw\openclaw.json",
  [string]$OpenClawCli = "C:\Users\KSG\openclaw\dist\index.js",
  [int]$Retry = 3,
  [int]$RetryDelayMs = 5000,
  [int]$MinApplied = 1,
  [switch]$NotifyFeishu = $true,
  [string]$FeishuAccount = "main",
  [string]$FeishuTarget = "",
  [switch]$RequireNotifySuccess = $false
)

$ErrorActionPreference = "Stop"
Set-Location $WorkDir

if (-not $env:KEYHUB_MASTER_KEY) {
  $env:KEYHUB_MASTER_KEY = [Environment]::GetEnvironmentVariable("KEYHUB_MASTER_KEY", "User")
}
if (-not $env:KEYHUB_MASTER_KEY) {
  throw "KEYHUB_MASTER_KEY is missing. Set process env or User env first."
}

$logDir = Join-Path $WorkDir "data\logs"
New-Item -Path $logDir -ItemType Directory -Force | Out-Null
$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$logPath = Join-Path $logDir "stable-cycle-$timestamp.log"

Write-Output "Running stable cycle..."
Write-Output "Log: $logPath"

& node src/stable-cycle.mjs `
  --openclaw-config "$OpenClawConfig" `
  --retry "$Retry" `
  --retry-delay-ms "$RetryDelayMs" `
  --min-applied "$MinApplied" 2>&1 | Tee-Object -FilePath $logPath

if ($LASTEXITCODE -ne 0) {
  throw "stable-cycle failed with exit code $LASTEXITCODE"
}

if ($NotifyFeishu) {
  if (-not $FeishuTarget) {
    $FeishuTarget = $env:OPENCLAW_FEISHU_TARGET
  }
  if (-not $FeishuTarget) {
    $FeishuTarget = "ou_7325bf2241781b2bb1381bd473c08c4f"
  }

  $reportPath = Join-Path $WorkDir "data\stable-cycle-report.json"
  if (-not (Test-Path $reportPath)) {
    $notifyMsg = "[OpenClaw Daily] completed but report file not found. time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')"
  } else {
    $report = Get-Content $reportPath -Raw | ConvertFrom-Json
    $status = if ($report.status) { [string]$report.status } else { "unknown" }
    $synced = if ($report.final -and $null -ne $report.final.syncedSites) { [int]$report.final.syncedSites } else { 0 }
    $failed = if ($report.final -and $null -ne $report.final.failedSites) { [int]$report.final.failedSites } else { 0 }
    $applied = if ($report.final -and $report.final.appliedProviders) { @($report.final.appliedProviders).Count } else { 0 }
    $generatedAt = if ($report.generatedAt) { [string]$report.generatedAt } else { (Get-Date -Format "s") }
    $notifyMsg = "[OpenClaw Daily] status: $status`ntime: $generatedAt`nsynced_sites: $synced`nfailed_sites: $failed`napplied_providers: $applied`nlog: $logPath"
  }

  & node $OpenClawCli message send `
    --channel feishu `
    --account $FeishuAccount `
    --target $FeishuTarget `
    --message $notifyMsg `
    --json | Out-Null

  if ($LASTEXITCODE -ne 0) {
    $notifyErr = "Feishu notify failed. account=$FeishuAccount target=$FeishuTarget"
    Add-Content -Path $logPath -Value $notifyErr
    if ($RequireNotifySuccess) {
      throw $notifyErr
    }
    Write-Warning $notifyErr
  } else {
    $notifyOk = "Feishu notify sent. target=$FeishuTarget"
    Add-Content -Path $logPath -Value $notifyOk
    Write-Output $notifyOk
  }
}

Write-Output "Stable cycle completed."
