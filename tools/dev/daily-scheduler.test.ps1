$ErrorActionPreference='Stop'
. (Join-Path $PSScriptRoot 'daily-backup-windows.ps1') -Action Library
$now=[DateTimeOffset]::Parse('2026-10-15T12:00:00Z')
function Check($condition,[string]$message) { if (!$condition) { throw $message } }
$attempt=@{startedUTC=$now.ToString('o');status='PASS'}
$events=Get-Health $now $null $null $null
Check ('never-succeeded' -in $events -and 'schedule-missed' -in $events) 'Never-run regression'
$events=Get-Health $now $now.AddHours(-25) $attempt $null
Check ('backup-risk-24h' -in $events -and 'backup-expired-26h' -notin $events) '24h threshold regression'
$events=Get-Health $now $now.AddHours(-27) $attempt $null
Check ('backup-expired-26h' -in $events) '26h regression'
$attempt.status='FAIL'
$events=Get-Health $now $now $attempt $null
Check ('execution-failed' -in $events) 'Failure regression'
$attempt.status='PASS'
$healthy=Get-Health $now $now $attempt $null
Check ('execution-failed' -notin $healthy -and 'backup-expired-26h' -notin $healthy) 'Recovery regression'
Check ($healthy.Count -eq 0) 'Cancelled copy must not degrade healthy backup'
$events=Get-Health $now $now.AddHours(1) $attempt $null
Check ('invalid-future-snapshot' -in $events) 'Future timestamp regression'
$attempt.status='RUNNING'; $attempt.startedUTC=$now.AddMinutes(-21).ToString('o')
$events=Get-Health $now $now $attempt $null
Check ('execution-overdue' -in $events) 'Hung runner regression'
$errors=$null; $tokens=$null
[Management.Automation.Language.Parser]::ParseFile((Join-Path $PSScriptRoot 'daily-backup-windows.ps1'),[ref]$tokens,[ref]$errors) | Out-Null
Check ($errors.Count -eq 0) 'PowerShell parser regression'
# Exercise durable local notifications using isolated Windows temp state only.
$script:Control=Join-Path $env:TEMP ('sl-watch-test-'+[guid]::NewGuid().ToString('N'))
[IO.Directory]::CreateDirectory($script:Control) | Out-Null
$originalSnapshot=${function:Get-Snapshot}
function Get-Snapshot { return [DateTimeOffset]::UtcNow.AddMinutes(-1) }
Write-State 'attempt.json' @{startedUTC=[DateTimeOffset]::UtcNow.ToString('o');status='FAIL'}
$null=Invoke-Watch
$n=Read-State 'notification.json'
Check ('execution-failed' -in $n.raised) 'Durable failure notification'
$count=@(Get-ChildItem -LiteralPath $script:Control -Filter 'event-*.json').Count
$null=Invoke-Watch
Check (@(Get-ChildItem -LiteralPath $script:Control -Filter 'event-*.json').Count -eq $count) 'Notification deduplication'
Write-State 'attempt.json' @{startedUTC=[DateTimeOffset]::UtcNow.ToString('o');status='PASS'}
$null=Invoke-Watch
Check ('execution-failed' -in (Read-State 'notification.json').recovered) 'Durable recovery notification'
Write-State 'watchdog.json' @{active=@('second-copy-unverified')}
$code=Invoke-Watch
Check ($code -eq 0) 'Cancelled copy healthy exit'
Check ('second-copy-unverified' -in (Read-State 'notification.json').recovered) 'Historical second-copy warning recovered'
$policy=Read-State 'watchdog.json'
Check ($policy.secondCopyPolicy -eq 'cancelled' -and !$policy.secondCopyRequired) 'Explicit cancelled policy'
$count=@(Get-ChildItem -LiteralPath $script:Control -Filter 'event-*.json').Count
$null=Invoke-Watch
Check (@(Get-ChildItem -LiteralPath $script:Control -Filter 'event-*.json').Count -eq $count) 'Policy recovery deduplicated'
[IO.File]::WriteAllText((Join-Path $script:Control 'watchdog.json'),'{invalid')
$null=Invoke-Watch
Check ('watchdog-state-corrupt' -in (Read-State 'notification.json').raised) 'Corrupt state notification'
${function:Get-Snapshot}=$originalSnapshot
$script:BackupRoot=Join-Path $script:Control 'nonexistent-backup-drive-fixture'
$null=Invoke-Watch
Check ('verification-or-state-failed' -in (Read-State 'notification.json').raised) 'Missing backup mount independent notification'
Write-Output ('PASS: native policy and watchdog checks; isolated test state retained at '+$script:Control)
