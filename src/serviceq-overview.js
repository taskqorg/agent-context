import { monitorMetrics } from './monitor-protocol.js';
import {nativeFailureFields,validateNativeFailure} from './native-failure.js';
const exportCauses={payload_too_large:'Пакет exporter отвергнут по размеру даже после уменьшения; данные сохранены, требуется проверка размера spans',concurrency_limit:'Exporter превысил лимит параллельных отправок; требуется обновление batching',timeout:'Exporter не завершился в срок; событие сохранено',collector_unavailable:'Локальный collector не подтвердил identity или routing; проверить сервис',snapshot_unavailable:'Завершённый native turn недоступен; проверить источник',unacknowledged:'Exporter не подтвердил turn; событие сохранено',process_failed:'Exporter завершился с ошибкой; требуется локальная диагностика',unknown:'Сохранён прежний отказ без точной причины; ожидается диагностический retry'};
export function nativeExportExplanation(metrics, snapshotAt = null, failure = null) {
  const messages=Object.entries(exportCauses).filter(([code])=>metrics['native_export_'+code]>0).map(([code,text])=>text+' ('+metrics['native_export_'+code]+')');
  if(messages.length) messages.push('Максимум попыток в снимке: '+(metrics.native_export_attempts??'не измерено')+'. Ожидание eligibility на момент снимка: '+(Number.isFinite(metrics.native_export_retry_seconds)?Math.ceil(metrics.native_export_retry_seconds):'не измерено')+' сек.; это не текущий countdown и не доказательство выполнения retry');
  if(Number.isFinite(metrics.native_export_recovery_age_seconds))messages.push('Возраст последнего успешного retry на момент снимка: '+Math.round(metrics.native_export_recovery_age_seconds)+' сек.; это acknowledgement exporter, не Langfuse readback');
  if(messages.length) messages.push(Number.isFinite(snapshotAt)?'Время снимка: '+new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Bangkok'}).format(snapshotAt)+' BKK':'Время снимка неизвестно');
  if(failure) {
    const stages={snapshot:'создание snapshot',collector:'проверка collector',process:'exporter',acknowledgement:'проверка acknowledgement'};
    messages.push('Последний наблюдённый отказ '+new Intl.DateTimeFormat('ru-RU',{dateStyle:'short',timeStyle:'medium',timeZone:'Asia/Bangkok'}).format(failure.at)+' BKK · job '+failure.jobId.slice(0,12)+' · версия '+failure.version+' · '+stages[failure.stage]+' · SDK '+failure.sdkPhase+(failure.sdkErrorType?' · тип SDK '+failure.sdkErrorType:'')+(failure.sdkFailure?' · код SDK '+failure.sdkFailure:'')+' · exit '+(failure.exitCode??'неизвестно')+' · Node '+(failure.nodeCode??'неизвестно')+' · signal '+(failure.signal??'неизвестно')+' · '+(failure.elapsedMs??'не измерено')+' мс · захвачено stdout/stderr '+(failure.stdoutCapturedBytes??'не измерено')+'/'+(failure.stderrCapturedBytes??'не измерено')+' байт'+(failure.outputCapped?' · достигнут лимит захвата вывода':'')+(failure.httpStatus!==null?' · SDK HTTP '+failure.httpStatus:'')+'; это receipt одного отказа, не причина всех заданий');
  }
  return messages.join('. ');
}
const freshness = 10 * 60 * 1000;
const tag = (row, key) => row.tags?.find(t => t.startsWith(key + ':'))?.slice(key.length + 1);
const attribute = (row, key) => row.metadata?.['attributes.agent_context.' + key];
const number = value => Number.isFinite(value) && value >= 0 ? value : null;
export const hostNames = { 'mac/native': 'Mac', 'windows/native': 'Windows', 'windows/wsl': 'Windows · WSL', 'fra/native': 'FRA' };
export const agentNames = { codex: 'Codex', hermes: 'Hermes', 'claude-code': 'Claude Code' };
export const serviceNames = { contextq: 'ContextQ', serverq: 'ServerQ', taskq: 'TaskQ', gateway: 'Сборщик телеметрии', 'hermes-gateway': 'Hermes Gateway', langfuse: 'Langfuse', updater: 'Обновления' };
export const reasons = {
  worker_retiring:'Новые соединения идут в новую версию; старая обслуживает прежние.',
  worker_update_failed:'Новый worker не прошёл проверку или упал; проверьте инциденты.',
  native_stats_unavailable: 'Штатные счётчики Headroom недоступны. Обработка Codex не подтверждена.',
  native_exporter_missing: 'Не подключён native exporter агента или выключены его hooks. Завершить онбординг.',
  telemetry_delivery_unverified: 'Доставка этого агента в Langfuse не подтверждена. Монитор повторит проверку.',
  proxy_health_not_agent_liveness: 'Прокси доступен. Активность агента показана отдельно.',
  proxy_unavailable: 'Прокси недоступен — проверить локальный сервис ContextQ.',
  compression_telemetry_disabled: 'В прокси отключена телеметрия компрессии.',
  telemetry_delivery_failed:'Ошибка отправки телеметрии; данные остаются в очереди.',
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
const normal = new Set(['compressed', 'retrieval', 'content_type', 'ineligible', 'no_gain', 'empty', 'too_large', 'request_budget', 'passthrough']);
const failures = {
  bridge_unavailable: 'Файл компрессора недоступен', bridge_failed: 'Не удалось запустить компрессор',
  missing_current_query: 'Не определён текущий запрос', timeout: 'Превышено время сжатия',
  missing_key: 'Не настроен доступ к компрессору', key_conflict: 'Конфликт настроек доступа',
  request_failed: 'Ошибка запроса к компрессору', invalid_response: 'Некорректный ответ компрессора',
  neural_unavailable: 'SuperCompress Neural недоступен',
  fallback: 'Сбой обработки контекста', lost_critical_evidence: 'Компрессор потерял важные данные',
  invalid_device_config: 'Некорректная регистрация устройства', invalid_key_config: 'Некорректные настройки доступа'
};
export const outcomeNames = { compressed: 'Сжато', passthrough: 'Передано без сокращения', retrieval: 'Чтение сохранённого оригинала', content_type: 'Тип данных не подходит', ineligible: 'Блок не требует сжатия', no_gain: 'Сжатие не дало выигрыша', empty: 'Пустой блок', too_large: 'Блок превышает лимит', request_budget: 'Лимит обработки запроса' };
const identity = row => ({ host: tag(row, 'host') || attribute(row, 'host'), runtime: tag(row, 'runtime') || attribute(row, 'runtime') || 'native', agent: tag(row, 'agent') || attribute(row, 'agent') });
const safeTrace = row => /^[a-zA-Z0-9_-]{1,128}$/.test(row.traceId || '') ? row.traceId : null;
const safeId = value => typeof value === 'string' && /^[a-zA-Z0-9_.:-]{1,128}$/.test(value) ? value : null;
const usageKeys = ['input', 'output', 'total', 'input_cached_tokens', 'cache_read_input_tokens', 'input_cache_creation_1h', 'input_cache_creation_5m', 'output_reasoning_tokens'];

export function reportFilters(params) {
  const filters = {};
  for (const key of params.keys()) if (!['period', 'host', 'agent', 'session'].includes(key)) throw new Error('Invalid report filter');
  for (const key of ['host', 'agent', 'session']) {
    const value = params.get(key);
    if (value === null) continue;
    if (key === 'host' ? !/^[a-zA-Z0-9_-]{1,64}\/(native|wsl)$/.test(value) : key === 'agent' ? !Object.hasOwn(agentNames, value) : !safeId(value)) throw new Error('Invalid report filter');
    filters[key] = value;
  }
  return filters;
}

export function overview({ health = [], compression = [], nativeTools = [], activity = [], incidents = [], truncated = [] }, now = Date.now(), period = 1800, filters = {}) {
  // Langfuse v4 synthetic roots mirror incident spans; count the real observations only.
  const physical = rows => rows.filter(row => !row.id?.startsWith('t-'));
  health = physical(health); compression = physical(compression); nativeTools = physical(nativeTools); activity = physical(activity); incidents = physical(incidents);
  const matches = row => {
    const { host, runtime, agent } = identity(row);
    return (!filters.host || filters.host === host + '/' + runtime) && (!filters.agent || filters.agent === agent) && (!filters.session || filters.session === row.sessionId);
  };
  compression = compression.filter(matches); nativeTools = nativeTools.filter(matches); activity = activity.filter(matches);
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
      h.update = { installed: semver('installed'), available: semver('available'), monitor: semver('monitor'), enabled: [true, 'true'].includes(attribute(row, 'update.enabled')) ? true : [false, 'false'].includes(attribute(row, 'update.enabled')) ? false : null, status: ['ready', 'checking', 'current', 'migration_required', 'paused', 'staged_wait', 'downloading', 'testing', 'downloaded', 'updated', 'failed', 'rolled_back', 'no_stable_release', 'disabled_before_activation'].includes(status) ? status : 'unknown', subscription: ['connected', 'reconnecting', 'disabled'].includes(subscription) ? subscription : 'unknown', checkedAt: number(attribute(row, 'update.checkedAt')) };
    }
    h.at = Math.max(h.at || 0, at); h.fresh = now - h.at <= freshness;
    const metrics = {};
    for (const key of monitorMetrics) metrics[key] = number(attribute(row, 'monitor.' + key));
    let nativeFailure=null;
    if(attribute(row,'native_failure.schema')!==undefined) {
      const receipt=Object.fromEntries(nativeFailureFields.map(key=>[key,attribute(row,'native_failure.'+key)??null]));
      try {nativeFailure=validateNativeFailure(receipt,at);}catch {/* Untrusted fields never become explanations. */}
    }
    const exportExplanation=now-at<=freshness?nativeExportExplanation(metrics,at,nativeFailure):'';
    h.services.push({ service, name: serviceNames[service], agent: agentNames[agent] ? agent : null, state: now - at > freshness ? 'unknown' : tag(row, 'state'), nativeFailure: now - at > freshness ? null : nativeFailure, reason: now - at > freshness ? 'Нет свежей проверки более 10 минут.' : [reasons[row.statusMessage] || 'Нет объяснения состояния.',exportExplanation].filter(Boolean).join(' '), metrics, at, traceId: safeTrace(row), proxyVersion: /^\d+\.\d+\.\d+$/.test(attribute(row, 'proxy.version') || '') ? attribute(row, 'proxy.version') : null, retiringVersion: /^\d+\.\d+\.\d+$/.test(attribute(row,'proxy.retiring_version')||'')?attribute(row,'proxy.retiring_version'):null, monitorVersion: /^\d+\.\d+\.\d+$/.test(attribute(row, 'version') || '') ? attribute(row, 'version') : null });
  }
  const measured = new Map(), since = now - period * 1000;
  let unattributed = 0;
  for (const row of compression) {
    const at = Date.parse(row.startTime);
    if (!Number.isFinite(at) || at < since || at > now + 60000) continue;
    const { host, runtime, agent } = identity(row), h = ensureHost(host, runtime);
    if (!h || !agentNames[agent]) { unattributed++; continue; }
    const key = h.id + '/' + agent;
    const outcome = attribute(row, 'compression.outcome');
    if (!measured.has(key)) measured.set(key, { compressed: 0, passthrough: 0, failed: 0, unknown: 0, input: 0, output: 0, sizeSamples: 0, outcomes: {}, traceId: null, errorTraceId: null, unknownTraceId: null });
    const item = measured.get(key);
    const failure = Object.hasOwn(failures, outcome) ? failures[outcome] : /^http_[45]\d\d$/.test(outcome || '') ? 'Ошибка ответа сервиса компрессии' : null;
    if (!normal.has(outcome) && !failure && row.level !== 'ERROR') {
      item.unknown++; item.unknownTraceId ||= safeTrace(row); continue;
    }
    const kind = row.level === 'ERROR' || failure ? 'failed' : outcome === 'compressed' ? 'compressed' : 'passthrough';
    item[kind]++; const label = kind === 'failed' ? failure || 'Ошибка компрессии' : outcomeNames[outcome]; item.outcomes[label] = (item.outcomes[label] || 0) + 1;
    const before = number(attribute(row, 'compression.input_chars')), after = number(attribute(row, 'compression.output_chars'));
    if (before !== null && after !== null) { item.input += before; item.output += after; item.sizeSamples++; }
    item.traceId ||= safeTrace(row);
    if (kind === 'failed') item.errorTraceId ||= safeTrace(row);
  }
  const native = new Map(), seen = new Set();
  for (const row of nativeTools) {
    const at = Date.parse(row.startTime);
    if (!Number.isFinite(at) || at < since || at > now + 60000) continue;
    const { host, runtime, agent } = identity(row), h = ensureHost(host, runtime);
    if (!h || !agentNames[agent]) { unattributed++; continue; }
    const key = h.id + '/' + agent;
    const eventId = attribute(row, 'compression.id'), stableId = /^[a-f0-9-]{36}$/.test(eventId || '') ? eventId : null;
    const device = safeId(tag(row, 'device') || attribute(row, 'device'));
    // shortcut: old events without device/event IDs use observation IDs; upgrade when producers supply both.
    const dedup = device && stableId ? JSON.stringify([device, key, stableId]) : row.id ? 'span:' + row.id : null;
    if (dedup && seen.has(dedup)) continue;
    if (dedup) seen.add(dedup);
    if (!native.has(key)) native.set(key, { calls: 0, samples: 0, input: null, output: null, reduced: 0, unchanged: 0, expanded: 0, unknown: 0, exitSamples: 0, nonzeroExits: 0, sessionLinks: 0, callLinks: 0, stableIds: 0, origins: { production: 0, qualification: 0, unknown: 0 }, traceId: null, tokenSource: 'rtk_estimate', timeBasis: 'delivery', includesWrapperOverhead: false });
    const item = native.get(key); item.calls++;
    item.stableIds += Boolean(device && stableId);
    item.sessionLinks += Boolean(safeId(row.sessionId));
    item.callLinks += Boolean(safeId(attribute(row, 'tool_call_id')));
    const origin = attribute(row, 'compression.origin');
    item.origins[origin === 'production' || origin === 'qualification' ? origin : 'unknown']++;
    const before = number(attribute(row, 'compression.input_tokens')), after = number(attribute(row, 'compression.output_tokens'));
    if (attribute(row, 'compression.strategy') === 'rtk-native' && attribute(row, 'compression.token_source') === 'rtk_estimate' && before !== null && after !== null) {
      item.samples++; item.input = (item.input ?? 0) + before; item.output = (item.output ?? 0) + after;
      item[after < before ? 'reduced' : after > before ? 'expanded' : 'unchanged']++;
    } else item.unknown++;
    const exit = attribute(row, 'compression.exit_code');
    if (Number.isSafeInteger(exit)) { item.exitSamples++; item.nonzeroExits += exit !== 0; }
    item.traceId ||= safeTrace(row);
  }
  const activities = new Map();
  for (const row of activity) {
    const at = Date.parse(row.startTime);
    if (!Number.isFinite(at) || at < since || at > now + 60000) continue;
    const { host, runtime, agent } = identity(row), h = ensureHost(host, runtime);
    if (!h || !agentNames[agent]) { unattributed++; continue; }
    const key = h.id + '/' + agent;
    if (!activities.has(key)) activities.set(key, { calls: 0, at: 0, sessions: new Set(), errors: 0, traceId: null, models: {} });
    const a = activities.get(key); a.calls++; a.errors += row.level === 'ERROR' ? 1 : 0;
    if (at > a.at) { a.at = at; a.traceId = safeTrace(row); }
    if (row.sessionId) a.sessions.add(row.sessionId);
    const model = typeof row.model === 'string' && /^[a-zA-Z0-9_.:/-]{1,128}$/.test(row.model) ? row.model : 'unknown';
    if (!Object.hasOwn(a.models, model)) Object.defineProperty(a.models, model, { value: { calls: 0, usage: {}, usageSamples: {}, reportedCost: null, costSamples: 0, traceId: safeTrace(row) }, enumerable: true });
    const m = a.models[model]; m.calls++;
    for (const field of usageKeys) {
      const value = number(row.usageDetails?.[field]);
      if (value !== null) { m.usage[field] = (m.usage[field] ?? 0) + value; m.usageSamples[field] = (m.usageSamples[field] ?? 0) + 1; }
    }
    const cost = number(row.costDetails?.total);
    if (cost !== null) { m.reportedCost = (m.reportedCost ?? 0) + cost; m.costSamples++; }
  }
  for (const h of hosts.values()) for (const agent of Object.keys(agentNames)) {
    const key = h.id + '/' + agent, proxy = h.services.filter(s => s.service === 'contextq' && s.agent === agent), a = activities.get(key), c = measured.get(key), rtk = native.get(key);
    if (filters.agent && filters.agent !== agent || !proxy.length && !a && !c && !rtk) continue;
    h.agents.push({ id: key, agent, name: agentNames[agent], proxy, activity: a ? { ...a, sessions: a.sessions.size } : null, compression: c || null, nativeRtk: rtk || null });
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
      if (a.compression?.unknown) gaps.push({ host: h.id, title: h.name + ' · ' + a.name + ': неизвестный результат компрессии', detail: a.compression.unknown + ' записей с отсутствующим или неизвестным результатом. Они не считаются ни успехом, ни ошибкой; проверить запись и версию отправщика.', traceId: a.compression.unknownTraceId });
      if (a.compression?.failed) issues.push({ host: h.id, title: h.name + ' · ' + a.name + ': ошибки компрессии', detail: a.compression.failed + ' измеренных вызовов завершились ошибкой за выбранный период.', traceId: a.compression.errorTraceId });
      if (a.activity?.errors) issues.push({ host: h.id, title: h.name + ' · ' + a.name + ': ошибки вызовов модели', detail: a.activity.errors + ' записей с уровнем ERROR за выбранный период.', traceId: a.activity.traceId });
      if (a.nativeRtk && (a.nativeRtk.unknown || a.nativeRtk.sessionLinks < a.nativeRtk.calls || a.nativeRtk.callLinks < a.nativeRtk.calls || a.nativeRtk.origins.unknown)) gaps.push({ host: h.id, title: h.name + ' · ' + a.name + ': неполный учёт RTK', detail: 'Событий: ' + a.nativeRtk.calls + '; с session ID: ' + a.nativeRtk.sessionLinks + '; с tool-call ID: ' + a.nativeRtk.callLinks + '; без оценки: ' + a.nativeRtk.unknown + '; неизвестное происхождение: ' + a.nativeRtk.origins.unknown + '. Охват всех команд не измерен.', traceId: a.nativeRtk.traceId });
    }
  }
  const history = [...new Map(incidents.map(row => [row.traceId || row.id, row])).values()].filter(r => Date.parse(r.startTime) >= now - 86400000 && Date.parse(r.startTime) <= now + 60000).map(row => {
    const { host, runtime, agent } = identity(row);
    const category = /^http_[45]\d\d$/.test(row.statusMessage || '') ? 'Ответ сервиса ' + row.statusMessage.slice(5) : { timeout: 'Сервис не ответил вовремя', startup_failed: 'Не удалось запустить сервис', configuration_drift: 'Настройки изменились', invalid_response: 'Некорректный ответ', request_failed: 'Ошибка запроса', missing_key: 'Не настроен доступ', delivery_failed: 'Не удалось отправить телеметрию', runtime_integrity: 'Проверка целостности не прошла' }[row.statusMessage] || 'Локальный инцидент ContextQ';
    const fingerprint = attribute(row, 'incident.fingerprint');
    return { host: host + '/' + runtime, agent: agentNames[agent] || 'ContextQ', title: category, at: Date.parse(row.startTime), fingerprint: /^[a-f0-9]{24}$/.test(fingerprint || '') ? fingerprint : safeTrace(row), occurrences: number(attribute(row, 'incident.occurrences')), traceId: safeTrace(row) };
  }).sort((a, b) => b.at - a.at);
  const hostMatch = h => !filters.host || h.id === filters.host;
  return { checkedAt: now, period, filters, hosts: [...hosts.values()].filter(hostMatch), issues: issues.filter(i => !filters.host || i.host === filters.host), gaps: gaps.filter(i => !filters.host || i.host === filters.host), incidents: history.filter(i => (!filters.host || i.host === filters.host) && (!filters.agent || i.agent === agentNames[filters.agent])), truncated, unattributed };
}
