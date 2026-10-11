const freshness = 10 * 60 * 1000;
const tag = (row, key) => row.tags?.find(t => t.startsWith(key + ':'))?.slice(key.length + 1);
const attribute = (row, key) => row.metadata?.['attributes.agent_context.' + key];
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
export const hostNames = { 'mac/native': 'Mac', 'windows/native': 'Windows', 'windows/wsl': 'Windows · WSL', 'fra/native': 'FRA' };
export const agentNames = { codex: 'Codex', hermes: 'Hermes', 'claude-code': 'Claude Code' };
export const serviceNames = { contextq: 'ContextQ', serverq: 'ServerQ', taskq: 'TaskQ', gateway: 'Сборщик телеметрии', 'hermes-gateway': 'Hermes Gateway', langfuse: 'Langfuse', updater: 'Обновления' };
export const reasons = {
  proxy_health_not_agent_liveness: 'Прокси доступен. Активность агента показана отдельно.',
  proxy_unavailable: 'Прокси недоступен — проверить локальный сервис ContextQ.',
  compression_telemetry_disabled: 'В прокси отключена телеметрия компрессии.',
  delivery_backlog: 'Данные ждут отправки более 10 минут.',
  queue_unreadable: 'Не удалось прочитать очередь телеметрии.',
  endpoint_reachable: 'Сервис ответил на проверку.',
  endpoint_unavailable: 'Сервис не ответил — проверить его доступность.',
  automated_checks_only: 'Статус из автоматических проверок ServerQ. Ручные проверки не подтверждены.',
  status_snapshot: 'Получен отчёт о состоянии.',
  report_unavailable: 'Нет отчёта о состоянии. Подключить источник данных.',
  stale_report: 'Отчёт устарел. Проверить источник данных.',
  invalid_report: 'Некорректный отчёт о состоянии.',
  updates_disabled: 'Автообновления отключены.',
  update_migration_required: 'Нужна одноразовая миграция пакета.',
  update_failed: 'Обновление не прошло проверку. Рабочая версия сохранена.',
  release_subscription_connected: 'Подписка на релизы работает; запасная проверка — раз в час.',
  release_subscription_unavailable: 'Подписка не подтверждена. Проверить монитор и соединение.',
  invalid_report_policy: 'Некорректная настройка срока действия отчёта.'
};
const normal = new Set(['compressed', 'retrieval', 'content_type', 'ineligible', 'no_gain', 'empty', 'too_large', 'request_budget']);
export const outcomeNames = { compressed: 'Сжато', retrieval: 'Чтение сохранённого оригинала', content_type: 'Тип данных не подходит', ineligible: 'Блок не требует сжатия', no_gain: 'Сжатие не дало выигрыша', empty: 'Пустой блок', too_large: 'Блок превышает лимит', request_budget: 'Лимит обработки запроса' };
const identity = row => ({ host: tag(row, 'host') || attribute(row, 'host'), runtime: tag(row, 'runtime') || attribute(row, 'runtime') || 'native', agent: tag(row, 'agent') || attribute(row, 'agent') });
const safeTrace = row => /^[a-zA-Z0-9_-]{1,128}$/.test(row.traceId || '') ? row.traceId : null;

