param([switch]$RepairEmptyDirectory)
$ErrorActionPreference = 'Stop'
$destination = 'D:\Backups\SmartLearning\sl-c-20261013-01'
if ([System.IO.Directory]::Exists($destination)) {
    if (!$RepairEmptyDirectory -or [System.IO.Directory]::GetFileSystemEntries($destination).Length -ne 0) { throw 'Backup destination already exists or is nonempty' }
}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
[System.IO.Directory]::CreateDirectory($destination) | Out-Null
$acl = [System.IO.Directory]::GetAccessControl($destination)
if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { throw 'Unexpected backup owner' }
$acl.SetAccessRuleProtection($true, $false)
foreach ($existing in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) { $acl.RemoveAccessRuleSpecific($existing) }
foreach ($sid in @($currentSid, [System.Security.Principal.SecurityIdentifier]'S-1-5-18', [System.Security.Principal.SecurityIdentifier]'S-1-5-32-544')) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
}
[System.IO.Directory]::SetAccessControl($destination, $acl)
$actual = [System.IO.Directory]::GetAccessControl($destination)
if (!$actual.AreAccessRulesProtected) { throw 'Backup ACL still inherits' }
$allowed = @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')
foreach ($rule in $actual.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
    if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected backup ACL' }
}
Write-Output 'BACKUP_DIRECTORY_ACL_PASS: current Windows user, SYSTEM, Administrators only'
