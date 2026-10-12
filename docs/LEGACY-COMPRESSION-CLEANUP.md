# Удаление старого сжатия

2026-10-11 Bangkok. Прямое разрешение пользователя: «на всех хостах удалить старое сжатие/старые конфликтующие хуки и настройки — только наше оставить».

| Среда | Результат |
| --- | --- |
| Mac | Global `supercompress-proxy@0.5.38` удалён штатным npm uninstall; пакет и `/usr/local/bin/supercompress` отсутствуют. Старые параметры `port`, `configured_at`, `mode`, `configured_agents` удалены из `.supercompress/config.json`; `api_key` сохранён. Старые inbox/sessions/agent-config-backups убраны из рабочего каталога в закрытую копию. |
| FRA | Старого global пакета/команды нет. Из `.supercompress/config.json` удалены `mode`, `configured_agents`; `api_key` сохранён. |
| Windows | WIN_CSGO удалил global `supercompress-proxy@0.5.38`; legacy commands отсутствуют, pointer нашей установки сохранён. Четыре неактивных старых параметра конфигурации пока сохранены: локальное прямое разрешение на удаление пакета отдельно требовало сохранить config.json. WIN_CSGO запросил уточнение в своей сессии. |
| WSL | Старой команды нет, в том числе наследуемой через Windows PATH. Изменение старых параметров конфигурации остановлено тем же локальным ограничением; ключ сохранён. |

В проверенных user-конфигах Codex/Claude/Hermes и project-конфигах agent-context, TaskQ, csgo, FRA cyprusbz сторонние активные или отключённые подключения сжатия не обнаружены. На FRA также просмотрены конфигурации существующих Hermes profiles. Сохранены только принадлежащие agent-context подключения сжатия: controlled proxy, lifecycle, native Hermes plugin и Headroom retrieval. Отключённый MCP `supercompress`, указывающий на наш launcher, сохранён как собственная совместимость установщика. Langfuse, обычный вход и политика инструментов не менялись.

Doctor `--live`: все установленные агенты healthy, issues пусты, `possible_double_compression` отсутствует. Mac/FRA warnings пусты. Windows/WSL сохраняют прежние `compression_telemetry_disabled` для Codex/Claude — это отдельная незавершённая настройка Langfuse.

Закрытые копии для отката:

- Mac: `/Users/kirs/.agent-context/backups/legacy-compression-20261011` (каталог 0700, config/archive 0600).
- FRA: `/home/hermes/.agent-context/backups/legacy-compression-20261011` (0700/0600).
- Windows package: `C:\Users\alexk\Documents\Codex\scratch\legacy-supercompress-removal\supercompress-proxy-0.5.38-private-backup.tgz`; ACL ограничен локальным пользователем, согласно WIN_CSGO.

Не сканировали произвольные каталоги и чужие private данные. Нативные model-turn тесты не повторяли; проверка подтверждает настройки и здоровье собственных сервисов, не полную экономию токенов. Текущие агентские сессии принудительно не перезапускали.
