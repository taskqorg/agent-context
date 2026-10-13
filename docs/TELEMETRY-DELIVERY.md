# Телеметрия и сравнение компрессоров — кандидат 2026-10-11

Текущий кандидат — **0.3.0, локальный Headroom**, без облачного компрессора.
Актуальные результаты: [telemetry-0.3.0-qualification.json](../evidence/telemetry-0.3.0-qualification.json.gz).
Разделы ниже до `Claude correlation` описывают предыдущую диагностику и не
подтверждают текущее внедрение. Полная квалификация всех хостов ещё не завершена.

Статус: **проверен кандидат, рабочее внедрение не завершено**. Ветка `codex/telemetry-delivery`; SuperCompress остаётся текущим компрессором. Рабочие профили, gateway и контейнеры не переключались. Нового стабильного релиза нет.

## Исправления пакета

- Installer проверяет содержимое конфигурации Langfuse вместо наличия файла. Отключённая, пустая или повреждённая конфигурация не включает экспорт.
- Сервис и отдельный `run` передают фактические host/runtime; WSL отмечается `host:windows`, `runtime:wsl`. Linux по умолчанию обозначается `linux`; для FRA запуск должен задавать `AGENT_CONTEXT_HOST=fra`. Путь проекта не используется для определения сервера.
- Настройка сохраняет чужие теги и добавляет одинаковые agent/host/runtime теги в существующие native exporters. При наличии credentials setup устанавливает отсутствующий official Codex plugin штатным CLI в фактический CODEX_HOME. Native login, hook trust и approvals сохраняются; trust/delivery остаются отдельной проверкой. Claude/Hermes native onboarding пока не автоматизирован полностью; setup честно сообщает `needs_attention`.
- SuperCompress получает настоящую сессию и агента вместо глобального `headroom`; при отсутствии сессии сохраняется отдельный request ID и явная отметка отсутствия native identity.
- Путь Codex WebSocket обходил стандартную Pipeline-трассировку Headroom. Событие добавлено непосредственно в адаптер SuperCompress и сравниваемый native router. Передаются исходы, размеры в символах, время и native session/turn. Тексты и ключи не добавляются в эти spans.
- `doctor --live` показывает фактическую версию, компрессор, состояние экспорта и исходы адаптера. Отсутствующий exporter, отключённая compression telemetry или непроверенная доставка дают ошибку. Рабочий процесс старой версии остаётся активным до безопасного обновления.
- `agent-context telemetry verify [codex|claude|hermes]` отправляет небольшой синтетический OTLP span в `qualification` и читает его через v2 observations API. Требует совпадения trace/session/tags/environment. HTTP acceptance отдельно от readback. Проверка привязана к проектным ключам, адресу, host/runtime/version и действует 24 часа.
- Синтетическая проверка **не доказывает работу native exporter**. Его установка и доставка реального поколения показаны отдельным статусом; нельзя считать generation telemetry включённой по наличию compression spans.

## Живые доказательства

Langfuse 4.56.0 в режиме `events_only` отвергает legacy `trace-create` через `/api/public/ingestion`. Проверка использует установленный OTLP SDK, а не переводит сервер обратно в dual write.

- OTLP delivery check: trace `9bc92441c56aa16b09cc4bc218dbcb77` прочитан обратно с session/tags/environment.
- Настоящий вызов SuperCompress из Codex: trace `1311800386df2ea772bf128a5c3d60f0`, session `01a129cf-0c60-7fd0-bd0c-342a916b98d0`, turn `01a129cf-0ea9-7232-a549-208adeff87d9`; outcome `compressed`, 11899 → 3898 символов. Это размер фрагмента, не экономия model tokens.
- Второй SC trace: `fd98d2ca92e1995fc80773d2ebb0ab56`.
- Native Headroom: traces `be9db05f0125a9ff7c810b3e6987b57f` и `0654462f5db8e5dd990a82ea3f20c334` с `compressed`; последующие события и фактические retrieval calls также учтены.

Generation/tool export и compression пока связываются через native session/turn, **не гарантированно находятся в одном дереве trace**. Для общего дерева нужен реальный parent/trace context native exporter; выдуманный parent не создаётся. Тег проекта также требует достоверного источника на уровне хода: один общий прокси обслуживает несколько проектов.

## Сравнение — реальные суммарные model tokens

| Задание | Режим | Input | Cached input | Output | Время, с | Retrieval |
|---|---|---:|---:|---:|---:|---:|
| error | без сжатия | 31360 | 24192 | 84 | 9.93 | 0 |
| error | SuperCompress | 29815 | 24192 | 89 | 13.29 | 0 |
| error | Headroom native | 52749 | 44160 | 164 | 16.82 | 1 |
| routine | без сжатия | 27072 | 22016 | 79 | 7.63 | 0 |
| routine | SuperCompress | 25405 | 19712 | 89 | 11.43 | 0 |
| routine | Headroom native | 52729 | 46848 | 157 | 15.23 | 1 |

