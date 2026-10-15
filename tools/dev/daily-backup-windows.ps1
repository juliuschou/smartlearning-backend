param([ValidateSet('Review','Run','Watch','Install','Library')][string]$Action='Review', [switch]$SafeFailure)
$ErrorActionPreference='Stop'
$script:BackupRoot='D:\Backups\SmartLearning\daily-v1'
$script:Control='C:\Users\USER\AppData\Local\SmartLearningDailyBackup-v1'
$script:Repo='/home/user/projects/smartLearning/smartLearning-backend'
$script:Account='DESKTOP-0KADDT9\USER'
$script:Sid='S-1-5-21-2171058193-2806922946-1671614276-1000'
$script:TaskBackup='SmartLearning-DailyBackup-v1'
$script:TaskWatch='SmartLearning-DailyWatchdog-v1'
function Assert-Identity {
 if ([Security.Principal.WindowsIdentity]::GetCurrent().User.Value -ne $script:Sid) { throw 'Wrong Windows identity' }
 if ((Get-TimeZone).Id -ne 'Taipei Standard Time') { throw 'Wrong timezone' }
}
function Assert-NoReparse([string]$Path) {
 $cursor=$Path
 while ($cursor) {
  if (Test-Path -LiteralPath $cursor) {
   if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse path' }
  }
  $parent=[IO.Directory]::GetParent($cursor)
  $cursor=if ($parent) {$parent.FullName} else {$null}
 }
 }
