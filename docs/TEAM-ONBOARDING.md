# Подключение команды без сервисных ключей

Статус: кандидат 0.2.1; не стабильный релиз. Публичный gateway `https://langfuse.ufobe.com/api/public/agent-context` активен на FRA. Текущая квитанция: [gateway-rollout-0.2.1-2026-10-11.json](https://github.com/taskqorg/agentq/blob/9612eeefcff773edd9c959f093fb76cf56acbc2c/docs/gateway-rollout-0.2.1-2026-10-11.json); рабочая миграция Mac и проверка Windows остаются незавершёнными. Портал не требуется. Управление членством — GitHub, версии — GitHub Releases, просмотр телеметрии — Langfuse. Рабочие профили 0.1.20 не переводятся на gateway автоматически.

## Что делает сотрудник

Даёт агенту постоянную ссылку https://github.com/taskqorg/agentq/blob/main/INSTALL.md и адрес gateway команды после квалификации/публикации. Агент объясняет передачу данных, устанавливает закреплённую версию и вызывает `connect`, затем `setup`. Пользователь один раз подтверждает вход на https://github.com/login/device. Секреты сервисов не запрашиваются. Нативные разрешения на hooks остаются обычной отдельной проверкой агента.

Кандидат должен распространяться по полному проверенному commit SHA; moving main до публикации не содержит обещанной схемы. Автоматическое обновление 0.1.x → 0.2.0 требует явной миграции. Для рассмотренного существующего профиля агент использует `setup --migrate`; без этого переход minor отказывает. Подписанные автоматические patch-обновления этот запрет не обходят. Проверка прежнего bootstrap и возможность package rollback сохраняются; downgrade через `--migrate` запрещён.

Gateway setup сначала отказывает занятому старому proxy. Только свободные старые сервисы останавливаются штатно с проверкой owner/control token; после смены routing запускается новая версия с collector. До этого native exporters не получают device credentials для loopback endpoint старого upstream catch-all. Если запуск не удался, native exporter повторяет local delivery; на provider такой OTLP не пересылается.

Package rollback на версию без gateway/collector отказывает, пока device routing не восстановлен рассмотренной процедурой удаления/переустановки. Это предотвращает пересылку OTLP/доступа устройства в upstream catch-all старой версии. Обычный rollback внутри поддерживающих gateway версий сохраняется.

## Однократная настройка владельца

1. Зарегистрировать OAuth App организации: https://github.com/organizations/taskqorg/settings/applications/new . Имя `Agent Context`; homepage `https://github.com/taskqorg/agentq`; callback `https://github.com/taskqorg/agentq` (Device Flow callback не использует). Включить **Enable Device Flow** и **Token expiration**. Нужен только публичный **Client ID**; Client Secret для этой схемы не нужен.
2. Разрешить приложение в организации, включая её ограничения OAuth/SSO. Scope `read:org` используется для проверки активного членства. По умолчанию доступ имеет организация `taskqorg`; при необходимости ограничить конкретной GitHub team через её slug в серверном config.
3. На FRA создать закрытый JSON config 0600 вне репозитория: `clientId`, `organization`, необязательный `team`, абсолютный `stateDir`, `port:18880`, `langfuse:{public_key,secret_key,base_url}` и `supercompressKey`. Ключи берутся из существующих локальных закрытых профилей FRA программно; не вводятся в чат/argv. Проверка конфигурации отказывает неполным/некорректным значениям. Не используйте device credentials вместо серверных project keys.
4. Запуск: `node <qualified checkout>/bin/agent-context.js gateway serve <private config path>`. Listener привязан только к `127.0.0.1`. Один процесс владеет stateDir. Сервис запускается под отдельным непривилегированным пользователем; config и state доступны только ему. `devices.json` хранит хеши device tokens и GitHub access/refresh tokens scope read:org и сроки их действия для повторной проверки членства; этот файл — секрет и не входит в диагностику/репозиторий.
5. Для FRA можно использовать существующий TLS host без нового домена: `https://langfuse.ufobe.com/api/public/agent-context`. Внутри его Caddy `route`, **перед** существующим `@public_api`, добавить:

   ```caddy
   handle_path /api/public/agent-context/* {
       reverse_proxy 127.0.0.1:18880
   }
   ```

   Это использует уже существующий API-маршрут. UI authentication Langfuse остаётся прежней. Перед reload сохранить закрытую копию и выполнить `caddy validate`; проверить HTTPS `/v1/info`, отказ неавторизованному upload и реальный GitHub-вход. Это схема развёртывания, не свидетельство уже изменённой Caddy configuration.

6. В изолированном профиле выполнить `connect`, `setup`, `doctor --fix --live`, `telemetry verify`, настоящий native model/tool ход и запросить его observations. Проверить сотрудника/device/agent/host/runtime, native session/turn, model/token usage, compression outcome. До этого не переводить рабочих пользователей и не публиковать стабильный релиз.

Токены Device Flow обновляются шлюзом при запросе за минуту до истечения access token. Пара access/refresh атомарно сохраняется в закрытом state; одновременные запросы используют одно обновление. Client Secret не нужен для refresh токенов, выданных через Device Flow. Ошибка обновления отказывает доступу; исходный контекст и локальная очередь сохраняют обычное поведение отказа. После шести месяцев без использования refresh token или отзыва доступа нужен повторный `connect`. Старые неистекающие токены поддерживаются.

## Маршруты и отказоустойчивость

- Model requests идут через локальный proxy к обычному провайдеру агента; они не идут на FRA gateway. Сжатие отправляет отдельно designated tool context и текущий неизменённый вопрос как подсказку компрессору. Сам вопрос не заменяется сжатым текстом.
- Gateway вызывает существующий SuperCompress compiler/CCR. При отказе/таймауте/rate limit локальный пакет возвращает исходный tool result. На сервере максимум 8 одновременных compression fetch; 60 запросов/минуту на устройство. Это технический лимит запросов, не денежный бюджет.
- Native OTLP protobuf/JSON принимает loopback collector. Он переводит protobuf в OTLP JSON без потери native span IDs/usage, добавляет agent/host/runtime и атомарно сохраняет outbox 0600. Максимум batch 4 MiB/1000 spans, очередь 20 MiB на агент/устройство. После рестарта она продолжается; flush каждые 5 секунд, максимум 8 batches за проход. Переполнение возвращает 503; exporter должен повторить отправку. Это ограниченная очередь, не обещание безусловного хранения при долгом сбое.
- Gateway устанавливает user/device сам, не доверяя таким меткам клиента. Trace IDs получают namespace устройства: первые 32 hex SHA256(device + NUL + native trace ID); native ID сохраняется в `agent_context.native_trace_id`. Native session/turn и span hierarchy сохраняются. Доставка/readback CLI использует native ID, интерфейс Langfuse показывает namespaced ID. Устройство читает только собственные отправленные IDs; остальные публичные Langfuse APIs gateway не предоставляет. Readback index ограничен 10 000 traces за последние 7 дней на устройство.
- Удаление сотрудника из разрешённой организации/team отказывает при следующей проверке, максимум 60 секунд после предыдущей успешной проверки. Ошибка GitHub после истечения cache отказывает доступу. Старые очереди не уходят под новым устройством после повторного подключения.
- Capture содержит conversation/tool payloads согласно native exporter. Закрытые очереди могут содержать чувствительные данные; маскирование сторонних exporters не гарантирует удаление всех секретов. Не логировать тела/Authorization ни в gateway, ни в reverse proxy.
- Uninstall восстанавливает собственные изменения native credential routing, сохраняет последующие unrelated owner edits и удаляет local outbox/device token. Общие серверные ключи, сторонние exporters и существующие Langfuse traces не удаляются.
- На native Windows секрет сначала получает защищённый DACL на пустом temp file, затем записывается и атомарно заменяет файл: только владелец профиля/SYSTEM/Administrators, без наследуемого доступа других пользователей. Это относится к credential/device files, содержащим device credentials native configs и закрытым installer backups; parent ACL и общие permission policies не меняются. Отказ установить DACL сохраняет прежний файл. Installer/exporter должен работать как владелец профиля; живой тест этого механизма на native Windows остаётся частью квалификации, а не доказан unit mock.

## Квалификация

Unit tests покрывают device enrollment, отсутствие master keys на клиенте, отказ nonmember, membership revocation, scoped readback, исходный query/fallback, credential routing и uninstall. Python collector tests проверяют protobuf/gzip/ID/usage, отказ чужому local token, закрытую очередь, restart и повторную доставку после 503.

Историческое доказательство компонентов до публичного развёртывания с существующим GitHub login: [gateway-qualification-0.2.0.json](https://github.com/taskqorg/agentq/blob/9612eeefcff773edd9c959f093fb76cf56acbc2c/docs/gateway-qualification-0.2.0.json). Это live membership/SuperCompress/OTLP/readback в изолированном candidate harness. Оно не квалифицирует browser Device Flow, публичный FRA endpoint или новый native agent turn. Эти три проверки остаются обязательными перед rollout.

Публичный gateway, реальный Device Flow, обновление expiring tokens и native Codex/Hermes проверены в текущей [квитанции 0.2.1](https://github.com/taskqorg/agentq/blob/9612eeefcff773edd9c959f093fb76cf56acbc2c/docs/gateway-rollout-0.2.1-2026-10-11.json). Native model/tool/compression связаны исходной сессией в Langfuse; model usage приходит от native exporter. Измерение уменьшения текста не доказывает экономию model tokens или стоимости.
