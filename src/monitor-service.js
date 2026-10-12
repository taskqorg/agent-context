import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { home, root, atomicWrite, sha } from './core.js';
import { launcher } from './update.js';

const receipt = () => path.join(root(), 'monitor-service.json');
const task = 'Agent Context Monitor Native';
const xml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const ps = value => "'" + value.replace(/'/g, "''") + "'";
const powershell = script => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
const wrapperHash = 'b5066b7bbdfba1293e5d15cda3caaea88fbeab35bd5b38c41c913d492aadfc4f';
const wrapper = () => path.join(root(), 'windows-service', 'agent-context-monitor.exe');
export async function prepareWindowsMonitor({ platform = process.platform, request = fetch } = {}) {
  if (platform !== 'win32') return;
  if (fs.existsSync(wrapper())) {
    if (fs.lstatSync(wrapper()).isSymbolicLink() || sha(fs.readFileSync(wrapper())) !== wrapperHash) throw new Error('Windows service wrapper integrity mismatch');
    return;
  }
  const response = await request('https://github.com/winsw/winsw/releases/download/v2.12.0/WinSW.NET461.exe', { signal: AbortSignal.timeout(60000) });
  if (!response.ok) throw new Error('Windows service wrapper download failed');
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > 15000000 || sha(bytes) !== wrapperHash) throw new Error('Windows service wrapper checksum mismatch');
  fs.mkdirSync(path.dirname(wrapper()), { recursive: true, mode: 0o700 });
  fs.writeFileSync(wrapper(), bytes, { flag: 'wx', mode: 0o600 });
}
export function monitorServicePlan(platform = process.platform) {
  const profile = home(), bin = launcher(), node = process.execPath;
  if (/[\r\n\0]/.test(profile + bin + node)) throw new Error('Invalid monitor service path');
  if (platform === 'darwin') {
    const label = 'com.taskqorg.contextq-monitor', file = path.join(profile, 'Library/LaunchAgents', label + '.plist');
    const text = `<?xml version="1.0"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>Label</key><string>${label}</string><key>ProgramArguments</key><array>${[node, bin, 'monitor', 'serve'].map(x => '<string>' + xml(x) + '</string>').join('')}</array><key>EnvironmentVariables</key><dict><key>AGENT_CONTEXT_HOME</key><string>${xml(profile)}</string></dict><key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>15</integer></dict></plist>\n`;
    return { platform, file, text, start: [['launchctl', ['bootstrap', `gui/${(process.getuid?.() ?? 0)}`, file]]], stop: [['launchctl', ['bootout', `gui/${(process.getuid?.() ?? 0)}/${label}`]]] };
  }
  if (platform === 'linux') {
    const file = path.join(profile, '.config/systemd/user/agent-context-monitor.service');
    const text = `[Unit]\nDescription=Agent Context managed monitor\nAfter=network-online.target\n[Service]\nEnvironment=${JSON.stringify('AGENT_CONTEXT_HOME=' + profile)}\n${process.env.WSL_DISTRO_NAME && /^[a-zA-Z0-9_-]{1,64}$/.test(process.env.WSL_DISTRO_NAME) ? 'Environment=' + JSON.stringify('WSL_DISTRO_NAME=' + process.env.WSL_DISTRO_NAME) + '\n' : ''}ExecStart=${JSON.stringify(node)} ${JSON.stringify(bin)} monitor serve\nRestart=on-failure\nRestartSec=15\n[Install]\nWantedBy=default.target\n`;
    return { platform, file, text, start: [['systemctl', ['--user', 'daemon-reload']], ['systemctl', ['--user', 'enable', '--now', 'agent-context-monitor.service']]], stop: [['systemctl', ['--user', 'disable', '--now', 'agent-context-monitor.service']]] };
  }
  if (platform === 'win32') {
    const executable = wrapper(), file = executable.replace(/\.exe$/, '.xml');
    const id = 'AgentContextMonitor' + sha(profile.toLowerCase()).slice(0, 12);
    const account = (process.env.USERDOMAIN || os.hostname()) + '\\' + os.userInfo().username;
    const [domain, user] = account.split('\\');
    const text = `<service><id>${id}</id><name>Agent Context Monitor ${xml(user)}</name><description>Agent Context managed monitor</description><executable>${xml(node)}</executable><arguments>${xml('"' + bin + '" monitor serve')}</arguments><env name="AGENT_CONTEXT_HOME" value="${xml(profile)}"/><workingdirectory>${xml(root())}</workingdirectory><serviceaccount><domain>${xml(domain)}</domain><user>${xml(user)}</user><allowservicelogon>true</allowservicelogon></serviceaccount><startmode>Automatic</startmode><onfailure action="restart" delay="15 sec"/><stoptimeout>40 sec</stoptimeout><log mode="roll-by-size"><sizeThreshold>1024</sizeThreshold><keepFiles>3</keepFiles></log></service>\n`;
    // WinSW owns the credential prompt; no password enters argv, XML or our process.
    const commands = `$ErrorActionPreference='Stop'; & ${ps(executable)} install /p; if($LASTEXITCODE){exit $LASTEXITCODE}; $s=Get-CimInstance Win32_Service -Filter ${ps("Name='" + id + "'")}; $actual=(New-Object Security.Principal.NTAccount($s.StartName)).Translate([Security.Principal.SecurityIdentifier]).Value; $wanted=(New-Object Security.Principal.NTAccount(${ps(account)})).Translate([Security.Principal.SecurityIdentifier]).Value; if($actual -ne $wanted){& ${ps(executable)} uninstall; throw 'Unexpected service account; service not started'}; & ${ps(executable)} start; exit $LASTEXITCODE`;
    const elevated = `$p=Start-Process powershell.exe -Verb RunAs -WindowStyle Normal -PassThru -Wait -ArgumentList @('-NoProfile','-EncodedCommand',${ps(Buffer.from(commands,'utf16le').toString('base64'))}); exit $p.ExitCode`;
    return { platform, file, text, kind: 'windows-service', executable, id, account, start: [powershell(elevated)], stop: [[executable, ['stopwait']], [executable, ['uninstall']]] };
  }
  throw new Error('Unsupported monitor service platform');
}
const execute = (command, args) => execFileSync(command, args, { stdio: 'pipe', windowsHide: true, timeout: process.platform === 'win32' ? 300000 : 30000 });
function windowsService(plan, run) {
  const query = `$s=Get-CimInstance Win32_Service -Filter ${ps("Name='" + plan.id + "'")}; if($s){$sid=(New-Object Security.Principal.NTAccount($s.StartName)).Translate([Security.Principal.SecurityIdentifier]).Value; [pscustomobject]@{path=$s.PathName;owner=$sid;expected=[Security.Principal.WindowsIdentity]::GetCurrent().User.Value;state=$s.State}|ConvertTo-Json -Compress}`;
  const value = String(run(...powershell(query))).trim();
  if (!value) return null;
  const service = JSON.parse(value);
  if (service.path.replace(/^"|"$/g, '').toLowerCase() !== plan.executable.toLowerCase() || service.owner !== service.expected) throw new Error('Windows service ownership drift');
  return service;
}
function verifyExisting(plan, run, migrate) {
  if (plan.file) {
    if (!fs.existsSync(plan.file)) return;
    if (fs.lstatSync(plan.file).isSymbolicLink()) throw new Error('Monitor service symlink refused');
    const text = fs.readFileSync(plan.file, 'utf8');
    if (text === plan.text) return;
    let saved; try { saved = JSON.parse(fs.readFileSync(receipt(), 'utf8')); } catch {}
    if (saved?.file === plan.file && saved.hash === sha(text)) return;
    if (migrate && (text.includes(path.join(root(), 'monitor-releases')) || text.includes('/agent-context-monitor/'))) return;
    throw new Error('Existing monitor service requires reviewed migration');
  }
  const query = run(...powershell(`$t=Get-ScheduledTask -TaskName ${ps(task)} -ErrorAction SilentlyContinue; if($t){[pscustomobject]@{description=$t.Description;execute=$t.Actions.Execute;arguments=$t.Actions.Arguments}|ConvertTo-Json -Compress}`));
  if (!String(query).trim()) return;
  const taskInfo = JSON.parse(String(query));
  if (taskInfo.description === 'Agent Context managed monitor' && taskInfo.execute === process.execPath && taskInfo.arguments === '"' + launcher() + '" monitor serve') return;
  if (migrate && taskInfo.description?.startsWith('Independent Agent Context monitor') && taskInfo.arguments?.includes('EncodedCommand') && Buffer.from(taskInfo.arguments.split('EncodedCommand ')[1] || '', 'base64').toString('utf16le').includes(path.join(root(), 'monitor-runtime'))) return;
  throw new Error('Existing monitor task requires reviewed migration');
}
export function installMonitorService({ migrate = false, run = execute, platform = process.platform } = {}) {
  const plan = monitorServicePlan(platform);
  verifyExisting(plan, run, migrate);
  let existing, legacy;
  if (plan.kind === 'windows-service') {
    if (!fs.existsSync(plan.executable) || sha(fs.readFileSync(plan.executable)) !== wrapperHash) throw new Error('Prepare the verified Windows service wrapper first');
    existing = windowsService(plan, run);
    legacy = String(run(...powershell(`$t=Get-ScheduledTask -TaskName ${ps(task)} -ErrorAction SilentlyContinue; if($t){[pscustomobject]@{description=$t.Description;execute=$t.Actions.Execute;arguments=$t.Actions.Arguments;state=[string]$t.State}|ConvertTo-Json -Compress}`))).trim();
    if (legacy) {
      verifyExisting({ ...plan, file: undefined }, run, migrate);
      if (JSON.parse(legacy).state === 'Running') return { status: 'needs_attention', platform, reason: 'Legacy monitor is running; reviewed idle migration required' };
    }
  }
  // Service registration is per profile; telemetry credentials stay in private local files.
  if (plan.file) {
    const changed = !fs.existsSync(plan.file) || fs.readFileSync(plan.file, 'utf8') !== plan.text;
    if (!changed && fs.existsSync(receipt()) && JSON.parse(fs.readFileSync(receipt(), 'utf8')).status === 'installed' && (plan.kind !== 'windows-service' || existing?.state === 'Running')) {
      if (legacy) run(...powershell(`Unregister-ScheduledTask -TaskName ${ps(task)} -Confirm:$false`));
      return { status: 'installed', platform };
    }
    if (fs.existsSync(plan.file) && plan.kind !== 'windows-service') for (const [command, args] of plan.stop) { try { run(command, args); } catch {} }
    atomicWrite(plan.file, plan.text);
  }
  const registered = { platform, ...(plan.file ? { file: plan.file, hash: sha(plan.text) } : {}), ...(plan.kind ? { kind: plan.kind } : {}) };
  atomicWrite(receipt(), JSON.stringify(registered));
  if (plan.kind === 'windows-service' && existing) run(plan.executable, ['start']);
  else for (const [command, args] of plan.start) run(command, args);
  if (plan.kind === 'windows-service') {
    if (windowsService(plan, run)?.state !== 'Running') throw new Error('Windows service did not start under its owner');
    run(...powershell(`$t=Get-ScheduledTask -TaskName ${ps(task)} -ErrorAction SilentlyContinue; if($t){Unregister-ScheduledTask -TaskName ${ps(task)} -Confirm:$false}`));
  }
  atomicWrite(receipt(), JSON.stringify({ ...registered, status: 'installed' }));
  return { status: 'installed', platform };
}
export function removeMonitorService({ run = execute } = {}) {
  if (!fs.existsSync(receipt())) return;
  const saved = JSON.parse(fs.readFileSync(receipt(), 'utf8')), plan = monitorServicePlan(saved.platform);
  if (saved.platform === 'win32' && saved.kind !== 'windows-service') {
    verifyExisting({ ...plan, file: undefined }, run, false);
    run(...powershell(`$ErrorActionPreference='Stop'; Stop-ScheduledTask -TaskName ${ps(task)}; Unregister-ScheduledTask -TaskName ${ps(task)} -Confirm:$false`));
    fs.unlinkSync(receipt()); return;
  }
  if (saved.platform !== process.platform && run === execute) throw new Error('Monitor service platform drift');
  if (plan.file && (saved.file !== plan.file || !fs.existsSync(plan.file) || fs.lstatSync(plan.file).isSymbolicLink() || sha(fs.readFileSync(plan.file)) !== saved.hash)) throw new Error('Monitor service configuration drift');
  if (!plan.file) verifyExisting(plan, run, false);
  if (plan.kind === 'windows-service') windowsService(plan, run);
  for (const [command, args] of plan.stop) run(command, args);
  if (plan.kind === 'windows-service' && windowsService(plan, run)) throw new Error('Windows service still registered; data preserved');
  if (plan.file) fs.unlinkSync(plan.file);
  if (plan.platform === 'linux') run('systemctl', ['--user', 'daemon-reload']);
  fs.unlinkSync(receipt());
}
