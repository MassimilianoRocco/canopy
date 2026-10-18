# Installs Canopy as a Claude Code plugin read from this folder.
# Afterwards: claude plugin disable canopy / claude plugin enable canopy
$here = $PSScriptRoot

$claude = (Get-Command claude -ErrorAction SilentlyContinue).Source
if (-not $claude) {
  # The desktop app keeps its own copy of the CLI
  $claude = Get-ChildItem "$env:APPDATA\Claude\claude-code" -Recurse -Filter claude.exe -ErrorAction SilentlyContinue |
    Sort-Object LastWriteTime -Descending | Select-Object -First 1 -ExpandProperty FullName
}
if (-not $claude) {
  Write-Host 'Claude Code not found: install the desktop app or the CLI, then run this again.'
  exit 1
}

& $claude plugin marketplace add $here
& $claude plugin install canopy@canopy
if ($LASTEXITCODE -ne 0) {
  Write-Host 'The install did not go through: see the message above.'
  exit 1
}

Write-Host ''
Write-Host 'Done. Restart the app and type /canopy in a session.'
Write-Host 'Keep this folder where it is: the plugin is read from here.'
