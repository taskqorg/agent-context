import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { atomicWrite, home } from './core.js';

const protect = `$ErrorActionPreference='Stop'
$owner=(Get-Acl -LiteralPath $env:AGENT_CONTEXT_PROFILE_DIR).GetOwner([System.Security.Principal.SecurityIdentifier])
$acl=New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($owner)
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($owner.Value,'S-1-5-18','S-1-5-32-544')) {
  $identity=New-Object System.Security.Principal.SecurityIdentifier($sid)
  $rule=New-Object System.Security.AccessControl.FileSystemAccessRule($identity,'FullControl','Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -LiteralPath $env:AGENT_CONTEXT_PRIVATE_FILE -AclObject $acl
`;

// Protect an empty temp file before writing secrets: Windows ignores POSIX mode 0600.
export function atomicSecretWrite(file, data, { platform = process.platform, execute = execFileSync, exclusive = false } = {}) {
  if (platform !== 'win32') {
    if (!exclusive) return atomicWrite(file, data);
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    return fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 });
  }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temporary = file + '.' + crypto.randomUUID() + '.tmp';
  try {
    fs.writeFileSync(temporary, '', { flag: 'wx' });
    const environment = { ...process.env, AGENT_CONTEXT_PRIVATE_FILE: temporary, AGENT_CONTEXT_PROFILE_DIR: home() };
    // Codex can inherit PS7 modules; Windows PowerShell must build its compatible default path.
    for (const key of Object.keys(environment)) if (key.toUpperCase() === 'PSMODULEPATH') delete environment[key];
    execute('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(protect, 'utf16le').toString('base64')], {
      env: environment, stdio: 'ignore', windowsHide: true, timeout: 10000
    });
    fs.writeFileSync(temporary, data);
    if (exclusive) fs.linkSync(temporary, file); else fs.renameSync(temporary, file);
  } finally { fs.rmSync(temporary, { force: true }); }
}

export function writeConfig(file, data, options = {}) {
  const privateFile = file === path.join(home(), '.codex/langfuse.json') || file === path.join(home(), '.hermes/.env') || file === path.join(home(), '.claude/settings.json') && data.toString().includes('sk-lf-device-');
  if (privateFile) return atomicSecretWrite(file, data, options);
  return options.exclusive ? fs.writeFileSync(file, data, { flag: 'wx', mode: 0o600 }) : atomicWrite(file, data);
}
