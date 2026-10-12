# Установка в рабочие профили: 0.1.11

Проверено 2026-10-10 UTC / 2026-10-11 Bangkok. Пакет установлен на Mac, FRA, Windows и WSL. Полная задача ещё не закрыта: Windows/WSL Langfuse не настроен, публичный квалифицированный релиз не опубликован, нативный сборщик TaskQ #612 остаётся отдельной незавершённой работой.

Пользователь отдельно разрешил передать только настройки общего Langfuse Agents с Mac на Windows/WSL. Три поля переданы через защищённый Taildrop, временная копия на Mac удалена. WIN_CSGO подтвердил получение и ограничение ACL, но остановился перед записью настроек: источник разрешения недоступен из его сессии, он запросил прямое подтверждение там. Установленные агентские входы и работающие сервисы не менялись. События Windows/WSL в Langfuse ещё не проверены.

## Зафиксированный пакет

- Версия: `@alexkirs/agent-context@0.1.11`.
- Архив: `/tmp/agent-context-0.1.11-d8bd15e7.tgz`.
- SHA256: `d8bd15e759d5cf87d1224a6a0ee027a79560c7795a646dd856befd565151825b`.
- Проверки исходников: 51 Node, 8 Python Headroom — PASS. Проверки архива на Windows: 50 PASS, 1 штатный skip теста, требующего Git checkout.
- Node 22+; установленный Python 3.11–3.13; Headroom 0.40.0 в частном окружении. Архив не содержит ключей и Python bytecode.

Одна команда установки доставленного архива, с его локальным путём:

```sh
npm exec --yes --package=/tmp/agent-context-0.1.11-d8bd15e7.tgz -- agent-context setup
```

На Windows путь к архиву свой; на FRA выбраны установленные агенты `setup codex hermes`, на Windows/WSL — `setup codex claude`. `setup` без списка настраивает все три интеграции. Эта команда не устанавливает сами агенты, Node или системный Python. Публичного npm-пакета этой версии пока нет.

Проверка и ограниченное восстановление установленного пакета:

```sh
agent-context doctor --fix --live
```

## Рабочие машины

| Машина | Выбранный пакет | Собственные сервисы | Реальный агентский вызов | Langfuse сжатия |
| --- | --- | --- | --- | --- |
| Mac | 0.1.11 | Все healthy; Claude/Hermes 0.1.11; Codex 0.1.9 сохранён до завершения активного соединения | Codex PASS на 0.1.9; Claude и Hermes PASS на 0.1.11 | Доставка 0.1.11 подтверждена |
| FRA Linux | 0.1.11 | Codex/Hermes 0.1.11 healthy | Codex и Hermes PASS на 0.1.9; прямой маршрут сжатия 0.1.11 PASS | Доставка 0.1.11 подтверждена |
| Windows | 0.1.11 | Codex/Claude 0.1.11 healthy | Codex и Claude PASS на 0.1.10, согласно WIN_CSGO | Не настроен; doctor предупреждает |
| WSL Ubuntu | 0.1.11 | Codex/Claude 0.1.11 healthy | Codex PASS на 0.1.9, Claude PASS на 0.1.7, согласно WIN_CSGO | Не настроен; doctor предупреждает |

Версионные повторы модельных вызовов на Windows/WSL не выполнялись: изменения 0.1.11 относятся к обнаружению конфликтов, optional telemetry и упаковке; агентские маршруты не менялись. Это не доказательство модельного вызова именно финального архива на каждой строке. Claude отсутствует на FRA, Hermes отсутствует в рабочих Windows/WSL профилях.

Нативные вход, разрешения инструментов, другие MCP и существующая телеметрия сохранены. Для синтетического Codex-теста отдельно разрешены только проверенные read_fixture и read-only retrieval. На FRA плагин Hermes подключён через штатный reload handlers без перезапуска gateway. Windows и WSL используют разные порты, чтобы не конфликтовать через localhost forwarding.

## Сжатие и экономия

На 0.1.11 прямой синтетический маршрут на Mac/FRA: 11 644 → 922 символа, соответственно 2445/2284 мс. Release `amber-47`, порт `6543` и retry limit `2` сохранились; пользовательский запрос не изменился.

