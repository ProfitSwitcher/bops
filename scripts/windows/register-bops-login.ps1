# Registers a login task that starts the local worker and server on 127.0.0.1.
# Does nothing until you run it. Pass -Remove to delete the task.
param(
  [string]$Repo = (Resolve-Path (Join-Path $PSScriptRoot "..\..")).Path,
  [switch]$Remove
)
$Name = "Bops local"
if ($Remove) {
  schtasks /Delete /TN $Name /F
  exit $LASTEXITCODE
}
$node = (Get-Command node -ErrorAction SilentlyContinue).Source
if (-not $node) { throw "node is not on PATH" }
$worker = "set BOPS_WORKER_BIND=127.0.0.1&& set BOPS_WORKER_PORT=8791&& `"$node`" `"$Repo\workers\bops-local-worker.mjs`""
$server = "set HOSTNAME=127.0.0.1&& set PORT=3210&& `"$node`" `"$Repo\.next\standalone\server.js`""
$tr = "cmd /c `"$worker & $server`""
schtasks /Create /TN $Name /SC ONLOGON /RL LIMITED /F /TR $tr
Write-Host "Registered '$Name'. It listens on 127.0.0.1 only. Build with npx next build first. Remove with -Remove."
