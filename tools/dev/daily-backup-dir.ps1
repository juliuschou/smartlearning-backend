param(
 [Parameter(Mandatory=$true)][string]$RunId,
 [ValidateSet('Root','Create','Verify','Published')][string]$Action = 'Verify',
 [long]$RequiredBytes = 2147483648
)
$ErrorActionPreference = 'Stop'
if ($RunId -notmatch '^sl-daily-[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$') { throw 'Invalid run ID' }
$root = 'D:\Backups\SmartLearning\daily-v1'
$destination = if ($Action -eq 'Root') { $root } elseif ($Action -eq 'Published') { "$root\$RunId" } else { "$root\$RunId.partial" }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$allowed = @($currentSid.Value, 'S-1-5-18', 'S-1-5-32-544')
# Refuse junctions and other reparse points on every existing ancestor.
$cursor = $destination
while ($cursor) {
 if ([System.IO.Directory]::Exists($cursor) -and (([System.IO.File]::GetAttributes($cursor) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Reparse path forbidden' }
 $parent = [System.IO.Directory]::GetParent($cursor)
 $cursor = if ($null -eq $parent) { $null } else { $parent.FullName }
}
if (([System.IO.DriveInfo]::new('D')).AvailableFreeSpace -lt $RequiredBytes) { throw 'Insufficient backup space' }
$create = $Action -eq 'Create' -or ($Action -eq 'Root' -and ![System.IO.Directory]::Exists($root))
if ($Action -eq 'Create' -and [System.IO.Directory]::Exists($destination)) { throw 'Destination collision' }
if ($create) {
 [System.IO.Directory]::CreateDirectory($destination) | Out-Null
 $acl = [System.IO.Directory]::GetAccessControl($destination)
 if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { throw 'Unexpected owner' }
 $acl.SetAccessRuleProtection($true, $false)
 foreach ($rule in $acl.GetAccessRules($true, $false, [System.Security.Principal.SecurityIdentifier])) { $acl.RemoveAccessRuleSpecific($rule) }
 foreach ($sid in $allowed) {
  $acl.AddAccessRule([System.Security.AccessControl.FileSystemAccessRule]::new([System.Security.Principal.SecurityIdentifier]$sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow'))
 }
 [System.IO.Directory]::SetAccessControl($destination, $acl)
}
function CheckAcl([string]$path, [bool]$directory) {
 if (([System.IO.File]::GetAttributes($path) -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Reparse entry forbidden' }
 $acl = if ($directory) { [System.IO.Directory]::GetAccessControl($path) } else { [System.IO.File]::GetAccessControl($path) }
 if ($acl.GetOwner([System.Security.Principal.SecurityIdentifier]).Value -ne $currentSid.Value) { throw 'Unexpected owner' }
 if ($directory -and !$acl.AreAccessRulesProtected) { throw 'Unprotected directory ACL' }
 $seen = @()
 foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.IdentityReference.Value -notin $allowed -or $rule.AccessControlType -ne 'Allow') { throw 'Unexpected ACL' }
  if (($rule.FileSystemRights -band [System.Security.AccessControl.FileSystemRights]::FullControl) -ne [System.Security.AccessControl.FileSystemRights]::FullControl) { throw 'Missing FullControl' }
  $seen += $rule.IdentityReference.Value
 }
 foreach ($sid in $allowed) { if ($sid -notin $seen) { throw 'Missing allowed principal' } }
}
CheckAcl $destination $true
if ($Action -ne 'Root') {
 if ([System.IO.Directory]::GetDirectories($destination).Length -ne 0) { throw 'Nested directory forbidden' }
 foreach ($file in [System.IO.Directory]::GetFiles($destination)) { CheckAcl $file $false }
}
Write-Output 'DAILY_BACKUP_ACL_PASS'
