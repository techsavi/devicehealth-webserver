# Registers the one Windows logon task for the local services: it runs `node serve.mjs start`,
# which starts the front Caddy server and every enabled service in services.json. No admin
# rights needed.
#
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1             # install and start now
#   powershell -ExecutionPolicy Bypass -File install-autostart.ps1 -Uninstall  # remove
#
# Stop the stack with `node serve.mjs stop`. Ending the task does nothing useful: `start` exits
# as soon as the stack is up, and the stack runs on detached from the task.

param([switch]$Uninstall)

$TaskName = 'Local services (webserver)'
$Root = $PSScriptRoot

if ($Uninstall) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false -ErrorAction SilentlyContinue
    Write-Host "Removed '$TaskName'. The stack keeps running until 'node serve.mjs stop'."
    return
}

$node = (Get-Command node -ErrorAction Stop).Source
$user = "$env:USERDOMAIN\$env:USERNAME"

# conhost --headless runs the console program without opening a window at logon.
$action = New-ScheduledTaskAction -Execute "$env:SystemRoot\System32\conhost.exe" `
    -Argument "--headless `"$node`" serve.mjs start" -WorkingDirectory $Root
$trigger = New-ScheduledTaskTrigger -AtLogOn -User $user
$settings = New-ScheduledTaskSettingsSet -ExecutionTimeLimit (New-TimeSpan -Minutes 5) -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries -StartWhenAvailable -MultipleInstances IgnoreNew `
    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId $user -LogonType Interactive -RunLevel Limited

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings -Principal $principal `
    -Description 'Front Caddy server on port 80 plus the services in services.json (StatusPanel, TabletPanel). Logs: .run\' -Force | Out-Null
Start-ScheduledTask -TaskName $TaskName
Write-Host "Installed '$TaskName' and started it."
