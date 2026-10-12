# Agent Context 0.1.16 — проверка хостов

Дата: 2026-10-11. Подписанный стабильный релиз опубликован: https://github.com/taskqorg/agent-context/releases/tag/v0.1.16.
Commit: `a1b37a1b3ae234762bb5d6fbdeddc1111f4f6975`; CI 38108436462: macOS/Linux/Windows PASS; signing CI 38108515060 PASS. Ed25519 подпись, публичный archive digest и recipe darwin/linux/win32 проверены, rollout 100%.
Архив SHA256: `ca866a7a44247b95348ab961f0638786b4d064cd588cf61d1db247205f450b78`.

## Исправления и gate

- Частные Python-процессы подготовки, proxy, retrieval и self-test обновляющего пакета не наследуют PYTHONPATH/PYTHONHOME агента. Остальные переменные и native auth сохраняются.
- Setup закрепляет только readonly headroom_retrieve: Codex per-tool approval_mode=approve и Claude exact allow. Общая policy, модели и sandbox сохранены; ручное сжатие остаётся запрещённым.
- Mac canonical `npm test`: 73 PASS; `npm pack`: PASS. Windows/WSL packaged canonical gate: 70 PASS + 1 Git-checkout skip, 0 failures; npm pack PASS.

## Рабочие профили

| Хост | Выбранный пакет | Живые сервисы | Доказательства |
|---|---|---|---|
| Mac | 0.1.16 | Codex/Claude/Hermes 0.1.16 | Claude native retrieval exact PASS; Hermes native compression/facts PASS. Codex fresh process proxy 0.1.16: native compression + marker + exact retrieval PASS; После разрешённого переключения production proxy 0.1.16: fresh 11631→909, native exact retrieval PASS, configs unchanged. |
| FRA | 0.1.16 | Codex/Hermes 0.1.16 | Codex native exact retrieval PASS. Hermes cold-start через настоящий managed plugin PASS; terminal fixture 11644→968 chars с CCR. Настоящая цепочка Hermes→TaskQ→Codex worker PASS, provider agent_context, readonly MCP retrieval, факты точны; board и sandbox не изменены. |
| Windows native | 0.1.16 | Codex/Claude 0.1.16 | Обоих: fresh compression 11631→909 и native exact retrieval PASS, query/facts сохранены, config unchanged. Codex после переключения: native PASS, 11631→909 за 2.484s, exact original/query/configs. Постоянный proxy после hidden Start-Process подтверждён отдельной командой: owner/PID matched, 0.1.16. Тайм-ауты промежуточных проверок переданы relay. |
| WSL | 0.1.16 | Codex/Claude 0.1.16 | Codex fresh 13091→909, Claude fresh 11631→909, обоих native exact retrieval PASS; settings preserved. |

## Обновления, инциденты и ограничения

- Автообновления включены; настоящий update staging с Node/Python self-tests на Mac и FRA PASS.
- Публичный signed recipe v0.1.16 квалифицирован для darwin/linux/win32; Mac/FRA update возвращает current 0.1.16, автоматические обновления включены. Старые опубликованные assets не изменялись.
- 0.1.16 isolated faults PASS: original/query сохранены при 503, повторы объединены, offline очередь не потеряна, после восстановления доставка и компрессия работают, секреты/context исключены, дубликатов нет. Синтетические incidents не отправлялись публично.
- Пользователь разрешил переподключение занятых Codex proxy. Mac переключён с подтверждённым восстановлением клиентов. Windows переключён: hidden Start-Process штатного launcher пережил завершение команды, отдельный readback подтвердил owner/PID и live 0.1.16. Windows/WSL update: current 0.1.16, прежняя enabled policy сохранена.
- Langfuse на Windows/WSL отсутствует; сжатие работает без него. Секреты между машинами не копировались.
- Размер текста и estimated tokens не являются доказательством экономии реального model input/cost.

Машинная квитанция: [qualification-0.1.16-2026-10-11.json](../evidence/qualification-0.1.16-2026-10-11.json.gz).

## Процедура повторной проверки

1. Проверить archive SHA256 и integrity; canonical npm test/npm pack в изолированном HOME/npm prefix.
2. Setup только установленных агентов; doctor --fix --live, отдельно selected и live version.
3. Свежий native fixture: CCR, точные факты, неизменный query; затем native retrieval и побайтовое сравнение оригинала. Старые CCR не переносить между proxy: кеш принадлежит runtime.
4. У Codex deferred MCP discovery разрешить tool_search в формулировке задания. При тесте `run codex` разместить все `-c` перед `exec`: вложенные `exec -c` перекрывают параметры корневого CLI.
5. Hermes холодный старт через managed plugin; TaskQ spawn одного readonly Codex worker, без tick/board/security changes.
6. Реальное update staging; isolated faults, queue/dedup/delivery, отсутствие секретов/context в incident packet. Stable подписанный recipe — отдельный release gate.

Дополнительное наблюдение: разовый `run codex` завершил turn, но его тестовый idle proxy остался жить после попытки остановки в момент закрытия WebSocket. Проверенный собственный idle процесс теста завершён SIGTERM; production services не затронуты. Этот прежний lifecycle corner case рассмотрен при release review: он относится к одноразовому run wrapper, в текущем пакете не исправлялся. Managed production services проверяются отдельно; ограничение раскрыто в release notes.

Финальные native сравнения на Windows и WSL выполнены координатором через существующий SSH-доступ после обрыва app-соединения. На каждый из трёх оставшихся маршрутов ровно один fresh compression seed и один модельный retrieval; изменения моделей, policy, sandbox и login не требовались. Windows/WSL GET405 подтвердил DNS/TLS, current seeds 2.47–2.69s подтвердили восстановление компрессии; внутренняя причина прежних timeout не установлена. Windows/WSL реальные timeout incidents отмечены relay reported; это не подтверждение создания отдельного GitHub issue (issue_url может быть null).

## Итог

Квалификация завершена для установленных агентов: Mac Codex/Claude/Hermes, FRA Codex/Hermes, Windows Codex/Claude, WSL Codex/Claude. Claude на FRA не установлен; Hermes на Windows/WSL не заявлен установленным. Автообновления подписанных совместимых patch-версий включены на четырёх профилях, проверка не чаще раза в сутки при старте интеграции.

Windows дополнительная команда чтения Get-CimInstance process metadata + owned HTTP health + отдельная persistence-квитанция отклонена автоматическим review с причиной `blocked by policy`; не повторялась и не обходилась. Успешный отдельный readback после Start-Process и native proof получены до отклонения. Длительный soak, перезагрузка OS и реальная экономия model cost не проверялись. Внешний компрессор может дать timeout: оригинал сохраняется, инцидент ставится в очередь/передаётся relay; автоматическое исправление кода не заявляется.
