@echo off
chcp 65001 >nul
setlocal
set "CODEX_USAGE_INSTALLER=%~f0"

powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -Command "$marker = '# CODEX_USAGE_' + 'POWERSHELL'; $source = Get-Content -Raw -LiteralPath $env:CODEX_USAGE_INSTALLER; $index = $source.LastIndexOf($marker); if ($index -lt 0) { throw 'Installer payload was not found.' }; $payload = $source.Substring($index + $marker.Length); & ([scriptblock]::Create($payload))"
set "exitCode=%ERRORLEVEL%"

if not "%exitCode%"=="0" (
  echo.
  echo Codex-Usage installation failed. See the error above.
  pause
)

exit /b %exitCode%

# CODEX_USAGE_POWERSHELL
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

$repository = 'Oblivionis-ling/Codex-Usage'
$installDirectory = Join-Path $env:LOCALAPPDATA 'Codex-Usage'
$installedExecutable = Join-Path $installDirectory 'Codex-Usage.exe'
$temporaryDirectory = Join-Path $env:TEMP ("Codex-Usage-Install-" + [Guid]::NewGuid().ToString('N'))
$headers = @{
  Accept = 'application/vnd.github+json'
  'User-Agent' = 'Codex-Usage-Installer'
  'X-GitHub-Api-Version' = '2022-11-28'
}

function Stop-InstalledApp {
  param([string]$ExecutablePath)

  foreach ($process in Get-Process -ErrorAction SilentlyContinue) {
    try {
      if ($process.Path -and [string]::Equals($process.Path, $ExecutablePath, [StringComparison]::OrdinalIgnoreCase)) {
        Stop-Process -Id $process.Id -Force
      }
    } catch {
      # Processes whose paths cannot be inspected are unrelated and can be ignored.
    }
  }
}

function Copy-LegacyPreferences {
  $newDataDirectory = Join-Path $env:APPDATA 'Codex-Usage'
  if (Test-Path -LiteralPath $newDataDirectory) { return }

  foreach ($legacyName in @('codexu-windows', 'CodexU Windows')) {
    $legacyDirectory = Join-Path $env:APPDATA $legacyName
    if (-not (Test-Path -LiteralPath $legacyDirectory)) { continue }

    New-Item -ItemType Directory -Path $newDataDirectory -Force | Out-Null
    foreach ($fileName in @('preferences.json', 'full-reset-history.json')) {
      $source = Join-Path $legacyDirectory $fileName
      if (Test-Path -LiteralPath $source) {
        Copy-Item -LiteralPath $source -Destination (Join-Path $newDataDirectory $fileName)
      }
    }
    return
  }
}

try {
  Write-Host 'Finding the newest Codex-Usage release...'
  $releases = @(Invoke-RestMethod -Uri "https://api.github.com/repos/$repository/releases?per_page=20" -Headers $headers)
  $release = $releases | Where-Object { -not $_.draft } | Select-Object -First 1
  if (-not $release) { throw 'No published release is available.' }

  $portableAsset = @($release.assets) |
    Where-Object { $_.name -match '^Codex-Usage-.+-portable\.exe$' } |
    Select-Object -First 1
  $checksumAsset = @($release.assets) |
    Where-Object { $_.name -eq 'SHA256SUMS.txt' } |
    Select-Object -First 1
  if (-not $portableAsset) { throw "Release $($release.tag_name) does not contain a Codex-Usage portable executable." }
  if (-not $checksumAsset) { throw "Release $($release.tag_name) does not contain SHA256SUMS.txt." }

  New-Item -ItemType Directory -Path $temporaryDirectory -Force | Out-Null
  $downloadedExecutable = Join-Path $temporaryDirectory $portableAsset.name
  $downloadedChecksums = Join-Path $temporaryDirectory 'SHA256SUMS.txt'

  Write-Host "Downloading Codex-Usage $($release.tag_name)..."
  Invoke-WebRequest -Uri $portableAsset.browser_download_url -OutFile $downloadedExecutable -Headers $headers -UseBasicParsing
  Invoke-WebRequest -Uri $checksumAsset.browser_download_url -OutFile $downloadedChecksums -Headers $headers -UseBasicParsing

  $checksumText = Get-Content -Raw -LiteralPath $downloadedChecksums
  $checksumPattern = '(?im)^([a-f0-9]{64})\s+\*?' + [regex]::Escape($portableAsset.name) + '\s*$'
  if ($checksumText -notmatch $checksumPattern) { throw "No checksum was found for $($portableAsset.name)." }
  $expectedHash = $Matches[1].ToUpperInvariant()
  $actualHash = (Get-FileHash -LiteralPath $downloadedExecutable -Algorithm SHA256).Hash.ToUpperInvariant()
  if ($actualHash -ne $expectedHash) { throw 'SHA256 verification failed. The downloaded file was not installed.' }

  New-Item -ItemType Directory -Path $installDirectory -Force | Out-Null
  Stop-InstalledApp -ExecutablePath $installedExecutable
  Move-Item -LiteralPath $downloadedExecutable -Destination $installedExecutable -Force
  Copy-LegacyPreferences

  $desktopDirectory = [Environment]::GetFolderPath('Desktop')
  $shortcutPath = Join-Path $desktopDirectory 'Codex-Usage.lnk'
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = $installedExecutable
  $shortcut.WorkingDirectory = $installDirectory
  $shortcut.Description = 'Codex usage desktop widget'
  $shortcut.Save()

  Write-Host "Installed to $installedExecutable"
  Write-Host "Desktop shortcut: $shortcutPath"
  Write-Host 'Startup launch was not enabled.'
  Start-Process -FilePath $installedExecutable
} finally {
  if (Test-Path -LiteralPath $temporaryDirectory) {
    Remove-Item -LiteralPath $temporaryDirectory -Recurse -Force -ErrorAction SilentlyContinue
  }
}
