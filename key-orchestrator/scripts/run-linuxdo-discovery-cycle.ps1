param(
  [string]$WorkDir = "D:\workspace\project\claw\key-orchestrator",
  [string]$OpenClawCli = "C:\Users\KSG\openclaw\dist\index.js",
  [string]$BrowserProfile = "openclaw",
  [int]$MaxTopics = 20,
  [switch]$ResetLinuxdo = $false,
  [switch]$IncludeUnlikely = $false,
  [string]$BlockedHosts = "ai.zhansi.top",
  [int]$OnboardLimit = 5,
  [int]$OnboardMaxPoll = 10,
  [int]$OnboardPollIntervalMs = 3000,
  [int]$FailureThreshold = 3,
  [int]$StepRetry = 2,
  [int]$StepRetryDelayMs = 3000,
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
$logPath = Join-Path $logDir "linuxdo-cycle-$timestamp.log"

$discoverOut = Join-Path $WorkDir "data\linuxdo-public-sites.json"
$upsertReport = Join-Path $WorkDir "data\linuxdo-site-upsert-report.json"
$onboardReport = Join-Path $WorkDir "data\linuxdo-onboard-report.json"
$failureStatePath = Join-Path $WorkDir "data\linuxdo-onboard-failure-state.json"
$configPath = Join-Path $WorkDir "config\sites.json"

$stepStatus = @{
  discover = "pending"
  upsert   = "pending"
  onboard  = "pending"
}
$overallStatus = "ok"
$failureReason = ""

function Run-Step {
  param(
    [string]$Name,
    [string[]]$Cmd
  )
  $attempt = 0
  while ($attempt -lt $StepRetry) {
    $attempt += 1
    Add-Content -Path $logPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] step=$Name attempt=$attempt/$StepRetry command=$($Cmd -join ' ')"
    & $Cmd[0] $Cmd[1..($Cmd.Length - 1)] 2>&1 | Tee-Object -FilePath $logPath -Append
    if ($LASTEXITCODE -eq 0) {
      return
    }
    if ($attempt -lt $StepRetry) {
      Add-Content -Path $logPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] step=$Name attempt=$attempt failed; retry after ${StepRetryDelayMs}ms"
      Start-Sleep -Milliseconds $StepRetryDelayMs
    }
  }
  throw "$Name failed with exit code $LASTEXITCODE after $StepRetry attempt(s)"
}

if ($StepRetry -lt 1) {
  $StepRetry = 1
}
if ($StepRetryDelayMs -lt 0) {
  $StepRetryDelayMs = 0
}

function Read-JsonOrNull {
  param([string]$Path)
  if (-not (Test-Path $Path)) {
    return $null
  }
  try {
    return (Get-Content $Path -Raw | ConvertFrom-Json)
  } catch {
    return $null
  }
}

function Read-JsonOrDefault {
  param(
    [string]$Path,
    $DefaultValue
  )
  $loaded = Read-JsonOrNull -Path $Path
  if ($null -eq $loaded) {
    return $DefaultValue
  }
  return $loaded
}

function Write-JsonFile {
  param(
    [string]$Path,
    $Data
  )
  $json = $Data | ConvertTo-Json -Depth 20
  Set-Content -Path $Path -Value $json -Encoding UTF8
}

