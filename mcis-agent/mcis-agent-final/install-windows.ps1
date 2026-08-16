# Run this once after building/downloading mcis-agent.exe
# Adds it to Windows Startup so it launches automatically on login

$exePath = "$PSScriptRoot\mcis-agent-win.exe"
$startupFolder = [Environment]::GetFolderPath('Startup')
$shortcutPath = Join-Path $startupFolder "MCIS Agent.lnk"

$WScriptShell = New-Object -ComObject WScript.Shell
$shortcut = $WScriptShell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $exePath
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 7  # minimized
$shortcut.Save()

Write-Host "MCIS Agent will now start automatically when you log in to Windows."
Write-Host "To start it right now, run: $exePath"
