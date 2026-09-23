# Melogold Server: план реализации до MVP

**Как читать:** этапы идут по порядку. Задачи внутри этапа выполняют **разные агенты параллельно**, у каждой задачи своё множество файлов. Нормативные источники: `docs/API.md`, затем `docs/DESIGN.md`.

## Общие правила для всех задач

1. **Владение файлами.** Каждый файл принадлежит ровно одной задаче. Правка чужого файла — только через ведущего (lead) отдельным PR.
2. **Замороженные после M0 файлы.** Меняет только ведущий:
   - `src/app.ts`, `src/context.ts`, `src/config/env.ts`, `package.json`, `package-lock.json`;
   - `src/db/migrations/**`, `src/db/types.ts`, `src/db/schema.snapshot.json`;
   - `src/contract/**`, `src/http/error-codes.ts`, `src/modules/live/live.events.ts`, `src/modules/sync/ops/types.ts`;
   - `src/lib/session.ts`, `src/lib/device-removal.ts`, `src/modules/security/policy.ts`.

   Изменение контракта требует сначала правки `docs/API.md`.
3. **Генерируемые файлы:** `openapi/*`, `spec/error-codes.json`, `docs/schema.*.sql`. При конфликте их не правят руками, а перегенерируют: `npm run openapi && npm run schema:sql`.
4. **Definition of Done каждой задачи:**
   - проходят `npm run typecheck`, `lint`, `format:check`, `openapi:check`;
   - проходят `npm test` (`TEST_DB=sqlite`) и `npm run test:pg` (`TEST_DB=postgres`, PG 18 **с локалью `en_US.UTF-8`**).

   Задача не принята, пока **оба** прогона БД не зелёные.
5. **Каждый новый SQL-запрос** покрыт интеграционным тестом. Без теста это дефект ревью.
6. **Правила `docs/database.md`** обязательны для всех:
   - ID-collation;
   - никаких перехватов ограничений внутри транзакции;
   - `db.read` и `db.write`, `lockUser` первым оператором;
   - пачки;
   - никакой сети и argon2 внутри транзакции.
7. **Миграции** до первого деплоя в живую БД (`v0.1.0-rc.1` на официальном сервере) правит только ведущий. После деплоя — только новые файлы.

---

## M0. Каркас и контракт в коде (1 агент, блокирует всё остальное)

Агент выполняет шаги по порядку и после каждого шага делает коммит.