function Assert-Directory([string]$Path) {
 Assert-NoReparse $Path
 $acl=[IO.Directory]::GetAccessControl($Path)
 if (!$acl.AreAccessRulesProtected -or $acl.GetOwner([Security.Principal.SecurityIdentifier]).Value -ne $script:Sid) { throw 'Unsafe ACL owner/inheritance' }
 $seen=@()
 foreach ($r in $acl.GetAccessRules($true,$true,[Security.Principal.SecurityIdentifier])) {
  if ($r.IdentityReference.Value -notin @($script:Sid,'S-1-5-18','S-1-5-32-544') -or $r.AccessControlType -ne 'Allow') { throw 'Unsafe ACL principal' }
  $seen+=$r.IdentityReference.Value
 }
 foreach ($sid in @($script:Sid,'S-1-5-18','S-1-5-32-544')) { if ($sid -notin $seen) { throw 'Missing ACL principal' } }
}
function Get-Hash([string]$Path) {
 $stream=[IO.File]::OpenRead($Path)
 $algorithm=[Security.Cryptography.SHA256]::Create()
 try { return [BitConverter]::ToString($algorithm.ComputeHash($stream)).Replace('-','').ToLowerInvariant() }
 finally { $algorithm.Dispose(); $stream.Dispose() }
}
function Write-State([string]$Name,$Value) {
 $tmp=Join-Path $script:Control ([guid]::NewGuid().ToString()+'.partial')
 [IO.File]::WriteAllText($tmp,($Value|ConvertTo-Json -Depth 12),[Text.UTF8Encoding]::new($false))
 $dest=Join-Path $script:Control $Name
 if (Test-Path -LiteralPath $dest) { [IO.File]::Replace($tmp,$dest,[NullString]::Value) } else { [IO.File]::Move($tmp,$dest) }
}
function Read-State([string]$Name) {
 $path=Join-Path $script:Control $Name
 if (Test-Path -LiteralPath $path) { return Get-Content -LiteralPath $path -Raw | ConvertFrom-Json }
 return $null
}
function Get-Health($Now,$Snapshot,$Attempt,$SecondCopy) {
 $events=@()
 if ($null -eq $Snapshot) { $events+='never-succeeded' }
 else {
  $age=($Now-$Snapshot).TotalHours
  if ($age -lt 0) { $events+='invalid-future-snapshot' }
  elseif ($age -gt 26) { $events+='backup-expired-26h' }
  elseif ($age -gt 24) { $events+='backup-risk-24h' }
 }
 if ($null -eq $Attempt -or ($Now-[DateTimeOffset]::Parse($Attempt.startedUTC)).TotalHours -gt 26) { $events+='schedule-missed' }
 elseif ($Attempt.status -eq 'FAIL') { $events+='execution-failed' }
 elseif ($Attempt.status -eq 'RUNNING' -and ($Now-[DateTimeOffset]::Parse($Attempt.startedUTC)).TotalMinutes -gt 20) { $events+='execution-overdue' }
 # Second copy is cancelled by policy; this does not assert a verified copy.
 return ,@($events | Sort-Object -Unique)
}
function Get-Snapshot {
 Assert-Directory $script:BackupRoot
 $latest=$null
 foreach ($dir in Get-ChildItem -LiteralPath $script:BackupRoot -Directory) {
  if ($dir.Name -notmatch '^sl-daily-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$') { continue }
  Assert-Directory $dir.FullName
  $manifestPath=Join-Path $dir.FullName 'success.json'
  if ((Get-Item -LiteralPath $manifestPath).Attributes -band [IO.FileAttributes]::ReparsePoint) { throw 'Reparse manifest' }
  $m=Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
  if ($m.owner -ne 'smartlearning-daily-v1' -or $m.version -ne 1 -or $m.run -ne $dir.Name -or $m.status -ne 'backup-verified') { throw 'Invalid manifest identity' }
  $expected=@('globals.sql','source-manifest.json','postgres.dump','postgres.toc','smartlearning_test.dump','smartlearning_test.toc')
  if (@($m.files.PSObject.Properties).Count -ne 6 -or @(Get-ChildItem -LiteralPath $dir.FullName -Force).Count -ne 7) { throw 'Invalid inventory' }
  foreach ($name in $expected) {
   $entry=$m.files.$name
   $file=Get-Item -LiteralPath (Join-Path $dir.FullName $name)
   if (!$entry -or $file.PSIsContainer -or ($file.Attributes -band [IO.FileAttributes]::ReparsePoint) -or $file.Length -ne $entry.bytes -or (Get-Hash $file.FullName) -ne $entry.sha256) { throw 'Invalid payload hash' }
  }
  if (@($m.snapshotUTC.PSObject.Properties).Count -ne 2 -or !$m.snapshotUTC.postgres -or !$m.snapshotUTC.smartlearning_test) { throw 'Invalid snapshots' }
  $stamps=@($m.snapshotUTC.PSObject.Properties | ForEach-Object {
   if ($_.Value -notmatch '(Z|[+-][0-9]{2}:[0-9]{2})$') { throw 'Naive snapshot timestamp' }
   $parsed=[DateTimeOffset]::Parse($_.Value)
   if ($parsed -gt [DateTimeOffset]::UtcNow) { throw 'Future snapshot timestamp' }
   $parsed
  } | Sort-Object)
  $stamp=$stamps[0]
  if ($null -eq $latest -or $stamp -gt $latest) { $latest=$stamp }
 }
 return $latest
}
function Invoke-Watch {
 $mutex=[Threading.Mutex]::new($false,'Local\SmartLearningDailyWatchdogV1')
 if (!$mutex.WaitOne(0)) { return 2 }
 try {
  $now=[DateTimeOffset]::UtcNow
  try { $snapshot=Get-Snapshot; $events=Get-Health $now $snapshot (Read-State 'attempt.json') $null }
  catch { $events=@('verification-or-state-failed') }
  try { $old=Read-State 'watchdog.json' } catch { $old=$null; $events=@($events)+@('watchdog-state-corrupt') }
  $previous=if ($old) {@($old.active)} else {@()}
  $raised=@($events | Where-Object { $_ -notin $previous })
  $recovered=@($previous | Where-Object { $_ -notin $events })
  if ($raised.Count -or $recovered.Count) {
   # Durable local notification. No outbound delivery is configured.
   $notification=@{atUTC=$now.ToString('o');raised=$raised;recovered=$recovered;channel='local-state-file'}
   Write-State ('event-'+$now.ToString('yyyyMMddTHHmmssZ')+'-'+[guid]::NewGuid().ToString('N')+'.json') $notification
   Write-State 'notification.json' $notification
  }
  Write-State 'watchdog.json' @{checkedUTC=$now.ToString('o');active=@($events);delivery='local-state-file';externalHeartbeat='not-configured';secondCopyPolicy='cancelled';secondCopyRequired=$false}
  if ($events.Count) { return 1 } else { return 0 }
 } finally { $mutex.ReleaseMutex(); $mutex.Dispose() }
}
if ($Action -eq 'Library') { return }
Assert-Identity
if ($Action -eq 'Review') {
 [pscustomobject]@{account=$script:Account;sid=$script:Sid;distro='Ubuntu';user='user';repo=$script:Repo;daily='20:00 Asia/Taipei';notify='local state file';tasks=@($script:TaskBackup,$script:TaskWatch)} | ConvertTo-Json
 exit 0
}
Assert-NoReparse $script:Control
if (!(Test-Path -LiteralPath $script:Control)) {
 [IO.Directory]::CreateDirectory($script:Control) | Out-Null
}
# Initialize only an empty dedicated directory for this fixed Windows user.
if (@(Get-ChildItem -LiteralPath $script:Control -Force).Count -eq 0) {
 $acl=[Security.AccessControl.DirectorySecurity]::new()
 $acl.SetOwner([Security.Principal.SecurityIdentifier]::new($script:Sid))
 $acl.SetAccessRuleProtection($true,$false)
 foreach ($allowedSid in @($script:Sid,'S-1-5-18','S-1-5-32-544')) {
  $acl.AddAccessRule([Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.SecurityIdentifier]::new($allowedSid),'FullControl','ContainerInherit,ObjectInherit','None','Allow'))
 }
 [IO.Directory]::SetAccessControl($script:Control,$acl)
}
Assert-Directory $script:Control
if ($Action -eq 'Run') {
 $runMutex=[Threading.Mutex]::new($false,'Local\SmartLearningDailyLauncherV1')
 if (!$runMutex.WaitOne(0)) { exit 2 }
 try {
 $attempt=[ordered]@{startedUTC=[DateTimeOffset]::UtcNow.ToString('o');status='RUNNING';exitCode=$null}
 Write-State 'attempt.json' $attempt
 $arguments=@('--distribution','Ubuntu','--user','user','--cd',$script:Repo,'--exec','/usr/bin/python3','-B','tools/dev/daily-scheduled-run.py')
 if ($SafeFailure) { $arguments+='--safe-preflight-failure' }
 try {
  # Python owns a 900-second deadline and the shared flock; no shell/profile or service startup.
  & 'C:\Windows\System32\wsl.exe' @arguments | Out-Null
  $code=$LASTEXITCODE
  $attempt.exitCode=$code
  $attempt.status=if ($code -eq 0) {'PASS'} else {'FAIL'}
 } catch { $code=1; $attempt.exitCode=1; $attempt.status='FAIL' }
 Write-State 'attempt.json' $attempt
 Write-State ('attempt-'+[DateTimeOffset]::UtcNow.ToString('yyyyMMddTHHmmssZ')+'-'+[guid]::NewGuid().ToString('N')+'.json') $attempt
 exit $code
 } finally { $runMutex.ReleaseMutex(); $runMutex.Dispose() }
}
if ($Action -eq 'Watch') { exit (Invoke-Watch) }
if ($Action -eq 'Install') {
 # Refuse ownership collisions instead of overwriting existing tasks.
 foreach ($name in @($script:TaskBackup,$script:TaskWatch)) {
  if (Get-ScheduledTask -TaskName $name -ErrorAction SilentlyContinue) { throw 'Task already exists; review exported definition before changes' }
 }
 $principal=New-ScheduledTaskPrincipal -UserId $script:Account -LogonType Interactive -RunLevel Limited
 $backupSettings=New-ScheduledTaskSettingsSet -Disable -StartWhenAvailable -MultipleInstances IgnoreNew -RestartCount 2 -RestartInterval (New-TimeSpan -Minutes 15) -ExecutionTimeLimit (New-TimeSpan -Minutes 20)
 $watchSettings=New-ScheduledTaskSettingsSet -Disable -StartWhenAvailable -MultipleInstances IgnoreNew -ExecutionTimeLimit (New-TimeSpan -Minutes 15)
 # Copy to Windows storage so watchdog does not depend on WSL availability.
 $scriptPath=Join-Path $script:Control 'daily-backup-windows.ps1'
 if (Test-Path -LiteralPath $scriptPath) { throw 'Installed script collision' }
 Copy-Item -LiteralPath $PSCommandPath -Destination $scriptPath
 if ((Get-Hash $PSCommandPath) -ne (Get-Hash $scriptPath)) { throw 'Installed script hash mismatch' }
 $exe='C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe'
 $backupAction=New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -NonInteractive -File "'+$scriptPath+'" -Action Run')
 $watchAction=New-ScheduledTaskAction -Execute $exe -Argument ('-NoProfile -NonInteractive -File "'+$scriptPath+'" -Action Watch')
 $daily=New-ScheduledTaskTrigger -Daily -At '20:00'
 $hourly=New-ScheduledTaskTrigger -Once -At (Get-Date).AddMinutes(1) -RepetitionInterval (New-TimeSpan -Hours 1)
 $login=New-ScheduledTaskTrigger -AtLogOn -User $script:Account
 Register-ScheduledTask -TaskName $script:TaskBackup -Action $backupAction -Trigger $daily -Principal $principal -Settings $backupSettings | Out-Null
 Register-ScheduledTask -TaskName $script:TaskWatch -Action $watchAction -Trigger @($hourly,$login) -Principal $principal -Settings $watchSettings | Out-Null
 foreach ($name in @($script:TaskBackup,$script:TaskWatch)) { Export-ScheduledTask -TaskName $name | Set-Content -LiteralPath (Join-Path $script:Control ($name+'.xml')) -Encoding UTF8 }
 # Both definitions and exports must exist before any backup can be scheduled.
 Enable-ScheduledTask -TaskName $script:TaskWatch | Out-Null
 Enable-ScheduledTask -TaskName $script:TaskBackup | Out-Null
 Write-Output 'INSTALLED; seven-day observation pending'
}
