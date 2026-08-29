param(
  [ValidateSet('none', 'claude-code', 'codex', 'opencode')]
  [string]$Client = 'none',
  [switch]$Configure,
  [switch]$Replace,
  [switch]$SkipInstall,
  [string]$DatabasePath,
  [string]$ConfigPath
)

$ErrorActionPreference = 'Stop'
$releaseRoot = Split-Path -Parent $PSScriptRoot
Push-Location $releaseRoot
try {
  $nodeMajor = [int](node -p "Number(process.versions.node.split('.')[0])")
  if ($LASTEXITCODE -ne 0 -or $nodeMajor -lt 22) { throw 'Node.js 22 or newer is required.' }

  if (-not $SkipInstall) {
    npm ci
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  }
  npm run typecheck
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npm test
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
  npm run build
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }

  if ($Client -eq 'none') {
    Write-Output 'Setup verified. No client configuration was changed.'
    exit 0
  }

  $renderArgs = @('scripts/render-client-config.mjs', '--client', $Client)
  if ($DatabasePath) { $renderArgs += @('--db', $DatabasePath) }
  if ($Configure) { $renderArgs += '--write' }
  if ($Replace) { $renderArgs += '--replace' }
  if ($ConfigPath) { $renderArgs += @('--config', $ConfigPath) }
  & node @renderArgs
  exit $LASTEXITCODE
} finally {
  Pop-Location
}