| Шаг | Что | Файлы |
|---|---|---|
| 0.1 | Инструменты: пакеты по DESIGN §6.1, `tsconfig` (`noEmit`, `allowImportingTsExtensions`, `erasableSyntaxOnly`, `verbatimModuleSyntax`, NodeNext, strict), ESLint (type-checked + правила импорта и `process.env`), Prettier, `.editorconfig`, `.gitattributes` (LF), `.node-version`, `AGENTS.md` | `package.json`, `package-lock.json`, `tsconfig.json`, `eslint.config.js`, `.prettierrc.json`, `.editorconfig`, `.gitattributes`, `.node-version`, `.env.example`, `AGENTS.md` |
| 0.2 | Конфиг и секрет: `parseEnv` (чистая функция, все переменные API §10), `/data/secret.key`, HKDF | `src/config/env.ts`, `src/config/secret-key.ts` |
| 0.3 | Слой БД: диалекты (`BEGIN IMMEDIATE`, `supportsTransactionalDdl`, `StripRowLocksPlugin`, `setTypeParser`), `db.read/write/run` с защитой от вложенности, `lockUser`/`ensureHead`, `ddl(dialect)`, ошибки драйверов → коды (API §2.4), кодеки JSON, пачки, runner миграций (обёртка «схема новее кода»), сверка схемы со снапшотом | `src/db/{index,tx,ddl,dialect-sqlite,dialect-postgres,plugins,errors,codecs,batch,heads,migrate,schema-check}.ts` |
| 0.4 | Схема: **все** миграции 0001–0005 из API §9.2, типы таблиц Kysely, снапшот, генератор `docs/schema.*.sql` | `src/db/migrations/**`, `src/db/types.ts`, `src/db/schema.snapshot.json`, `scripts/gen-schema-sql.ts`, `docs/schema.sqlite.sql`, `docs/schema.postgres.sql` |
| 0.5 | HTTP-инфраструктура: `AppError`, реестр **всех** кодов из API §2, обработчик ошибок (до маршрутов), guard (шаги API §1.7 плюс подтверждение `rid`), санитизация строк, rate-limit с ключами `ip/56`, `user`, `device`, `rt`, `ps`, логирование (маскирование, `ipTag`), disk-guard, `TRUST_PROXY` | `src/http/**` |
| 0.6 | Библиотека: часы, id и uuidv5, время (приём `\.\d{1,9}`, отдача `.sss`), строки (длины UTF-16, безопасная обрезка), семафор, токены (JWT, `mgrt1`, HMAC), выдача сессии `issueSession(q, …)`, `removeDevicesInTx` / `afterRemove` | `src/lib/**` |
| 0.7 | Контракт: **все** zod-DTO из API §4 и §6 с `.meta({id})` и плоским `SyncOp`; типы и реестр op-обработчиков с заглушками (`deferred unknown_kind`); матрица безопасности как чистые функции с unit-тестами | `src/contract/**`, `src/modules/sync/ops/{types,index}.ts`, `src/modules/security/policy.ts` (+ `policy.test.ts`) |
| 0.8 | Каркас приложения: `app.ts` (порядок регистрации), `context.ts`, `main.ts` (`serve` или CLI без fastify), `server.ts` (close-with-grace, draining, ротация epoch при `restore_pending`), `healthcheck.ts`, модуль `server` полностью (`/`, `/health`, `/health/live`, `/server/info`, `/openapi.json`), хаб live (`publish`, `publishCoalesced`, `closeDevice`, `closeUser`, `closeAll`) плюс каталог событий, **маршруты-заглушки всех модулей** (501 с полными схемами), планировщик задач | `src/{app,context,main,server,healthcheck}.ts`, `src/modules/server/**`, `src/modules/live/{live.hub,live.events}.ts`, `src/jobs/scheduler.ts`, route-файлы-заглушки всех модулей |
| 0.9 | Лицензия спецификации: `spec/LICENSE` и `openapi/LICENSE` (CC0-1.0), SPDX `CC0-1.0` в генерируемых `openapi/*` и `spec/*` (DESIGN §12). Тесты и генерация: `test-db.ts` (sqlite — временный файл; postgres — отдельная схема на файл), `test-app.ts`, `factories.ts` (пользователь, устройство, токен без HTTP), контрактные тесты, генераторы OpenAPI и кодов ошибок, `spec/LICENSE` | `src/test/**`, `scripts/{gen-openapi,gen-error-codes}.ts`, `openapi/*`, `spec/error-codes.json`, `spec/LICENSE` |
| 0.10 | Сборка и CI: нормативный Dockerfile (DESIGN §7.1), лаунчер, `.dockerignore`, `compose.dev.yml` (PG 18 с `en_US.UTF-8`, порт 55432), `scripts/smoke.sh`, `ci.yml` (static, test × {sqlite, pg18}, docker amd64 + arm64 smoke), dependabot, Actions закреплены по SHA | `Dockerfile`, `docker/melogold`, `.dockerignore`, `compose.dev.yml`, `scripts/smoke.sh`, `.github/workflows/ci.yml`, `.github/dependabot.yml` |
| 0.11 | Документация для агентов: правила переносимого SQL и транзакций | `docs/database.md` |

**Приёмка M0 (на обоих диалектах):**
- миграции проходят на пустой БД, повторный прогон ничего не делает, снапшот совпадает;
- `schema-check` на изменённой схеме завершает процесс с кодом 1;
- `db.read`/`db.write` внутри транзакции бросают ошибку;
- PG: `SELECT` join `sync_playlist_items → sync_tracks` по `video_id` на БД `en_US.UTF-8` без ошибки 42P22;
- ограничение, нарушенное внутри `db.write` с `ON CONFLICT`, не рвёт транзакцию;
- NUL и одиночные суррогаты в теле запроса вычищены; `Int32` больше 2³¹−1 → 400, а не 500;
- время: `.123456Z` принимается, отдаётся `.123Z`;
- контракт ошибок: 4 ключа и `code` из реестра; неизвестный маршрут → 404; маршрут без токена → 401; заглушка → 501;
- guard: удалённое устройство → `session_revoked`, другой `av` → `access_token_expired`, новый `rid` записывает `confirmed_at`;
- `/server/info` и `/health` соответствуют API; при `restore_pending=1` старт меняет epoch всем пользователям и снимает флаг;
- `openapi.json` проходит `redocly lint`: 3.0.3, у каждой операции `operationId`, inline-схем нет, все `*Payload` зарегистрированы;
- `policy.test.ts` покрывает каждую строку матрицы DESIGN §4.8;
- `docker build` и `scripts/smoke.sh` зелёные на amd64 и arm64 (регистрация на заглушке пропускается, проверяются `/health` и `/server/info`);
- после M0 ставится тег `api-v1-draft`, а `openapi.json` отдаётся командам клиентов.

