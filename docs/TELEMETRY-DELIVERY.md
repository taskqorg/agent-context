# Телеметрия и сравнение компрессоров — кандидат 2026-10-11

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

Все шесть заданий сохранили проверяемые факты. SC сократил input на 4.9% и 6.2%, добавил 3.4–3.8 секунды. Native потребовал восстановления и увеличил input на 68.2% и 94.8%. Один повтор, различающийся тёплый cache; это не устойчивый benchmark, не доказательство экономии денег и не квалификация Windows/Hermes. Отдельная цена вызовов SC не выводилась как generation cost. Полные числовые результаты: [telemetry-compressor-benchmark.json](telemetry-compressor-benchmark.json).

## FRA: отдельный кандидат исправления существующего observer

[FRA-TELEMETRY-CANDIDATE.patch](FRA-TELEMETRY-CANDIDATE.patch) исправляет передачу session/tags/environment через `propagate_attributes` на каждом observer event и делает отказ очереди видимым. Исходники взяты из текущего `tight-langfuse` 1.1.0; это отдельный компонент, не новый tracing engine внутри пакета.

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
