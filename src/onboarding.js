import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { home } from './core.js';
import { agentNames } from './install.js';
import { agentExecutable } from './executable.js';
import { connectGateway, enrollment, gatewayURL, teamGateway } from './enrollment.js';
import { findPython } from './headroom.js';
import { langfuseConfig, telemetryDisabled } from './telemetry.js';

const execute = promisify(execFile);
const cli = fileURLToPath(new URL('../bin/agent-context.js', import.meta.url));

export function onboardingOptions(args) {
  const options = { agents: [], yes: false, login: false, flags: [] };
  for (let i = 0; i < args.length; i++) {
    const value = args[i];
    if (Object.hasOwn(agentNames, value)) options.agents.push(value);
    else if (value === '--yes') options.yes = true;
    else if (value === '--login') options.login = true;
    else if (value === '--no-report' || value === '--migrate') options.flags.push(value);
    else if (value === '--gateway' && args[i + 1]) options.gateway = gatewayURL(args[++i]);
    else throw new Error('Usage: agent-context onboard [codex claude hermes] [--yes] [--login] [--gateway HTTPS_URL] [--no-report] [--migrate]');
  }
  options.agents = [...new Set(options.agents)];
  return options;
}

export async function onboardingPlan(options, { python = findPython, executable = agentExecutable } = {}) {
  const detected = Object.entries(agentNames).map(([agent, name]) => {
    const profile = path.join(home(), agent === 'claude' ? '.claude' : `.${agent}`);
    let profilePresent = false, executablePresent = false;
    try { profilePresent = fs.statSync(profile).isDirectory(); } catch { /* A missing profile needs native first-run login. */ }
    try { executable(agent); executablePresent = true; } catch { /* Desktop agents can have a profile without a CLI on PATH. */ }
    return { agent, name, profile, profilePresent, executablePresent };
  });
  const selected = options.agents.length ? options.agents : detected.filter(a => a.profilePresent).map(a => a.agent);
  const issues = [];
  if (!selected.length) issues.push('Откройте нужного агента и завершите его первый запуск, затем повторите онбординг.');
  for (const agent of selected) {
    const item = detected.find(a => a.agent === agent);
    if (!item.profilePresent) issues.push(`${item.name}: сначала завершите обычный вход в агент, чтобы появился профиль.`);
    const override = process.env[{ codex: 'CODEX_HOME', claude: 'CLAUDE_CONFIG_DIR', hermes: 'HERMES_HOME' }[agent]];
    if (override && path.resolve(override) !== path.resolve(item.profile)) issues.push(`${item.name}: обнаружен нестандартный путь профиля; автоматическая установка пока его не поддерживает. Не изменяйте другой профиль.`);
  }
  try { await python(); } catch { issues.push('Нужен Python 3.11–3.13 с venv/ensurepip. Подключите установленный Python через AGENT_CONTEXT_PYTHON или установите его штатным способом.'); }
  const device = enrollment();
  if (telemetryDisabled()) issues.push('Телеметрия явно отключена владельцем профиля. Включите её в настройках Langfuse для завершения командного онбординга; отключение автоматически не перезаписывается.');
  const existing = langfuseConfig();
  const gateway = options.gateway || device?.gateway || (existing && !options.login ? null : teamGateway);
  const signInRequired = Boolean(gateway && (options.login || !device || device.gateway !== gateway));
  const telemetryRequested = true;
  return {
    status: issues.length ? 'needs_attention' : 'awaiting_confirmation',
    platform: process.platform, runtime: process.env.WSL_DISTRO_NAME ? 'wsl' : 'native',
    detected: detected.filter(a => a.profilePresent || a.executablePresent), selected, gateway, signInRequired, telemetryRequested, issues,
    message: selected.length ? `Найдены: ${selected.map(a => agentNames[a]).join(', ')}. Подключить выбранных агентов? По умолчанию — всех найденных с готовым профилем.` : 'Готовые профили агентов пока не найдены.',
    notice: 'Сжатие работает локально без ключей и облачного компрессора. Командная телеметрия подключается сразу: разговоры и результаты инструментов, события сжатия, состояние служб и ошибки доставки. Существующий вход используется; новому устройству нужен один GitHub-вход. Автообновления сохраняются. Входы и модели агентов сохраняются. Windows и WSL подключаются отдельно.',
    next: issues.length ? 'Устраните только перечисленные препятствия и повторите onboard.' : 'После согласия пользователя повторите onboard с --yes и тем же выбором агентов. Если подключение уже запрошено явно, дополнительный вопрос не нужен.',
  };
}