---

## M1. Аккаунты, устройства, привязка, SSE (5 задач параллельно, зависят только от M0)

### T1.1 Сессии: регистрация, вход, refresh, logout, me
- **Владеет:**
  - `src/modules/auth/**`: `auth.routes.ts`, `auth.service.ts`, `refresh.service.ts`, `password.ts`, `argon2-pool.ts`, `throttle.ts`, `pow.ts`, `auth.repository.ts` и тесты;
  - `spec/pow.vectors.json`, `spec/hwid.vectors.json`.
- **Делает:**
  - `GET /auth/register/challenge`, `register` (режимы, PoW адаптивный, `first_user_id` через `ON CONFLICT`), `login` (троттлинг, обход для знакомого hwid, лимит устройств под `lockUser`);
  - `refresh` (CAS, окно только для неподтверждённого преемника, reuse удаляет устройство, `device_mismatch`, restore-grace);
  - `logout` (только текущий токен или токен в окне), `GET /auth/me`;
  - политика паролей, NFKC, argon2 с семафором, `needsRehash`.
- **Приёмка (оба диалекта):**
  - `register-first.int`: две параллельные регистрации в режиме `first` — одна 201, вторая `registration_closed`; CLI-пользователь закрывает регистрацию;
  - `pow.int`: без решения → `pow_required`; повтор вызова → `pow_invalid`; адаптивная сложность; векторы;
  - `login-enumeration.int`: неизвестный логин и неверный пароль дают одинаковый код и сопоставимое время;
  - `throttle.int`: 6-я неудача → `login_throttled`; знакомый hwid обходит блокировку;
  - `refresh-rotation.int`: два параллельных refresh дают одного преемника; потерянный ответ (преемник не использован) → тот же преемник; **преемник подтверждён через access, затем старый токен → `refresh_token_reused` и устройство удалено**; после окна → `invalid_refresh_token`; неверный hwid → `device_mismatch`;
  - `logout.int`: **ротированный токен вне окна → 204 без эффекта**; текущий → устройство удалено, SSE `devices.updated`;
  - `password-policy.test`: 4 кода отказа; NFKC для составной и разложенной «й».

### T1.2 Устройства и матрица безопасности
- **Владеет:** `src/modules/devices/**`.
- **Делает:**
  - `GET/PATCH /auth/me/devices*`, `revoke`, `revoke-others` по `security/policy.ts`;
  - reauth-троттлинг, `recentUntil` в DTO;
  - `touchLastSync`, задача очистки неактивных устройств через `removeDevicesInTx`.
- **Приёмка:**
  - `devices-matrix.int`: каждый сценарий DESIGN §4.8 — новое устройство без пароля → `recent_device_restricted`, с паролем → ok; rename чужого новым устройством;
  - `revoke.int`: `cannot_revoke_current_device`; порядок SSE (`session.invalidated` → закрытие → `devices.updated`); привязки с этим одобряющим → `cancelled`;
  - `cascade.int` (SQLite и PG): удаление устройства удаляет его токены.

### T1.3 Аккаунт: пароль, код восстановления, recover, удаление, экспорт
- **Владеет:** `src/modules/account/**` (`account.routes.ts`, `account.service.ts`, `recovery-code.ts`, `export.ts`, `purge.job.ts`).
- **Делает:**
  - `me/password` со старым и без старого (без старого — с любого вошедшего устройства, `account.updated{password_changed_without_old}`);
  - `me/recovery-code` и `/confirm`, `recover` (CAS кода, удаление всех устройств);
  - `me/delete` (логическое удаление, переименование логина);
  - задача `account-purge` (пачки по 5000);
  - потоковый `export` keyset-страницами.
