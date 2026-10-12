# FRA: согласованный переход TaskQ

2026-10-11 Bangkok. Координатор: `01a121e9-5533-7464-87ec-96c6c9bc70ea` («Manage TaskQ and CSGO»). Согласован SHA `c25ad1170cc211b104a3eca438c65637c3b0677e`, upstream `https://github.com/alexkirs/taskq.git`.

## Выполнено

- Отдельный чистый checkout на FRA: `/home/hermes/projects/taskq-c25-qualification`, detached exact SHA. Старая pipx TaskQ `ba9f05f` сохранена.
- Python 3.12.3: запуск `--help` и preview managed update успешны.
- Изолированная штатная suite: 298 тестов, 5 skipped, PASS за 57.862 s; OOM 0, memory peak 110.9 MiB. Квитанция: `/tmp/taskq-c25-fra-tests.json`.
- Через тот же Python и нативный glab: GitLab `gitlab.ufobe.com`, пользователь `tight`, проект `gradus/cyprusbz`, id 35. Открытых issues 0; закрытых 20, среди них 18 старых TaskQ schema 0 с claim. Claims не изменялись.
- Существующие локальные лимиты Codex 3 / Claude 0, cleanup=false сохранены. Нет `taskq.json`; отсутствуют подходящие coordination/capacity labels.
- Координатор принял отдельную managed установку с отдельным launcher, после проверок. Переключение обычной команды и cron остаётся отложенным до проверки FRA JSON, GitLab guard/capacity и Hermes bridge.

## Блокер установки

Проверка точного SHA через нативный FRA `gh` завершилась HTTP 403: `Sorry. Your account was suspended`. С Mac exact-SHA CI `tests` подтверждён completed/success, но контракт managed installer требует собственной успешной проверки CI. Установка не применялась; обход gate, перенос входа и смена политики не выполнялись. Блокер передан координатору.

Назначение после устранения блокера: `/home/hermes/.local/share/taskq-managed`. Qualification JSON создаётся только после честного принятия проверок; canonical `update --apply --qualification` самостоятельно проверяет CI. Обычный `/home/hermes/.local/bin/taskq` остаётся pipx. Откат отдельной установки — продолжить использование неизменённой старой команды; board rollback не требуется, записей на board не было.

Сохранённые SHA256 конфигураций:

- `taskq.toml`: `ca0c73debad51eac6f08df69c6a0f32efa3f810448a85dfc3339cebf6a0e3dbb`.
- `taskq.local.toml`: `be42ae7af7f1f12e41851da9bf8d5e2510a8d776ce3149b75e471bdfde7efbcd`.

## Отдельная проверка сжатия

До обновления реальный Hermes запустил Codex через старый TaskQ. Нативный thread `01a12788-c9bd-7172-af81-f1b03240fc2b` выбрал `modelProvider=agent_context`. Чтение синтетического fixture отказано платформой: `bwrap: setting up uid map: Permission denied`. Поэтому маршрут прокси подтверждён, сжатие результата именно этой цепочки не доказано. Ограничение не обходили; повторный model run, queue tick, repair/adoption и ARM не запускали.