Все шесть заданий сохранили проверяемые факты. SC сократил input на 4.9% и 6.2%, добавил 3.4–3.8 секунды. Native потребовал восстановления и увеличил input на 68.2% и 94.8%. Один повтор, различающийся тёплый cache; это не устойчивый benchmark, не доказательство экономии денег и не квалификация Windows/Hermes. Отдельная цена вызовов SC не выводилась как generation cost. Полные числовые результаты: [telemetry-compressor-benchmark.json](https://github.com/taskqorg/agentq/blob/9612eeefcff773edd9c959f093fb76cf56acbc2c/docs/telemetry-compressor-benchmark.json).

## FRA: отдельный кандидат исправления существующего observer

[FRA-TELEMETRY-CANDIDATE.patch](https://github.com/taskqorg/agentq/blob/9612eeefcff773edd9c959f093fb76cf56acbc2c/docs/FRA-TELEMETRY-CANDIDATE.patch) исправляет передачу session/tags/environment через `propagate_attributes` на каждом observer event и делает отказ очереди видимым. Исходники взяты из текущего `tight-langfuse` 1.1.0; это отдельный компонент, не новый tracing engine внутри пакета.

Кандидат запускается из приватного `/tmp` на FRA с существующими локальными credentials. Синтетические события не вызывают модель, не перезапускают gateway и не изменяют рабочий плагин. Результат нужно проверять по observations, а не по exit code worker. Исправление ещё не развёрнуто. Статус worker, скрытый stderr и доставка реальных gateway events требуют отдельной квалификации.

Readback подтверждён: trace `d912bc50a4d02f39ffcfe34823457011`, session `agent-context-hermes-qualification-096f1cfbc13543019927cac8f5d8f1fd`. Root, synthetic generation и tool имеют `agent:hermes`, `host:fra`, `runtime:native`, environment `qualification` и одну сессию; tool/generation связаны с root. Usage пустой: реальные model calls не выполнялись. Первый tool-only fixture не создал root и дал ноль observations, несмотря на exit code 0; поэтому это не считалось успехом.

Подтверждённый пользователем onboarding: агент объясняет действия, открывает локальный скрытый ввод, пользователь вводит собственные ключи, пакет сохраняет их только в этом профиле. Команды `set-key` и `set-langfuse`; non-TTY provisioning принимает private stdin. Ключи не вшиваются в публичный пакет/ссылку, не вводятся в чат и не переносятся между хостами агентом. Windows ACL и ввод в native UI нуждаются в отдельной проверке.

## До рабочего завершения

1. Подключить/квалифицировать official Codex exporters Windows/WSL/FRA и установленные Claude/Hermes exporters. Сохранять native trust; не переносить ключи между хостами.
2. Квалифицировать и применить FRA observer patch через поддерживаемый reload, с readback нового реального хода и проверкой очереди/логов.
3. Исправить bounded upload/backlog native Codex plugin без потери маркеров и без бессрочного повторения полного rollout. Не редактировать trusted hook без нового рассмотрения точного hash.
4. Устранить ClickHouse memory-limit/worker timeout и большие upload bodies по источнику и размеру партии. Здоровый контейнер или увеличение RAM не доказывают доставку.
5. Проверить durable/cloud runtime отдельно: локальная настройка Mac не доказывает охват DOTSLAVE/Arm TaskQ.
6. Связать generation/tool/compression/retrieval общим реальным trace context, добавить project identity и сохранённые dashboard filters.
7. Подготовить точный review/DEV/LIVE пакет перед рабочим rollout. Текущая квалификация не является стабильным релизом.

Документация: [Langfuse best practices](https://langfuse.com/docs/observability/best-practices), [SDK/OTLP](https://langfuse.com/docs/observability/sdk/overview), [Codex integration](https://langfuse.com/integrations/developer-tools/codex).

## Claude correlation in the local 0.3.0 candidate

Claude's official exporter records native `tool_id` and a parent conversational
turn. The proxy receives the same `tool_use_id` in Anthropic tool results but
normally receives no native turn ID. Request middleware records the validated
IDs from the latest user message as `agent_context.request_tool_result_ids`.
Join these with native tool observations **within the same native session** to
locate the owning turn. This is request-level context, not a claim that every
listed tool block was compressed. Historical tool IDs and payloads are omitted;
a subsequent request without tool results clears this attribute.

`native_turn_missing` remains true when no native turn ID was supplied. The
adapter does not invent one or modify the native Claude exporter or Headroom.

Hermes emits native turn IDs as `session:task:turn`. Both header and request-body
identity validation accept these bounded IDs, including colons; control characters
and IDs longer than 128 characters remain rejected. This preserves the original
ID for matching compression with the native Hermes root, without rewriting it.

Hermes `terminal` and `read_file` return JSON envelopes. The candidate plugin sends
only their string `output` or `content` field to the public compression endpoint,
then restores the envelope with all other fields unchanged. Unknown tools and
unrecognized envelope shapes keep the existing whole-result path. Small payloads,
no gain and failed requests leave the original result intact. Headroom itself is
unchanged. Compression counters measure the submitted **payload**, excluding the
preserved envelope; a recovery marker retrieves that exact original payload.

## FRA Hermes: capture depth

The existing `tight-langfuse` external exporter defaults to depth 4, counting
the worker event envelope. That replaces `response.assistant_message.content`
with a truncation marker before Langfuse receives it. The installer now sets the
exporter's existing `HERMES_LANGFUSE_MAX_DEPTH=10` in Hermes `.env` when absent.
Explicit owner values are preserved; the bundled `observability/langfuse`
exporter is not affected. Normal install backup/undo covers this configuration.

The identical native FRA control with depth 10 delivered the exact final answer,
two generations, one tool and compression under the correct session/turn.
No Headroom, Hermes core or exporter source change was needed. Redaction and
bounded capture remain enabled. Hermes' observer hooks additionally enforce a
50,000-character payload cap and can reduce individual strings to 1,000
characters; input previews are **not** proof of complete model-input capture.

Local compression does not mean Headroom's full air-gap mode. In Headroom 0.40,
`HEADROOM_OFFLINE=1` forbids Langfuse export even to a configured loopback collector.
The enrolled shutdown test explicitly uses `HEADROOM_OFFLINE=0` for its synthetic
local exporter; its destination remains unreachable loopback and spans must stay
in the private queue. Model downloads and cloud compressors remain disabled.
Windows queue fixtures provide the same launcher as an installed profile; native
ACL validation belongs to the real Windows private-file test, not POSIX mode bits.


## Telemetry contract v1

All managed native exporters and compression exporters send OTLP to their agent's
loopback collector. It applies the same labels before durable enqueue. Enrolled
profiles then use the authenticated gateway; direct profiles use their configured
Langfuse destination. `agent_context_base_url` retains that upstream when Codex's
`base_url` points to the collector. Never use a loopback collector as its upstream.

| Field | Source / meaning |
| --- | --- |
| `user.id`, `langfuse.user.id` | Enrollment GitHub login; direct profiles use explicit shared `user_id` in Langfuse config. Never infer from email or OS username. |
| `agent_context.host`, `runtime`, `agent` | Profile host, native/WSL runtime, codex/claude-code/hermes; mirrored in tags. |
| `agent_context.telemetry.schema` | Contract version 1. |
| Session, turn, trace and observation IDs | Preserve native IDs; gateway trace namespace stays deterministic per device. |
| Missing user / measurement | Absent, never a fabricated user or zero. Doctor reports missing canonical user. |
| Environment | production/development/qualification; tests never claim production health. |

Per-compression observations carry `compression.outcome`, `input_chars`,
`output_chars`, and `elapsed_ms`: one operation, characters and milliseconds.
Character reduction is `(sum(input_chars) - sum(output_chars)) / sum(input_chars)`
for the same observed events, only when the denominator is positive. It is not
billed token or cost savings. Router coverage is partial and excludes unmeasured
traffic; no request denominator is inferred from compression-call counts.

Monitor `monitor.*` values are diagnostic snapshots. Compression call/character
sums and totals accumulate since process start, maximums are process maximums,
queue size/age and active connections are current gauges. Do not sum snapshots,
derive a rate without reset-aware deltas, or mix their units on one chart.
Only fresh known-state health verdicts remain Scores (0/1); unknown has no score.
Queue/counter widgets using the old Scores are removed from the dashboard template;
the ServiceQ panel reads the existing snapshot metadata instead.

Model latency, actual input/cache/output tokens and cost come from native
GENERATION observations. Compression observations do not emit generation usage.
Use percentiles of per-operation elapsed time for compression latency, never a
process lifetime maximum or character count. Retries retain event IDs and queued
bytes; partial ingestion rejection retains the batch.

This changes future managed exports. Old aliases and mixed Scores remain historical.
Filter by contract metadata and deployment time for acceptance; do not silently
merge Unknown/email/login history or compare qualification with production.