Langfuse подтвердил production SPAN, версию 0.1.11 и исходную сессию:

| Проверка | Контекст до → после, оценка токенов Headroom | Сохранено |
| --- | --- | --- |
| Mac Hermes, реальный read_file | 3941 → 315 | 3626 |
| Mac Claude, реальный Read | 14792 → 12199 | 2593 |
| FRA Hermes, прямой synthetic route | 2925 → 245 | 2680 |

Не суммировать transform и pipeline одной операции. События сжатия имеют тип SPAN и не дублируют стоимость generation. Host tag пока `unknown`, если AGENT_CONTEXT_HOST не передан; машину инцидентов различает отдельный UUID.

Ранний парный Codex benchmark реального чтения src/update.js: input 32087 → 27693 (-13.69%), uncached input -32.97%, факты PASS и один вызов инструмента в обеих ветках. Это небольшой тест, а не доказанная экономия на всём проекте или денежная экономия подписки. Подробности: HEADROOM-QUALIFICATION.md и benchmark-code-results.json.

## Конфликты, обновления, восстановление

Setup и doctor проверяют известные пользовательские и проектные регистрации MCP, hooks и enabled plugins. Обнаруженный другой compressor даёт `possible_double_compression`; ошибка чтения — `compression_inventory_incomplete`. Чужие плагины автоматически не отключаются. Собственные retrieval и выключенный legacy compressor не создают ложное предупреждение; Langfuse не считается сжатием. В проверенных профилях конкурирующих compressor registrations не обнаружено. Неизвестные названия и скрытая логика стороннего плагина могут остаться незамеченными.

Автообновление включено: ежедневная проверка квалифицированного stable patch релиза, контроль архива и runtime, подготовка до переключения, сохранённая предыдущая версия. Проверка staging выполнена ранее; удалённый выпуск 0.1.11 не публиковался. Обновление занятого собственного proxy откладывается, чужие процессы не завершаются.

Doctor восстанавливает только проверенные собственные регистрации, перезапускает только собственные сервисы и использует проверенный rollback при повреждении managed runtime. Неизвестный lock, чужая конфигурация или конфликт ключей требуют разбора. При отказе SuperCompress сохраняется оригинальный результат; отказ optional Langfuse не выключает сжатие.

Инциденты agent-context: локальная ограниченная очередь, UUID машины, версии package/Node, topology, allowlist публичных полей и дедупликация через существующий GitHub-вход. Общий формат согласован с TaskQ; нативная реализация TaskQ #612 и agent-assisted doctor ещё не готовы. Счётчики best-effort, переполнение/конкурентная блокировка могут потерять событие; неопределённый ответ публикации комментария требует сверки, а не слепого повторения.

## Локальные доказательства

- Mac: `/tmp/agent-context-production-mac-0111-final.json`, `agent-context-production-mac-0111-claude-proof.json`, `agent-context-production-mac-hermes/summary.json`, `agent-context-production-mac-0111-direct-proof.json`.
- Langfuse: Mac `/tmp/agent-context-0111-lf-proof.json`, `/tmp/agent-context-production-fra-0111-lf-proof.json` — только выбранные метаданные, без input/output.
- FRA: `/tmp/agent-context-production-fra-0111-setup-runner.json`, `agent-context-production-fra-0111-doctor.json`, `agent-context-production-fra-0111-direct-proof.json`. Установщик завершён успешно в ограниченном cgroup, OOM=0; разрыв SSH не прервал процесс.
- Windows: `C:\Users\alexk\Documents\Codex\scratch\agent-context-0111-install-review\FINAL-0111-RECEIPT.json`; квитанция и проекции owned health просмотрены через WIN_CSGO. Подробные предыдущие модельные логи остаются на его машине.

Старые восемь Windows/UNC/WSL маршрутов и fault/recovery квалифицированы отдельно, см. HEADROOM-QUALIFICATION.md. Это доказательство перечисленных маршрутов, а не всех возможных инструментов и кодировок вывода.
