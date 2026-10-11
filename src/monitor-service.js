import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { home, root, atomicWrite, sha } from './core.js';
import { launcher } from './update.js';

const receipt = () => path.join(root(), 'monitor-service.json');
const task = 'Agent Context Monitor Native';
const xml = value => value.replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' }[c]));
const ps = value => "'" + value.replace(/'/g, "''") + "'";
const powershell = script => ['powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')]];
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
    const action = `-Action (New-ScheduledTaskAction -Execute ${ps(node)} -Argument ${ps('"' + bin + '" monitor serve')})`;
    const start = `$ErrorActionPreference='Stop'; $existing=Get-ScheduledTask -TaskName ${ps(task)} -ErrorAction SilentlyContinue; if($existing){Stop-ScheduledTask -TaskName ${ps(task)}}; $account=[Security.Principal.WindowsIdentity]::GetCurrent().Name; $settings=New-ScheduledTaskSettingsSet -ExecutionTimeLimit ([TimeSpan]::Zero) -RestartCount 999 -RestartInterval (New-TimeSpan -Minutes 1) -MultipleInstances IgnoreNew -StartWhenAvailable -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries; Register-ScheduledTask -TaskName ${ps(task)} ${action} -Trigger (New-ScheduledTaskTrigger -AtLogOn -User $account) -Principal (New-ScheduledTaskPrincipal -UserId $account -LogonType Interactive -RunLevel Limited) -Settings $settings -Description 'Agent Context managed monitor' -Force | Out-Null; Start-ScheduledTask -TaskName ${ps(task)}`;
    return { platform, start: [powershell(start)], stop: [powershell(`$ErrorActionPreference='Stop'; Stop-ScheduledTask -TaskName ${ps(task)}; Unregister-ScheduledTask -TaskName ${ps(task)} -Confirm:$false`)] };
  }
  throw new Error('Unsupported monitor service platform');
}
const execute = (command, args) => execFileSync(command, args, { stdio: 'pipe', windowsHide: true, timeout: 30000 });
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
  // Service registration is per profile; telemetry credentials stay in private local files.
  if (plan.file) {
    const changed = !fs.existsSync(plan.file) || fs.readFileSync(plan.file, 'utf8') !== plan.text;
    if (!changed && fs.existsSync(receipt()) && JSON.parse(fs.readFileSync(receipt(), 'utf8')).status === 'installed') return { status: 'installed', platform };
    if (fs.existsSync(plan.file)) for (const [command, args] of plan.stop) { try { run(command, args); } catch {} }
    atomicWrite(plan.file, plan.text);
  }
  const registered = { platform, ...(plan.file ? { file: plan.file, hash: sha(plan.text) } : {}) };
  atomicWrite(receipt(), JSON.stringify(registered));
  for (const [command, args] of plan.start) run(command, args);
  atomicWrite(receipt(), JSON.stringify({ ...registered, status: 'installed' }));
  return { status: 'installed', platform };
}
export function removeMonitorService({ run = execute } = {}) {
  if (!fs.existsSync(receipt())) return;
  const saved = JSON.parse(fs.readFileSync(receipt(), 'utf8')), plan = monitorServicePlan(saved.platform);
  if (saved.platform !== process.platform && run === execute) throw new Error('Monitor service platform drift');
  if (plan.file && (saved.file !== plan.file || !fs.existsSync(plan.file) || fs.lstatSync(plan.file).isSymbolicLink() || sha(fs.readFileSync(plan.file)) !== saved.hash)) throw new Error('Monitor service configuration drift');
  if (!plan.file) verifyExisting(plan, run, false);
  for (const [command, args] of plan.stop) run(command, args);
  if (plan.file) fs.unlinkSync(plan.file);
  if (plan.platform === 'linux') run('systemctl', ['--user', 'daemon-reload']);
  fs.unlinkSync(receipt());
}
