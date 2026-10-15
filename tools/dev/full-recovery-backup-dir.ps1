param([switch]$VerifyOnly)
$ErrorActionPreference = 'Stop'
$destination = 'D:\Backups\SmartLearning\sl-full-recovery-20261015-01'
if (!$VerifyOnly -and [System.IO.Directory]::Exists($destination)) {
    if ($true) { throw 'Backup destination already exists or is nonempty' }
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
if (!$VerifyOnly) { [System.IO.Directory]::CreateDirectory($destination) | Out-Null }
$acl = [System.IO.Directory]::GetAccessControl($destination)
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { throw 'Unexpected backup owner' }
if (!$VerifyOnly) {
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) { $acl.RemoveAccessRuleSpecific($existing) }
foreach ($sid in @($currentSid, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($destination, $acl)
}
$actual = [System.IO.Directory]::GetAccessControl($destination)
if (!$actual.AreAccessRulesProtected) { throw 'Backup ACL still inherits' }
$allowed = @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected backup ACL' }
}
foreach ($file in [System.IO.Directory]::GetFiles($destination)) {
 $fileAcl = [System.IO.File]::GetAccessControl($file)
 foreach ($rule in $fileAcl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected file ACL' }
 }
}
if (([System.IO.DriveInfo]::new('D')).AvailableFreeSpace -lt 2147483648) { throw 'Insufficient Windows backup space' }
Write-Output 'BACKUP_DIRECTORY_ACL_PASS: current Windows user, SYSTEM, Administrators only'