export function overview({ health = [], compression = [], activity = [], incidents = [], truncated = [] }, now = Date.now(), period = 1800) {
  // Langfuse v4 synthetic roots mirror incident spans; count the real observations only.
  const physical = rows => rows.filter(row => !row.id?.startsWith('t-'));
  health = physical(health); compression = physical(compression); activity = physical(activity); incidents = physical(incidents);
  const hosts = new Map(Object.entries(hostNames).map(([id, name]) => [id, { id, name, at: null, fresh: false, services: [], agents: [] }]));
  const ensureHost = (host, runtime) => {
    if (!/^[a-zA-Z0-9_-]{1,64}$/.test(host || '') || !['native', 'wsl'].includes(runtime)) return null;
    const id = host + '/' + runtime;
    if (!hosts.has(id)) hosts.set(id, { id, name: hostNames[id] || host + (runtime === 'wsl' ? ' · WSL' : ''), at: null, fresh: false, services: [], agents: [] });
    return hosts.get(id);
  };
  // A device's newest snapshot owns its identity; old WSL labels must not create another host.
  const newest = new Map();
  for (const row of health) {
    const at = Date.parse(row.startTime), device = tag(row, 'device') || 'local:' + identity(row).host;
    if (Number.isFinite(at) && at <= now + 60000 && at > (newest.get(device) || 0)) newest.set(device, at);
  }
  for (const row of health) {
    const at = Date.parse(row.startTime), device = tag(row, 'device') || 'local:' + identity(row).host;
    if (at !== newest.get(device)) continue;
    const { host, runtime, agent } = identity(row), h = ensureHost(host, runtime), service = tag(row, 'service');
    if (!h || !serviceNames[service] || !['ok', 'warning', 'error', 'unknown'].includes(tag(row, 'state'))) continue;
    if (service === 'updater') {
      const semver = key => /^\d+\.\d+\.\d+$/.test(attribute(row, 'update.' + key) || '') ? attribute(row, 'update.' + key) : null;
      const status = attribute(row, 'update.status'), subscription = attribute(row, 'update.subscription');
      h.update = { installed: semver('installed'), available: semver('available'), monitor: semver('monitor'), enabled: attribute(row, 'update.enabled') === 'true', status: ['ready', 'checking', 'current', 'migration_required', 'paused', 'staged_wait', 'downloading', 'testing', 'downloaded', 'updated', 'failed', 'rolled_back', 'no_stable_release', 'disabled_before_activation'].includes(status) ? status : 'unknown', subscription: ['connected', 'reconnecting', 'disabled'].includes(subscription) ? subscription : 'unknown', checkedAt: number(attribute(row, 'update.checkedAt')) };
    }
    h.at = Math.max(h.at || 0, at); h.fresh = now - h.at <= freshness;
    const metrics = {};
    for (const key of ['active_connections', 'queue_batches', 'queue_oldest_seconds', 'compressed', 'passthrough', 'compression_failed', 'input_chars', 'output_chars']) metrics[key] = number(attribute(row, 'monitor.' + key));
    h.services.push({ service, name: serviceNames[service], agent: agentNames[agent] ? agent : null, state: now - at > freshness ? 'unknown' : tag(row, 'state'), reason: now - at > freshness ? 'Нет свежей проверки более 10 минут.' : reasons[row.statusMessage] || 'Нет объяснения состояния.', metrics, at, traceId: safeTrace(row), proxyVersion: /^\d+\.\d+\.\d+$/.test(attribute(row, 'proxy.version') || '') ? attribute(row, 'proxy.version') : null, monitorVersion: /^\d+\.\d+\.\d+$/.test(attribute(row, 'version') || '') ? attribute(row, 'version') : null });
  }
  const measured = new Map(), since = now - period * 1000;
  let unattributed = 0;
  for (const row of compression) {
    if (Date.parse(row.startTime) < since || Date.parse(row.startTime) > now + 60000) continue;
    const { host, runtime, agent } = identity(row), h = ensureHost(host, runtime);
    if (!h || !agentNames[agent]) { unattributed++; continue; }
    const key = h.id + '/' + agent;
    const outcome = attribute(row, 'compression.outcome');
    if (!normal.has(outcome) && row.level !== 'ERROR') { unattributed++; continue; }
    if (!measured.has(key)) measured.set(key, { compressed: 0, passthrough: 0, failed: 0, input: 0, output: 0, sizeSamples: 0, outcomes: {}, traceId: null, errorTraceId: null });
    const item = measured.get(key);
    const kind = row.level === 'ERROR' || !normal.has(outcome) ? 'failed' : outcome === 'compressed' ? 'compressed' : 'passthrough';
    item[kind]++; const label = kind === 'failed' ? 'Ошибка компрессии' : outcomeNames[outcome]; item.outcomes[label] = (item.outcomes[label] || 0) + 1;
    const before = number(attribute(row, 'compression.input_chars')), after = number(attribute(row, 'compression.output_chars'));
    if (before !== null && after !== null) { item.input += before; item.output += after; item.sizeSamples++; }
    item.traceId ||= safeTrace(row);
    if (kind === 'failed') item.errorTraceId ||= safeTrace(row);
  }
  const activities = new Map();
  for (const row of activity) {
    const at = Date.parse(row.startTime);
    if (!Number.isFinite(at) || at < since || at > now + 60000) continue;
    const { host, runtime, agent } = identity(row), h = ensureHost(host, runtime);
    if (!h || !agentNames[agent]) { unattributed++; continue; }
    const key = h.id + '/' + agent;
    if (!activities.has(key)) activities.set(key, { calls: 0, at: 0, sessions: new Set(), errors: 0, traceId: null });
    const a = activities.get(key); a.calls++; a.errors += row.level === 'ERROR' ? 1 : 0;
    if (at > a.at) { a.at = at; a.traceId = safeTrace(row); }
    if (row.sessionId) a.sessions.add(row.sessionId);
  }
  for (const h of hosts.values()) for (const agent of Object.keys(agentNames)) {
    const key = h.id + '/' + agent, proxy = h.services.filter(s => s.service === 'contextq' && s.agent === agent), a = activities.get(key), c = measured.get(key);
    if (!proxy.length && !a && !c) continue;
    h.agents.push({ id: key, agent, name: agentNames[agent], proxy, activity: a ? { ...a, sessions: a.sessions.size } : null, compression: c || null });
  }
  const issues = [], gaps = [];
  for (const h of hosts.values()) {
    if (!h.fresh) gaps.push({ host: h.id, title: h.name + ': нет свежей телеметрии', detail: h.at ? 'Последняя проверка старше 10 минут. Проверить монитор и маршрут отправки.' : 'За последние сутки не найдено проверок. Проверить установку монитора.' });
    for (const s of h.services) {
      const item = { host: h.id, service: s.name, title: h.name + ' · ' + s.name + (s.agent ? ' · ' + agentNames[s.agent] : ''), detail: s.reason, traceId: s.traceId };
      if (['error', 'warning'].includes(s.state)) issues.push(item);
      if (s.state === 'unknown') gaps.push(item);
    }
    for (const a of h.agents) {
      if (a.compression?.failed) issues.push({ host: h.id, title: h.name + ' · ' + a.name + ': ошибки компрессии', detail: a.compression.failed + ' измеренных вызовов завершились ошибкой за выбранный период.', traceId: a.compression.errorTraceId });
      if (a.activity?.errors) issues.push({ host: h.id, title: h.name + ' · ' + a.name + ': ошибки вызовов модели', detail: a.activity.errors + ' записей с уровнем ERROR за выбранный период.', traceId: a.activity.traceId });
    }
  }
  const history = [...new Map(incidents.map(row => [row.traceId || row.id, row])).values()].filter(r => Date.parse(r.startTime) >= now - 86400000 && Date.parse(r.startTime) <= now + 60000).map(row => {
    const { host, runtime, agent } = identity(row);
    const category = /^http_[45]\d\d$/.test(row.statusMessage || '') ? 'Ответ сервиса ' + row.statusMessage.slice(5) : { timeout: 'Сервис не ответил вовремя', startup_failed: 'Не удалось запустить сервис', configuration_drift: 'Настройки изменились', invalid_response: 'Некорректный ответ', request_failed: 'Ошибка запроса', missing_key: 'Не настроен доступ', delivery_failed: 'Не удалось отправить телеметрию', runtime_integrity: 'Проверка целостности не прошла' }[row.statusMessage] || 'Локальный инцидент ContextQ';
    const fingerprint = attribute(row, 'incident.fingerprint');
    return { host: host + '/' + runtime, agent: agentNames[agent] || 'ContextQ', title: category, at: Date.parse(row.startTime), fingerprint: /^[a-f0-9]{24}$/.test(fingerprint || '') ? fingerprint : safeTrace(row), occurrences: number(attribute(row, 'incident.occurrences')), traceId: safeTrace(row) };
  }).sort((a, b) => b.at - a.at);
  return { checkedAt: now, period, hosts: [...hosts.values()], issues, gaps, incidents: history, truncated, unattributed };
}