async function runStep(args) {
  let stdout;
  try { ({ stdout } = await execute(process.execPath, [cli, ...args], { timeout: 600000, maxBuffer: 4 * 1024 * 1024, windowsHide: true })); }
  catch (error) {
    // Structured needs_attention reports are useful; raw subprocess errors can contain private data.
    stdout = error.stdout;
    if (!stdout) {
      const known = String(error.stderr || '').split('\n').find(line => /^(Setup requires|Headroom requires|Update refused|GitHub sign-in|Gateway enrollment refused)/.test(line));
      return { status: 'needs_attention', reason: known || `Не завершён шаг ${args[0]}. Проверьте его отдельно; сохранённые шаги повторять не нужно.` };
    }
  }
  try { return JSON.parse(stdout); } catch { return { status: 'needs_attention', reason: `Шаг ${args[0]} не вернул проверяемый результат.` }; }
}

export async function onboard(options, { plan = onboardingPlan, connect = connectGateway, step = runStep, announce = value => process.stderr.write(value + '\n') } = {}) {
  const preview = await plan(options);
  if (!options.yes || preview.issues.length) return preview;
  if (preview.signInRequired) {
    announce('Войдите в команду через GitHub. После подтверждения настройка продолжится автоматически.');
    await connect(preview.gateway);
  } else announce(preview.telemetryRequested ? 'Сохранённое подключение телеметрии найдено; повторный вход не запрашивается.' : 'Локальный режим: вход в команду и ключи не нужны.');
  announce('Настраиваю выбранных агентов и автообновления…');
  const setup = await step(['setup', ...preview.selected, ...options.flags]);
  if (!preview.selected.every(agent => setup.installed?.includes(agent))) return { status: 'needs_attention', selected: preview.selected, setup, next: 'Устраните причину незавершённой установки и повторите onboard --yes с тем же выбором.' };
  announce('Проверяю службы и доставку телеметрии…');
  const services = await step(['doctor', '--fix', '--live']);
  const delivery = {};
  for (const agent of preview.telemetryRequested ? preview.selected : []) delivery[agent] = await step(['telemetry', 'verify', agent]);
  // Re-read after delivery: setup/doctor may have reported the earlier unverified state.
  const monitor = await step(['monitor', 'tick']);
  const checks = await step(['doctor', '--live']);
  const ready = ['delivered', 'accepted_by_gateway'].includes(monitor.status) && checks.healthy === true && setup.monitor?.status === 'installed' && !setup.warnings?.length && (!preview.telemetryRequested || preview.selected.every(a => delivery[a]?.status === 'delivered'));
  return { status: ready ? 'ready_for_agent_check' : 'needs_attention', selected: preview.selected,
    setup, services, delivery, monitor, checks, runtimeProof: 'real_agent_turns_not_run',
    next: ready ? 'Настройка и запрошенные проверки завершены. Агент сопровождения выполняет один контрольный ход каждым выбранным агентом; только после этого сообщает, что подключение работает.' : 'Агент сопровождения устраняет перечисленные препятствия. При отказе доступа команды повторите onboard --login --yes; native hook trust подтверждает пользователь. Не прерывайте активные сессии.',
  };
}