function Update-OnboardFailureStateAndMaybeDisable {
  param(
    $OnboardReportObj,
    [string]$StatePath,
    [string]$SitesConfigPath,
    [int]$Threshold
  )

  $defaultState = [pscustomobject]@{
    version = 1
    updatedAt = ""
    entries = @()
  }
  $state = Read-JsonOrDefault -Path $StatePath -DefaultValue $defaultState
  if ($null -eq $state.entries) {
    $state | Add-Member -NotePropertyName entries -NotePropertyValue @() -Force
  }

  $results = @()
  if ($OnboardReportObj -and $OnboardReportObj.results) {
    $results = @($OnboardReportObj.results)
  }

  $disableCandidates = New-Object System.Collections.Generic.HashSet[string]
  foreach ($result in $results) {
    $siteId = [string]$result.siteId
    if ([string]::IsNullOrWhiteSpace($siteId)) {
      continue
    }
    $status = [string]$result.status
    $reason = [string]$result.reason

    $entry = @($state.entries | Where-Object { $_.siteId -eq $siteId } | Select-Object -First 1)
    if ($entry.Count -eq 0) {
      $newEntry = [pscustomobject]@{
        siteId = $siteId
        streak = 0
        lastStatus = ""
        lastReason = ""
        updatedAt = ""
      }
      $state.entries += $newEntry
      $entry = @($newEntry)
    }
    $item = $entry[0]

    if ($status -eq "success") {
      $item.streak = 0
    } else {
      $item.streak = [int]$item.streak + 1
    }
    $item.lastStatus = $status
    $item.lastReason = $reason
    $item.updatedAt = (Get-Date).ToString("s")

    if ($status -ne "success" -and [int]$item.streak -ge $Threshold) {
      [void]$disableCandidates.Add($siteId)
    }
  }

  $autoDisabled = @()
  if ((Test-Path $SitesConfigPath) -and $disableCandidates.Count -gt 0) {
    $cfg = Get-Content -Path $SitesConfigPath -Raw | ConvertFrom-Json
    foreach ($site in @($cfg.sites)) {
      if ($null -eq $site) { continue }
      $siteId = [string]$site.id
      if (-not $disableCandidates.Contains($siteId)) { continue }
      if ($site.type -ne "new-api") { continue }
      $from = ""
      if ($site.PSObject.Properties["discovery"]) {
        $from = [string]$site.discovery.from
      }
      if ($from -ne "linuxdo-rss") { continue }
      if ($site.enabled -eq $false) { continue }

      $site.enabled = $false
      if (-not $site.PSObject.Properties["autoDisable"]) {
        $site | Add-Member -NotePropertyName autoDisable -NotePropertyValue ([pscustomobject]@{}) -Force
      }
      $site.autoDisable.reason = "onboard_failure_streak"
      $site.autoDisable.threshold = $Threshold
      $site.autoDisable.disabledAt = (Get-Date).ToString("s")
      $autoDisabled += $siteId
    }
    if ($autoDisabled.Count -gt 0) {
      Write-JsonFile -Path $SitesConfigPath -Data $cfg
    }
  }

  $state.updatedAt = (Get-Date).ToString("s")
  Write-JsonFile -Path $StatePath -Data $state

  return [pscustomobject]@{
    autoDisabled = $autoDisabled
  }
}

try {
  Run-Step -Name "discover" -Cmd @(
    "node", "src/discover-linuxdo-public-sites.mjs",
    "--out", $discoverOut,
    "--browser-profile", $BrowserProfile,
    "--openclaw-cli", $OpenClawCli,
    "--max-topics", "$MaxTopics"
  )
  $stepStatus.discover = "ok"

  $upsertArgs = @(
    "node", "src/upsert-sites-from-discovery.mjs",
    "--discovery", $discoverOut,
    "--report", $upsertReport
  )
  if ($ResetLinuxdo) {
    $upsertArgs += @("--reset-linuxdo", "true")
  }
  if ($IncludeUnlikely) {
    $upsertArgs += @("--include-unlikely", "true")
  }
  if ($BlockedHosts) {
    $upsertArgs += @("--blocked-hosts", $BlockedHosts)
  }
  Run-Step -Name "upsert" -Cmd $upsertArgs
  $stepStatus.upsert = "ok"

  Run-Step -Name "onboard" -Cmd @(
    "node", "src/onboard-linuxdo-oauth-sites.mjs",
    "--report", $upsertReport,
    "--out", $onboardReport,
    "--openclaw-cli", $OpenClawCli,
    "--browser-profile", $BrowserProfile,
    "--limit", "$OnboardLimit",
    "--max-poll", "$OnboardMaxPoll",
    "--poll-interval-ms", "$OnboardPollIntervalMs"
  )
  $stepStatus.onboard = "ok"
} catch {
  $overallStatus = "failed"
  $failureReason = $_.Exception.Message
  if ($stepStatus.discover -eq "pending") { $stepStatus.discover = "failed" }
  elseif ($stepStatus.upsert -eq "pending") { $stepStatus.upsert = "failed" }
  elseif ($stepStatus.onboard -eq "pending") { $stepStatus.onboard = "failed" }
  Add-Content -Path $logPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] cycle failed: $failureReason"
}

$discover = Read-JsonOrNull -Path $discoverOut
$upsert = Read-JsonOrNull -Path $upsertReport
$onboard = Read-JsonOrNull -Path $onboardReport

