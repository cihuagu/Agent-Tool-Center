# Run from the project directory; this script does not modify system configuration.
$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
Set-Location $root
Write-Host "Project: $root"
Write-Host "Node: $(node --version)"
Write-Host "Git: $(git --version)"
Write-Host "Run test suite:"
npm test
if ($LASTEXITCODE -ne 0) { throw "Tests failed ($LASTEXITCODE)" }
Write-Host "All automated checks passed."
