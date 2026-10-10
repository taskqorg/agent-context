# Кандидат 0.1.12: онбординг и удаление

Проверено 2026-10-11. Архив SHA256: `1e302ca106dbf9016e8fe0e00fab3366ef7f16349d6858196443972d25daedab`.

| Среда | Автоматические проверки | CLI установка → preview → удаление → повтор |
| --- | --- | --- |
| macOS / Node 22.18.0 | 61 PASS | PASS: исходные bytes восстановлены, managed data отсутствуют, повтор `already_removed` |
| FRA Linux / Node 22.23.2 | 60 PASS, 1 ожидаемый skip | Штатная suite из архива, изолированный bounded runner, OOM 0 |
| Windows / Node 24.5.0 | 60 PASS, 1 ожидаемый skip | PASS: исходные bytes восстановлены, managed data отсутствуют, повтор `already_removed` |
| WSL / Node 22.22.0 | 60 PASS, 1 ожидаемый skip | PASS: исходные bytes восстановлены, managed data отсутствуют, повтор `already_removed` |

Архив не содержит `.git`: пропускается только проверка миграции из исторического Git bootstrap. На Mac она прошла в checkout. Integrity проверен на всех средах. Дополнительно настоящее npm global removal проверено на Mac, Windows и WSL с синтетическим пакетом строго внутри отдельного npm-prefix; package directory исчез, настройки восстановлены. Реальные global-пакеты и рабочие профили не удалялись. NVM executable использован на Windows; отдельный npm-root junction case не квалифицирован.

Suite проверяет полный откат нескольких установок, сохранение более поздних сторонних правок, отказ на изменённой собственной маршрутизации, busy service, подмену пути журнала, частично неудачную подготовку и сбой npm removal. Проверка shutdown использует проверенную owner/PID/control-token границу со stub transport; не является живым model/proxy тестом.

Кандидат не объявлен стабильным: новые model turns, live proxy teardown и production deployment в этот прогон не входили. Квитанции Windows/WSL прочитаны владельцем задачи с проверкой точного archive SHA; ответы другой сессии не приняты без квитанции.