- **Приёмка:**
  - `recover.int`: из двух параллельных recover одним кодом проходит один; неизвестный логин ≡ неверный код; старые устройства → `session_revoked`; выдан новый код;
  - `password-change.int`: смена без старого с любого вошедшего устройства проходит, остальные получают `account.updated{password_changed_without_old}`; со старым — неверный пароль → `invalid_password`;
  - `delete-account.int`: логин сразу свободен; устройства удалены; `session.invalidated{account_deleted}`; после `jobs run account-purge` строк пользователя нет ни в одной таблице; удаление при 100k элементов не держит писателя дольше 2 с на пачку;
  - `export.int`: секретов нет; структура по API; 3/ч.

### T1.4 Привязка устройств
- **Владеет:** `src/modules/linking/**` (`linking.routes.ts`, `linking.service.ts`, `linking.repository.ts`, `long-poll.ts`).
- **Делает:** все 10 маршрутов привязки.
  - Генерация кодов с повтором при коллизии через `ON CONFLICT DO NOTHING RETURNING`.
  - `verifyCode` и `verifyChoices`; неверное число → `denied`.
  - long-poll в памяти с `knownStatus`.
  - Атомарное завершение, повторная выдача сессии в течение 60 с.
  - `sameNetwork` и `LINK_NETWORK_HINT`, не больше 20 активных на IP, не больше 3 invite.
- **Приёмка:**
  - `link-request.int` и `link-invite.int`: полный путь в обоих режимах;
  - `link-verify.int`: неверное число → `link_verify_mismatch`, poll → `link_denied`;
  - `link-race.int`: два параллельных poll → одна сессия; повторный poll в пределах 60 с → та же сессия; позже → `link_expired`;
  - `link-security.int`: по одному `linkToken` токены не выдаются; resolve чужим аккаунтом → 409; удаление одобряющего → poll `link_cancelled` (не 404); лимит устройств при завершении; `expired` вычисляется по времени; финальный статус стирает `*_net` и `claimant_*`.

### T1.5 SSE
- **Владеет:** `src/modules/live/{live.routes.ts, revalidate.ts}` и тесты. `live.hub.ts` передаётся от M0 этой задаче.
- **Делает:**
  - маршрут `/auth/me/events` (hijack, кадры, `retry`, heartbeat);
  - закрытие потока в момент `exp` токена;
  - не больше 4 потоков на устройство и 64 на пользователя;
  - пакетная перепроверка устройств на heartbeat (устройство пропало → `session.invalidated{device_revoked}`, другой `av` → закрытие);
  - `preClose` → `closeAll`.
- **Приёмка:**
  - `sse.int`: первый кадр `retry: 5000`, затем `system.connected`, кадры без `event:`;
  - поток закрывается при `exp`;
  - **устройство, удалённое в соседнем процессе (прямой `DELETE` в тесте), получает `session.invalidated` и закрытие не позже одного heartbeat**;
  - пятый поток устройства вытесняет первый;
  - `sync.changed` склеивается за 2 с;
  - `app.close()` завершается при открытых потоках.

---

## M2. Синхронизация и playback (4 задачи параллельно, зависят только от M0; можно одновременно с M1)

### T2.1 Ядро синхронизации
- **Владеет:**
  - `src/modules/sync/{sync.routes.ts, sync.service.ts, cursor.ts, wins.ts, page.ts, quotas.ts, tracks.ts, lenient.ts, summary.ts}`;
  - `src/modules/sync/ops/{like-set.ts, bookmark-set.ts}`;
  - `spec/sync-scenarios/library.json` и тесты.
- **Делает:**
  - `POST /sync`: конверт на маршруте плюс типизированная схема для OpenAPI, бюджет → 413;
  - пишущая транзакция с ops, затем отдельная читающая транзакция страницы;
  - replay, `sync_ops`, satellites, `include`;
  - `seq` у треков, мягкий разбор метаданных и заглушки, квоты по `COUNT(*)` один раз на запрос;
  - `sync.changed`, `/sync/summary`, маршрут `/sync/merge-plan` (вызывает `planMerge` из T2.2; до слияния T2.2 работает заглушка);
  - `X-Sync-Protocol`.
