param([ValidateRange(1,65535)][int]$Port = 8000)
$ErrorActionPreference = 'Stop'
$hostRoot = Join-Path (Split-Path -Parent $PSScriptRoot) 'host'
. (Join-Path $PSScriptRoot 'python_runtime.ps1')
$runtime = Get-HostPython -HostRoot $hostRoot
$venvPython = Join-Path $hostRoot '.venv\Scripts\python.exe'
Push-Location -LiteralPath $hostRoot
try {
    if (-not (Test-Path -LiteralPath $venvPython -PathType Leaf)) {
        & $runtime.File @($runtime.Prefix) -m venv .venv
        if ($LASTEXITCODE -ne 0) { throw 'Could not create host/.venv. Check that the selected Python includes the venv module.' }
    }
    $dependencyProbe = @'
try:
    import sys
    import fastapi, uvicorn, serial
    if sys.platform == "win32":
        import pythoncom
except Exception:
    raise SystemExit(1)
'@
    $dependenciesReady = $false
    try {
        & $venvPython -c $dependencyProbe
        $dependenciesReady = $LASTEXITCODE -eq 0
    }
    catch { }
    if (-not $dependenciesReady) {
        & $venvPython -m pip install -r requirements.txt
        if ($LASTEXITCODE -ne 0) { throw 'Could not install host/requirements.txt. Check the network and pip error above.' }
    }
    Write-Host "IMU dashboard: http://127.0.0.1:$Port"
    & $venvPython -B -X utf8 run_dashboard.py --port $Port
    if ($LASTEXITCODE -ne 0) { throw 'Dashboard stopped with an error. Inspect the message above.' }
}
finally { Pop-Location }