$sitesDiscovered = if ($discover -and $discover.stats -and $null -ne $discover.stats.sitesDiscovered) { [int]$discover.stats.sitesDiscovered } else { 0 }
$topicsScanned = if ($discover -and $discover.stats -and $null -ne $discover.stats.topicsScanned) { [int]$discover.stats.topicsScanned } else { 0 }
$candidates = if ($upsert -and $upsert.summary -and $null -ne $upsert.summary.candidates) { [int]$upsert.summary.candidates } else { 0 }
$sitesCreated = if ($upsert -and $upsert.summary -and $null -ne $upsert.summary.sitesCreated) { [int]$upsert.summary.sitesCreated } else { 0 }
$sitesUpdated = if ($upsert -and $upsert.summary -and $null -ne $upsert.summary.sitesUpdated) { [int]$upsert.summary.sitesUpdated } else { 0 }
$onboardingNeeded = if ($upsert -and $upsert.summary -and $null -ne $upsert.summary.onboardingNeeded) { [int]$upsert.summary.onboardingNeeded } else { 0 }
$onboardSuccess = if ($onboard -and $onboard.summary -and $null -ne $onboard.summary.success) { [int]$onboard.summary.success } else { 0 }
$onboardManual = if ($onboard -and $onboard.summary -and $null -ne $onboard.summary.manualRequired) { [int]$onboard.summary.manualRequired } else { 0 }
$onboardFailed = if ($onboard -and $onboard.summary -and $null -ne $onboard.summary.failed) { [int]$onboard.summary.failed } else { 0 }
$autoDisabledSites = @()
if ($FailureThreshold -lt 1) {
  $FailureThreshold = 1
}
try {
  $disableResult = Update-OnboardFailureStateAndMaybeDisable `
    -OnboardReportObj $onboard `
    -StatePath $failureStatePath `
    -SitesConfigPath $configPath `
    -Threshold $FailureThreshold
  if ($disableResult -and $disableResult.autoDisabled) {
    $autoDisabledSites = @($disableResult.autoDisabled)
  }
} catch {
  Add-Content -Path $logPath -Value "[$(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')] warning: auto-disable step failed: $($_.Exception.Message)"
}

if ($NotifyFeishu) {
  if (-not $FeishuTarget) {
    $FeishuTarget = $env:OPENCLAW_FEISHU_TARGET
  }
  if (-not $FeishuTarget) {
    $FeishuTarget = "ou_7325bf2241781b2bb1381bd473c08c4f"
  }

  $notifyMsg = @(
    "[OpenClaw LinuxDo Daily]",
    "status: $overallStatus",
    "time: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')",
    "step_discover: $($stepStatus.discover)",
    "step_upsert: $($stepStatus.upsert)",
    "step_onboard: $($stepStatus.onboard)",
    "topics_scanned: $topicsScanned",
    "sites_discovered: $sitesDiscovered",
    "upsert_candidates: $candidates",
    "sites_created: $sitesCreated",
    "sites_updated: $sitesUpdated",
    "onboarding_needed: $onboardingNeeded",
    "onboard_success: $onboardSuccess",
    "onboard_manual_required: $onboardManual",
    "onboard_failed: $onboardFailed",
    "auto_disabled_sites: $($autoDisabledSites.Count)",
    "log: $logPath"
  )
  if ($autoDisabledSites.Count -gt 0) {
    $notifyMsg += "auto_disabled_list: $($autoDisabledSites -join ',')"
  }
  if ($failureReason) {
    $notifyMsg += "error: $failureReason"
  }
  $notifyText = $notifyMsg -join "`n"

  & node $OpenClawCli message send `
    --channel feishu `
    --account $FeishuAccount `
    --target $FeishuTarget `
    --message $notifyText `
    --json | Out-Null

  if ($LASTEXITCODE -ne 0) {
    $notifyErr = "Feishu notify failed. account=$FeishuAccount target=$FeishuTarget"
    Add-Content -Path $logPath -Value $notifyErr
    if ($RequireNotifySuccess) {
      throw $notifyErr
    }
    Write-Warning $notifyErr
  } else {
    Add-Content -Path $logPath -Value "Feishu notify sent. target=$FeishuTarget"
  }
}

if ($overallStatus -ne "ok") {
  throw "linuxdo cycle failed: $failureReason"
}

Write-Output "Linuxdo discovery cycle completed."
Write-Output "Log: $logPath"