- **Приёмка:**
  - `cursor.test`: разбор, 400/410;
  - `wins.test`: таблица DESIGN §3.4;
  - `sync-core.int`: идемпотентность (`replayed`); холостая операция не тратит `seq`; страница делится между `library` и `history`; `hasMore`; satellites; каждый ключ один раз;
  - `sync-concurrency.int`: 20 параллельных `/sync` одного пользователя — `seq` строго растёт, pull с нуля совпадает с прямым чтением таблиц;
  - `sync-lenient.int`: мусорные метаданные (пустой title, `artistsText` 10 000 символов, `ftp://`, неверный тип) → op `applied`, трек-заглушка или обрезан;
  - `sync-quotas.int`: `quota_exceeded`, бюджет → 413;
  - `tracks-seq.int`: заглушка → реальный трек двигает `seq`, смена только thumbnail — нет;
  - `library.json`: все сценарии лайков и закладок.

### T2.2 Плейлисты
- **Владеет:**
  - `src/modules/sync/ops/playlist-*.ts` (8 файлов);
  - `src/modules/sync/playlists/{sort-keys.ts, lis.ts, anchors.ts, recovery.ts, merge-plan.ts}`;
  - `spec/playlist-ops.vectors.json`, `spec/sync-scenarios/playlists.json` и тесты.
- **Делает:** все `playlist.*` по DESIGN §3.7:
  - якоря, fractional indexing и ребалансировка при длине больше 48;
  - LIS для `replace`;
  - плейлист восстановления (uuidv5, цепочка, локализованное имя), `pre_image`;
  - квоты на плейлист и в целом, `item_count`;
  - `planMerge`.
- **Приёмка:**
  - `playlist-ops.test`: векторы (одинаковые для клиентов);
  - `playlists.int`: redirected и rejected по `base`; конкурентные перестановки разных треков сохраняются; `replace` против более позднего ручного add; `import` не воскрешает надгробия;
  - `merge-plan.int`: 5 правил, каждый плейлист занимается один раз.
- **Зависимость:** сценарии через `/sync` запускаются после слияния T2.1. До этого обработчики тестируются напрямую через фабрику `OpCtx` из M0.

### T2.3 История
- **Владеет:**
  - `src/modules/sync/ops/{play-add.ts, play-baseline.ts, history-clear.ts, history-forget.ts}`;
  - `src/modules/sync/history/retention.job.ts`;
  - `spec/history-totals.vectors.json`, `spec/sync-scenarios/history.json` и тесты.
- **Делает:**
  - `play.add` (водяные знаки, `in_history`, счётчик, вытеснение при 60 000, не больше 2000 в час → `op_rate_limited`);
  - `play.baseline`, `history.clear`, `history.forget`;
  - retention истории, `in_history=0` и `sync_ops` пачками.
- **Приёмка:**
  - `history.int`: сценарии DESIGN §3.16 (очистка против офлайн-прослушиваний, forget против `resetTotal`);
  - повтор `play.add` → `replayed`;
  - `op_rate_limited` содержит `retryAfterSeconds`;
  - вытеснение при квоте;
  - retention не двигает `seq` и не публикует SSE;
  - векторы счётчиков.

### T2.4 Playback
- **Владеет:** `src/modules/playback/**`, `spec/playback-rules.vectors.json`.
- **Делает:**
  - `GET`, `PUT`, `DELETE /playback/state`: правила DESIGN §3.12.3, CAS до 3 попыток, надгробие `cleared`;
  - `playback.updated` (значимые изменения, не чаще 1/с);
  - retention через 30 дней.
- **Приёмка:**
  - `playback.int`: `handed_off`, `newer_state`, `playback_queue_required`;
  - **`rev` после DELETE и нового PUT строго больше прежнего**;
  - неверный элемент очереди → 400; 413 при 128 КиБ;
  - 5 параллельных PUT → один `rev` на каждую запись;
  - векторы правил.

---

## M3. Эксплуатация и упаковка (4 задачи параллельно, зависят от M0; T3.1 нужен T3.2)

