param(
    [string]$Mode,
    [string]$Path,
    [string]$AclSource
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

try {
    if ($args.Count -ne 0 -or $Mode -notin @('protect', 'unprotect', 'secure-temp')) {
        throw 'invalid'
    }
    if ($Mode -eq 'secure-temp') {
        if (-not $Path -or -not [IO.Path]::IsPathRooted($Path)) { throw 'invalid' }
        $temporary = Get-Item -LiteralPath $Path -Force -ErrorAction Stop
        if ($temporary -isnot [IO.FileInfo] -or $temporary.Length -ne 0 -or
            ($temporary.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid' }

        $access = [Security.AccessControl.AccessControlSections]::Access
        $currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User
        # Establish Owner and DACL only on the new empty temp; do not restore SACLs.
        $acl = New-Object Security.AccessControl.FileSecurity
        if ($AclSource) {
            if (-not [IO.Path]::IsPathRooted($AclSource)) { throw 'invalid' }
            $source = Get-Item -LiteralPath $AclSource -Force -ErrorAction Stop
            if ($source -isnot [IO.FileInfo] -or
                ($source.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'invalid' }
            $sourceAcl = [IO.File]::GetAccessControl(
                $AclSource, ($access -bor [Security.AccessControl.AccessControlSections]::Owner)
            )
            if ($sourceAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne
                $currentSid.Value) { throw 'invalid' }
            $descriptor = $sourceAcl.GetSecurityDescriptorSddlForm($access)
            $acl.SetSecurityDescriptorSddlForm($descriptor, $access)
        } else {
            $acl.SetAccessRuleProtection($true, $false)
            $systemSid = New-Object Security.Principal.SecurityIdentifier 'S-1-5-18'
            foreach ($sid in @($currentSid, $systemSid)) {
                $rule = New-Object Security.AccessControl.FileSystemAccessRule(
                    $sid, [Security.AccessControl.FileSystemRights]::FullControl,
                    [Security.AccessControl.AccessControlType]::Allow
                )
                $acl.AddAccessRule($rule)
            }
            $descriptor = $acl.GetSecurityDescriptorSddlForm($access)
        }
        $targetAcl = [IO.File]::GetAccessControl(
            $Path, [Security.AccessControl.AccessControlSections]::Owner
        )
        if ($targetAcl.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne
            $currentSid.Value) {
            $acl.SetOwner($currentSid)
        }
        [IO.File]::SetAccessControl($Path, $acl)
        $actual = [IO.File]::GetAccessControl(
            $Path, ($access -bor [Security.AccessControl.AccessControlSections]::Owner)
        )
        if ($actual.GetOwner([Security.Principal.SecurityIdentifier]).Value -cne
            $currentSid.Value) { throw 'invalid' }
        if ($actual.AreAccessRulesProtected -ne $acl.AreAccessRulesProtected) { throw 'invalid' }
        if ($actual.GetSecurityDescriptorSddlForm($access) -cne $descriptor) {
            # Windows may normalize the AI control flag. Compare the complete
            # ordered ACE bytes and protection instead of ignoring verification.
            if (-not $acl.AreAccessRulesCanonical -or
                -not $actual.AreAccessRulesCanonical) { throw 'invalid' }
            $expectedRaw = New-Object Security.AccessControl.RawSecurityDescriptor(
                $acl.GetSecurityDescriptorBinaryForm(), 0
            )
            $actualRaw = New-Object Security.AccessControl.RawSecurityDescriptor(
                $actual.GetSecurityDescriptorBinaryForm(), 0
            )
            foreach ($flag in @(
                [Security.AccessControl.ControlFlags]::DiscretionaryAclPresent,
                [Security.AccessControl.ControlFlags]::DiscretionaryAclDefaulted,
                [Security.AccessControl.ControlFlags]::DiscretionaryAclAutoInheritRequired
            )) {
                if (($expectedRaw.ControlFlags -band $flag) -ne
                    ($actualRaw.ControlFlags -band $flag)) { throw 'invalid' }
            }
            $fingerprints = @(
                foreach ($raw in @($expectedRaw, $actualRaw)) {
                    if ($null -eq $raw.DiscretionaryAcl) {
                        'null'
                    } else {
                        $bytes = New-Object byte[] $raw.DiscretionaryAcl.BinaryLength
                        $raw.DiscretionaryAcl.GetBinaryForm($bytes, 0)
                        [Convert]::ToBase64String($bytes)
                    }
                }
            )
            if ($fingerprints[0] -cne $fingerprints[1]) { throw 'invalid' }
        }
        [Console]::Out.Write('ok')
    } else {
        if ($Path -or $AclSource) { throw 'invalid' }
        Add-Type -AssemblyName System.Security -ErrorAction Stop
        $maximumText = 3 * 1024 * 1024
        $builder = New-Object Text.StringBuilder
        $chunk = New-Object char[] 4096
        while (($count = [Console]::In.Read($chunk, 0, $chunk.Length)) -gt 0) {
            if ($builder.Length + $count -gt $maximumText) { throw 'invalid' }
            [void]$builder.Append($chunk, 0, $count)
        }
        $encoded = $builder.ToString()
        if (-not $encoded -or $encoded.Length % 4 -ne 0 -or
            $encoded -cnotmatch '^[A-Za-z0-9+/]*={0,2}$') { throw 'invalid' }
        $payload = [Convert]::FromBase64String($encoded)
        if ([Convert]::ToBase64String($payload) -cne $encoded) { throw 'invalid' }
        $scope = [Security.Cryptography.DataProtectionScope]::CurrentUser
        if ($Mode -eq 'protect') {
            if ($payload.Length -gt 1MB) { throw 'invalid' }
            $result = [Security.Cryptography.ProtectedData]::Protect($payload, $null, $scope)
        } else {
            if ($payload.Length -gt 2MB) { throw 'invalid' }
            $result = [Security.Cryptography.ProtectedData]::Unprotect($payload, $null, $scope)
            if ($result.Length -gt 1MB) { throw 'invalid' }
        }
        $output = [Convert]::ToBase64String($result)
        if ($output.Length -gt $maximumText) { throw 'invalid' }
        [Console]::Out.Write($output)
    }
    exit 0
} catch {
    [Console]::Error.WriteLine('{"code":"protection_failed"}')
    exit 1
}
