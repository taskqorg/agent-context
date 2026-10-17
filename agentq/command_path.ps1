$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Set-AgentQPath([Microsoft.Win32.RegistryKey]$key, [string]$dir, [bool]$remove) {
    # Read the raw value: setx and automatic expansion can damage unrelated PATH entries.
    $old = [string]$key.GetValue('Path', '', [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)
    $kind = if ($key.GetValueNames() -contains 'Path') { $key.GetValueKind('Path') } else { [Microsoft.Win32.RegistryValueKind]::ExpandString }
    $found = $false
    $entries = @($old.Split(';') | Where-Object {
        $same = [Environment]::ExpandEnvironmentVariables($_.Trim().Trim('"')).TrimEnd('\') -ieq $dir.TrimEnd('\')
        if ($same) { $found = $true }
        -not ($remove -and $same)
    })
    $new = if ($remove) { $entries -join ';' } elseif ($found) { $old } elseif ($old) { $old.TrimEnd(';') + ';' + $dir } else { $dir }
    if ($new -cne $old) {
        $key.SetValue('Path', $new, $kind)
        if (-not ('AgentQEnvironment' -as [type])) { Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class AgentQEnvironment {
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    public static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wparam,
        string lparam, uint flags, uint timeout, out UIntPtr result);
}
'@
        }
        $result = [UIntPtr]::Zero
        [void][AgentQEnvironment]::SendMessageTimeout([IntPtr]0xffff, 0x1a, [UIntPtr]::Zero, 'Environment', 2, 2000, [ref]$result)
    }
}