### T3.1 CLI и фоновые задачи внутри контейнера
- **Владеет:**
  - `src/cli/**`;
  - `src/modules/maintenance/{auth-cleanup.job.ts, sqlite-maintenance.job.ts, backup.ts, restore.ts, rotate-epoch.ts, verify-release.ts}`;
  - `src/jobs/index.ts`.
- **Делает команды:**
  - `serve`, `migrate`, `info --json`, `openapi`, `check-config`, `qr [url]`;
  - `user add|reset-password|delete|list [--usage]|devices|revoke-device`;
  - `backup --out` (SQLite: `VACUUM INTO`, `integrity_check`, флаг `restore_pending` в копии), `restore --from` (SQLite: подмена файла, ротация epoch), `verify-backup`;
  - `sync rotate-epoch --all|<login>`, `secret rotate`, `jobs run <name>`, `verify-release` (minisign через `node:crypto`).
- **Правила CLI:** CLI не импортирует fastify, пароль берётся только с TTY.
- **Приёмка:**
  - `restore-epoch.int` (**B1**, оба диалекта): backup → запись → restore → запись, пока голова не обгонит старый курсор → старый курсор получает `410 cursor_invalid`; окно restore-grace принимает HMAC-валидный неизвестный `tid`;
  - `cli.int`: `user add` в режиме `first` закрывает регистрацию; `reset-password` поднимает `auth_version`, удаляет устройства и печатает код; CLI-revoke закрывает SSE не позже heartbeat (вместе с T1.5);
  - `verify-release.test`: векторы minisign;
  - `auth-cleanup.int`: правила DESIGN §4.12.

### T3.2 Шаблоны развёртывания, установщик, host CLI
- **Владеет:** `deploy/installer/**`, `deploy/templates/**`, `docs/self-hosting.md`, `docs/operations.md`.
- **Делает:**
  - `install.sh` (режимы `domain`, `lan`, `proxy`; `--db`; `--restore`; `--upgrade`, `--repair`, `--reconfigure`, `--uninstall`; владелец создаётся до публикации порта; `.env` в одинарных кавычках; защита от потерянного `.env`; лимиты памяти; подсеть и `TRUST_PROXY`);
  - шаблоны compose и Caddyfile (`5MiB`);
  - host CLI (`status`, `logs`, `upgrade` с проверкой подписи текущим образом, `rollback`, `backup` и `restore` для PG через plain-дамп с маркером и `melogold_restoring` с переименованием, `verify-backup`, `user`, `sync rotate-epoch`, `secret rotate`, `qr`, `config`, `pull-deps`, `uninstall`);
  - юниты бэкапа.
- **Приёмка:**
  - `shellcheck -s sh`, `dash -n`, `busybox sh -n`;
  - `docker compose config -q` для всех комбинаций профилей;
  - `caddy validate`;
  - e2e в T3.3 зелёный.

### T3.3 CI для образа и релиза
- **Владеет:** `.github/workflows/{image.yml, release.yml}`.
- **Делает:**
  - сборка по архитектурам на нативных раннерах, push by digest, слияние манифеста, теги;
  - **e2e установщика** (`--lan` × {sqlite, postgres}: status → user add → backup → verify → запись → restore → проверка 410 → повторная установка без изменений → upgrade с предыдущего релиза → rollback → uninstall);
  - релиз: `install.sh`, `openapi.*`, `error-codes.json`, `SHA256SUMS` и `.minisig`; проверка, что версия совпадает с тегом.
- **Приёмка:** прогон на тестовом теге `v0.0.1-rc.1` в форке или песочнице зелёный, образ тянется анонимно.

### T3.4 Официальный сервер: скрипты
- **Владеет:** `deploy/official/**`, `.github/workflows/deploy-official.yml`.
- **Делает:**
  - `harden-vps.sh` (DESIGN §8.2), `bootstrap-official.sh`, `ci-entry.sh` (строгая регулярка);
  - off-site и restore-check скрипты и таймеры;
  - `deploy-official.yml` (только теги, `concurrency: production`, закреплённый known_hosts, проверка `/server/info.revision`).
- **Приёмка:**
  - `shellcheck`;
  - прогон `harden-vps.sh` и `bootstrap-official.sh` на одноразовой ВМ Ubuntu 24.04: повторный прогон ничего не меняет, `sshd -T` показывает `passwordauthentication no`;
  - `ci-entry.sh` отвергает произвольную команду.

---

## M4. Интеграционная приёмка и релиз-кандидат (после M1–M3)

| Задача | Владеет | Что | Приёмка |
|---|---|---|---|
| T4.1 Сквозные сценарии | `src/test/e2e/**` | регистрация → QR-привязка второго устройства → sync с двух устройств → передача воспроизведения → отзыв → recover. Слияние: клиентский симулятор проверяет **сохранение отрицательных намерений** (M15) и `deleteUnseen` | оба диалекта зелёные; сценарий M15 не воскрешает удалённое |
| T4.2 Нагрузка | `scripts/bench/**` | autocannon в `--cpus=1 --memory=512m`: вход, `/sync` на запись и чтение, SSE × 500 | p95 пишущего `/sync` меньше 300 мс при 50 транзакциях в секунду на обоих диалектах; нет OOM при 32 параллельных входах (`APP_MEM_LIMIT` по формуле) |
| T4.3 Документация | `README.md`, `docs/security.md`, `docs/UPGRADING.md` | README: SQLite по умолчанию и PG 18 опционально, одна команда установки, любое видео YouTube, клиенты без iOS | ревью ведущего |

Затем ставится тег **`v0.1.0-rc.1`**, и в песочнице проходит весь конвейер `image → e2e → release`.

---

## M5. Запуск официального сервера (человек плюс агент по runbook DESIGN §8.3)

1. Фазы 0–2: домен, DNS, ключи (ssh, age, minisign), харднинг, bootstrap.
2. Фаза 3: `install.sh … --version 0.1.0-rc.1`. С этого момента **миграции заморожены**. Проверка с двух устройств.
3. Фаза 4: CI-деплой rc, затем тег **`v0.1.0`**, репетиция отката.
4. Фаза 5: off-site бэкапы с `--with-secrets` (age), restore-check, мониторинг; копия `secret.key` в менеджере паролей.
5. Фаза 6: `OFFICIAL_SERVER_ID` вшивается в клиенты, `install.sh --lan` проверяется на чистой ВМ и на arm64.
6. **До открытия публичной регистрации** закрыты вопросы DESIGN §12, пункты 3 и 2: юридические данные и лицензия спецификации.

---

## Граф зависимостей

```
M0 ──┬── T1.1 ─┐
     ├── T1.2 ─┤
     ├── T1.3 ─┤ (T1.3 использует policy.ts и removeDevicesInTx из M0)
     ├── T1.4 ─┤
     ├── T1.5 ─┤
     ├── T2.1 ─┬─ T2.2 (сценарии через /sync), T2.3 (сценарии через /sync)
     ├── T2.4 ─┤
     ├── T3.1 ─┴─ T3.2 ── T3.3
     └── T3.4 ─┘
                 └──────────── M4 ── M5
```

## Итог: чек-лист MVP
- [ ] Все 38 маршрутов реализованы, заглушек 501 не осталось (контрактный тест).
- [ ] Регрессионные тесты замечаний ревью зелёные на обоих диалектах: B1, M3–M6, M10–M16, m3, m18.
- [ ] Образ меньше 80 МБ, amd64 и arm64, smoke и e2e установщика зелёные.
- [ ] `openapi.json` релиза опубликован. Клиенты генерируют код: Fabrikt (Kotlin), swift-openapi-generator (Swift), NSwag (C#), progenitor (Rust). До публикации каждый из четырёх генераторов проверен на декодировании `null` в полях `nullable` + `allOf: [$ref]` (API §1.3) и целых больше 2³¹−1 (`format: int64`).
- [ ] Официальный сервер работает на `v0.1.0` с PostgreSQL 18. Off-site бэкапы, restore-check и мониторинг зелёные. Восстановление из бэкапа отрепетировано на Mac.
- [ ] `docs/self-hosting.md` проверен вживую: `curl -fsSL https://get.melogold.app | sh` в режимах `domain`, `lan`, `proxy` на чистой ВМ и на arm64.
- [ ] Вопросы DESIGN §12 закрыты:
  - правило смены пароля без старого подтверждено;
  - лицензия `spec/*` выбрана;
  - юридические данные и политика конфиденциальности опубликованы;
  - домен, B2 и мониторинг оформлены.
