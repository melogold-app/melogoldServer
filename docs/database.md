# База данных: переносимый SQL и транзакции

Правила обязательны для всех задач (PLAN, «Общие правила», п. 6). Нормативные источники: `docs/API.md` §9 (схема, типы, различия диалектов) и `docs/DESIGN.md` §6.2. Если этот файл с ними расходится, правы они, а этот файл нужно исправить.

Один и тот же код запросов работает на SQLite (по умолчанию, `better-sqlite3`) и PostgreSQL 18 (`pg`). Всё, что зависит от диалекта, живёт только в `src/db/**`.

## 1. Карта `src/db`

| Файл | Что там |
|---|---|
| `index.ts` | `createDb(env)` → `ctx.db` (`read`, `write`, `run`, `dialect`, `destroy`); `openKysely` для инструментов |
| `tx.ts` | `db.read/write/run`, запрет вложенности, `withSavepoint`, `MissingHeadError`, `TxRuleError`, предупреждение о транзакции дольше 2 с |
| `heads.ts` | `lockUser`, `readHead`, `insertHead`, `bumpHead`, `ensureHead`, `newEpoch` |
| `ddl.ts` | `ddl(dialect)`: логические типы API §9.1 и правила рендера |
| `dialect-sqlite.ts`, `dialect-postgres.ts` | соединение, PRAGMA, `BEGIN IMMEDIATE`, парсеры `bigint`, интроспекция только `current_schema()` |
| `plugins.ts` | `StripRowLocksPlugin` (SQLite), счётчик операторов для проверки «`lockUser` первым» |
| `errors.ts` | ошибки драйверов → `server_busy` / `unavailable` / `storage_full` (API §2.4); `constraintViolation` для сервисов |
| `codecs.ts` | `jsonCodec(zod)`, `toDbBool` / `fromDbBool`, `safeInt` |
| `batch.ts` | пачки: `INSERT_BATCH_ROWS = 500`, `IN_BATCH_VALUES = 1000`, `DELETE_BATCH_ROWS = 5000` и помощники |
| `migrate.ts` | runner миграций, «схема новее кода», `prepareDatabase` (старт: `MIGRATE_ON_START`, миграции, `SCHEMA_CHECK`) |
| `schema-check.ts`, `sql-expression.ts` | сверка живой схемы со `schema.snapshot.json`; каноническая форма выражений `CHECK` и частичных индексов |
| `types.ts`, `schema.snapshot.json` | генерируются `npm run schema:sql` из миграций; руками не правятся |
| `migrations/NNNN_*.ts` | миграции API §9.2 |

`kysely` импортируют только `src/db/**`, `*.repository.ts`, `src/modules/sync/**`, миграции, тесты и `scripts/` (ESLint).

## 2. Транзакции

### 2.1 Три способа обратиться к БД

| Вызов | PostgreSQL | SQLite | Когда |
|---|---|---|---|
| `ctx.db.write(fn)` | `READ COMMITTED` | `BEGIN IMMEDIATE`: блокировка записи берётся сразу, других писателей нет | любая запись |
| `ctx.db.read(fn)` | `REPEATABLE READ READ ONLY`: один снимок | `BEGIN` (снимок WAL) под `PRAGMA query_only = ON` | чтение нескольких связанных строк |
| `ctx.db.run(fn)` | autocommit | autocommit | ровно один оператор, которому не нужна атомарность с другими |

- Внутри `read` запись невозможна в обоих диалектах: ошибка, а не тихий успех.
- `fn` получает `q` (транзакцию Kysely) и передаёт его в репозитории: `repo.findX(q, …)`. Репозиторий не открывает транзакций.
- `q` нельзя сохранять и использовать после выхода из `fn`.

### 2.2 Вложенность запрещена

`read`/`write`/`run` внутри другого `read`/`write`/`run` бросают `NestedDbAccessError` (проверка через `AsyncLocalStorage`, ловит и вызовы глубоко в сервисах). В SQLite одно соединение за мьютексом: вложенный вызов ждал бы внешний вечно. Когда внешний вызов закончился, его область закрыта: таймер или обработчик события, созданный внутри транзакции, после её commit обращается к БД как обычно.

```ts
// Плохо: сервис B открывает свою транзакцию внутри транзакции сервиса A.
await ctx.db.write(async (q) => {
  await devices.touch(q, deviceId);
  await otherService.doSomething(ctx); // внутри ctx.db.write → NestedDbAccessError
});

// Хорошо: одна транзакция, функции получают q.
await ctx.db.write(async (q) => {
  await devicesRepo.touch(q, deviceId);
  await otherRepo.update(q, …);
});
```

### 2.3 Что можно делать внутри транзакции

- Только операторы через `q` и чистые вычисления.
- **Нельзя:** сеть (HTTP, DNS), argon2 и прочие тяжёлые вычисления, `setTimeout`, чтение файлов, ожидание семафоров, `await` чего-либо, кроме `q`. Argon2 считается **до** транзакции (DESIGN §4.2).
- **Бюджет — 2 с.** Более долгие транзакции пишутся в лог (`slow database transaction`). SQLite — один писатель на весь сервер, PostgreSQL — пул из `DATABASE_POOL_MAX` соединений: долгая транзакция задерживает всех.
- В SQLite через одно соединение идут и чтения, и записи (мьютекс Kysely): короткими должны быть и `read`.

### 2.4 Побочные эффекты — только после commit

`fn` может выполниться **дважды**: если `lockUser`/`readHead` не нашли строку `sync_heads`, runner откатывает транзакцию, создаёт строку (`ensureHead`) и запускает `fn` снова. Поэтому:

- до первого оператора и между операторами у `fn` нет внешних эффектов;
- SSE (`ctx.live.publish…`), закрытие потоков, логи о свершившемся, метрики — **после** того, как `write` вернул результат.

```ts
const result = await ctx.db.write(async (q) => {
  const head = await lockUser(q, userId);
  // … только q …
  return { cursor: `${head.epoch}.${seq}.${seq}` };
});
ctx.live.publishCoalesced(userId, "sync.changed", { cursor: result.cursor }); // после commit
```

### 2.5 Мьютекс пользователя: `lockUser`

- `lockUser(q, userId)` — **первый оператор** каждой сериализуемой записи пользователя (API §9.5): `/sync` с ops, создание устройства (login с новым hwid, завершение привязки), смена пароля, recover, revoke-others, удаление аккаунта.
- Вызов не первым оператором или вне `write` бросает `TxRuleError`: оператор до блокировки выполнился бы без неё.
- PostgreSQL блокирует строку `sync_heads` (`FOR UPDATE`). В SQLite `FOR UPDATE` вырезает `StripRowLocksPlugin`, эксклюзивность уже дал `BEGIN IMMEDIATE`.
- **Каждая запись строки состояния пользователя U** (`sync_*`, `play_*`) идёт в транзакции, которая держит `lockUser(U)`, и получает `seq` из головы этой транзакции; в конце `bumpHead(q, U, lastSeq, now)`. Так порядок `seq` совпадает с порядком коммитов (DESIGN §3.5).
- `users` через `FOR UPDATE` не блокируется никогда. `.forUpdate()` в MVP есть только в `lockUser`; refresh, playback, привязка и recover работают через CAS (§2.6).
- Одна транзакция — один `lockUser`. Если когда-нибудь понадобятся два пользователя сразу, блокировки берутся по возрастанию `user_id`; в MVP таких мест нет.
- Строка `sync_heads` создаётся вместе с пользователем: `insertHead(q, userId, now)` в транзакции регистрации и в CLI. `ensureHead` — только подстраховка (m7).
- `readHead(q, userId)` читает голову без блокировки в `db.read` (страница `/sync` читается отдельной read-транзакцией после commit).

### 2.6 Остальная конкуренция — CAS

Там, где нет `lockUser`, конкурирующие записи разрешаются условным `UPDATE` и проверкой числа строк:

```ts
const updated = await q
  .updateTable("refresh_tokens")
  .set({ rotated_to_id: newId, rotation_grace_expires_at: graceUntil })
  .where("id", "=", tid)
  .where("rotated_to_id", "is", null)
  .executeTakeFirst();
if (updated.numUpdatedRows !== 1n) { /* проиграли гонку */ }
```

- Refresh — CAS по строке токена, playback — CAS по `rev` (API §9.5).
- `numUpdatedRows`, `numDeletedRows`, `numInsertedOrUpdatedRows` — это `bigint`: сравнивать с `1n` или через `Number(…)`.
- «Прочитать, посчитать в TS, записать» без `lockUser` или CAS запрещено: в PostgreSQL (`READ COMMITTED`) это потерянное обновление. То, что SQLite сериализует всё сам, не оправдание.

## 3. Ошибки ограничений (M11)

В PostgreSQL любая ошибка внутри транзакции обрывает её (`25P02`), в SQLite транзакция продолжается. Поэтому:

1. **Внутри транзакции ошибки ограничений не ловятся.** `try { insert } catch { update }` запрещён.
2. Вместо этого `ON CONFLICT … DO NOTHING | DO UPDATE` и `RETURNING`:
   ```ts
   const row = await q
     .insertInto("users")
     .values(user)
     .onConflict((oc) => oc.column("login").doNothing())
     .returning("id")
     .executeTakeFirst();
   if (!row) throw loginTaken(); // AppError с кодом login_taken: транзакция откатится целиком
   ```
   LWW-запись: `onConflict((oc) => oc.columns(["user_id", "video_id"]).doUpdateSet(…).where(…))`.
3. Если перехват неизбежен — `withSavepoint(q, fn)` из `tx.ts`: при ошибке откатывается только `fn`, транзакция живёт в обоих диалектах.
4. Или граница транзакции: `db.write` отклоняется, сервис проверяет `constraintViolation(error)` / `isUniqueViolation(error)` из `errors.ts` и отвечает своим кодом. Непереведённое нарушение → `500`.
5. Каждый такой путь покрыт интеграционным тестом.

Остальные ошибки драйверов сервисы не трогают: `server_busy`, `unavailable`, `storage_full` (API §2.4) делает обработчик ошибок через `translateDbError`.

## 4. Переносимый SQL

### 4.1 Типы (API §9.1)

| Логический | TS | Правило |
|---|---|---|
| `ID` | `string` | идентификаторы, хеши, логин, ключи порядка. В PG `text COLLATE "C"`: сравнение и сортировка побайтно, как `BINARY` в SQLite |
| `TXT` | `string` | человеческий текст и перечисления. **Не сравнивается с другими колонками, не сортируется, не участвует в FK** |
| `INT` | `number` | ≤ 2³¹−1 (zod `.max`) |
| `BIG`, `TS` | `number` | ≤ 2^53−1; `TS` — epoch-мс UTC. PG `bigint` приходит числом, за пределами ±(2^53−1) парсер бросает ошибку |
| `BOOL` | `0 \| 1` | в TS `boolean` ↔ `toDbBool` / `fromDbBool`. В SQL `WHERE present = 1`, а не `WHERE present` |
| `JSON` | `string` | только `jsonCodec(zodSchema)`: `encode` перед записью, `decode` после чтения. SQL внутрь не заглядывает |

- Типы строк — `Selectable<…Table>`, `Insertable<…Table>`, `Updateable<…Table>` из `types.ts`.
- Дробных чисел нет: никаких `avg()`, деления с дробным результатом, `REAL`.
- `better-sqlite3` не принимает `boolean` и `Date`: только `number`, `string`, `null`.

### 4.2 Запрещено

- `now()`, `CURRENT_TIMESTAMP`, `gen_random_uuid()`, `random()`: время, UUID и `epoch` генерирует TS (`ctx.clock.now()`), значение передаётся параметром.
- Триггеры, хранимые функции, `serial`, `jsonb`, массивы и прочее, что есть только в одном диалекте.
- `GREATEST` / `LEAST` (в SQLite это `max(a, b)` / `min(a, b)`): считать в TS или `CASE WHEN a > b THEN a ELSE b END`.
- `LIKE`, `ILIKE`, `lower()`, `upper()`: регистр и Unicode обрабатываются по-разному. Нормализация (логин: NFKC → trim → lowercase) делается в TS до записи.
- JSON- и date-функции.
- `UNION ALL` с `LIMIT` в ветках: отдельные запросы, слияние в TS (так устроен `readPage`, DESIGN §3.8).
- `ORDER BY` по `TXT` (человеческому тексту): порядок зависит от collation. Сортировка только по `ID` и числам.
- Пустой `IN ()`: PostgreSQL даёт синтаксическую ошибку. Пустой список обрабатывается в TS до запроса (`selectInChunks` делает это сам).
- `sql.raw` с данными запроса. `sql.raw` — только для констант кода; значения идут параметрами (`sql` template или построитель Kysely).

### 4.3 Можно и нужно

- `ON CONFLICT (…) DO NOTHING | DO UPDATE SET … WHERE …`, `excluded.col`, `RETURNING col, …`.
- `INSERT … SELECT … WHERE …` (в SQLite у `SELECT` перед `ON CONFLICT` обязателен `WHERE`, хотя бы `WHERE true`).
- `COALESCE`, `CASE WHEN`, `NULLIF`, `abs`, `length` (оба диалекта считают символы: согласовано с лимитами UTF-16, API §1.4), `||` для строк.
- `count(*)`, `sum()`, `max()`, `min()` как агрегаты: результат приходит числом в обоих диалектах. `sum()` по пустому множеству даёт `NULL`: `coalesce(sum(x), 0)`.
- Кортежи: `WHERE (user_id, event_id) IN (SELECT user_id, event_id … LIMIT ?)`.
- Keyset-пагинация: `WHERE user_id = ? AND seq > ? ORDER BY seq LIMIT n + 1`. Порядок всегда детерминирован: последний ключ сортировки уникален.
- Имена колонок `type`, `key`, `value`, `code`, `status`, `mode`, `result`, `year` Kysely экранирует сам. В сыром `sql` — `sql.ref("t.col")` / `sql.id(...)`.

### 4.4 Пачки

| Что | Размер | Помощник |
|---|---|---|
| строк в одном `INSERT` | 500 | `insertInChunks(rows, (chunk) => …)` |
| значений в одном `IN (…)` | 1000 | `selectInChunks(values, (chunk) => …)` |
| строк `DELETE` на одну транзакцию (фоновые задачи) | 5000 | `deleteInBatches((limit) => ctx.db.write(…))` |

Фоновое удаление переносимо так: `DELETE FROM t WHERE (pk…) IN (SELECT pk… FROM t WHERE … LIMIT ?)` (в PostgreSQL нет `DELETE … LIMIT`). Каждая пачка — своя короткая `db.write`, между пачками писатель SQLite свободен для запросов.

## 5. Схема и миграции

- Миграция — файл `src/db/migrations/NNNN_name.ts` с `up(db, d)` и строкой в `migrations/index.ts`. Таблицы, индексы и колонки описываются только через `d = ddl(dialect)`: `d.createTable`, `d.createIndex`, `d.addColumn`, затем `d.run(db, …)`. Литеральные типы в миграциях запрещены (ESLint).
- `ddl` проверяет правила API §9.1: `STRICT` в SQLite, `COLLATE "C"` только у `ID` в PG, FK только между `ID`, явный `NULL`/`NOT NULL`, PK `NOT NULL`, `CHECK` только с `length()`, `BETWEEN`, сравнениями и `IS [NOT] NULL` (списки перечислений проверяет zod), `DEFAULT` — константа.
- **Миграции только расширяющие** и заморожены с первого деплоя в живую БД (`v0.1.0-rc.1`). До него файлы 0001–0005 правит только ведущий. После — только новые файлы. `ADD COLUMN`: `NULL` или `NOT NULL DEFAULT <константа>`, без `UNIQUE`/`PRIMARY KEY`, колонка с FK — только `NULL`. Никаких `DROP` и `RENAME` внутри мажорной версии.
- После изменения миграций: `npm run schema:sql` (генерирует `docs/schema.sqlite.sql`, `docs/schema.postgres.sql`, `src/db/schema.snapshot.json`, `src/db/types.ts`) и коммит всех четырёх файлов. `migrations.test.ts` сверяет миграции с DDL-блоком API §9.2: контракт меняется сначала в `docs/API.md`.
- Весь прогон миграций — одна транзакция в обоих диалектах (PG под advisory lock Kysely). Упавшая миграция не оставляет ничего.
- **Старт сервера** (`prepareDatabase`):
  1. `MIGRATE_ON_START=false` и есть ожидающие миграции → выход с кодом 1;
  2. миграции;
  3. БД содержит неизвестные коду миграции, а все известные применены (откат образа) → `warn`, миграции не запускаются, лишние таблицы и колонки только логируются;
  4. неизвестные миграции и при этом неприменённые известные → выход с кодом 1;
  5. сверка схемы со снапшотом (таблицы, колонки, физические типы вместе с `COLLATE "C"`, nullable, `STRICT`; первичный ключ, `UNIQUE`, внешние ключи с `ON DELETE`, выражения `CHECK`; индексы снапшота с колонками по порядку, `UNIQUE` и предикатом частичного индекса): расхождение при `SCHEMA_CHECK=strict` → выход с кодом 1, при `warn` → предупреждение. Выражения `CHECK` и `WHERE` сравниваются в канонической форме (`src/db/sql-expression.ts`): текст миграции, который SQLite хранит дословно, и разобранный PostgreSQL текст (`BETWEEN` → `>= AND <=`, `IN` → `= ANY (ARRAY[…])`, приведения типов) дают одну форму. Лишние ограничения, как лишние таблицы и колонки, — расхождение (кроме режима «схема новее кода»); лишние индексы, добавленные оператором, не мешают.

## 6. Диалекты во время выполнения (только `src/db/**`)

- **Выбор диалекта** — только `DATABASE_URL`: `sqlite://<путь>`, `postgres://` или `postgresql://`. `sqlite::memory:` — только тесты и генерация OpenAPI.
- **В образе** (DESIGN §7.1) база по умолчанию — `sqlite:///data/melogold.db` на томе `/data`; рядом лежат её `-wal`/`-shm`, `secret.key` и `.tmp/`. Корень контейнера только для чтения, поэтому всё, что пишет процесс, живёт в `DATA_DIR`. Копия базы — `VACUUM INTO` в `/data/.tmp` (бэкап, PLAN T3.1), а не копирование файла.
- **SQLite:** одно соединение на процесс; PRAGMA из API §9.4; `auto_vacuum=INCREMENTAL` для новой базы; `PRAGMA optimize` при открытии и раз в 6 ч (`optimizeSqlite` из `dialect-sqlite.ts`, задачу планировщика добавляет PLAN T3.1). Второе соединение к тому же файлу в том же процессе открывать нельзя: `better-sqlite3` синхронный и в `busy_timeout` блокирует цикл событий, поэтому первое соединение не может закончить транзакцию, и через `busy_timeout` приходит `SQLITE_BUSY`. Другие процессы (CLI, бэкап) ждут `busy_timeout` на `BEGIN IMMEDIATE` — это нормально.
- **SQLite:** после некоторых ошибок (`SQLITE_FULL`, `SQLITE_IOERR`) SQLite сам откатывает транзакцию; драйвер тогда не шлёт `ROLLBACK`, чтобы не подменить исходную ошибку (`storage_full`).
- **PostgreSQL:** пул `DATABASE_POOL_MAX`, `statement_timeout = DATABASE_STATEMENT_TIMEOUT_MS` (превышение → `server_busy`), `application_name = melogold`. Таблицы неквалифицированные, живут в `current_schema()`; интроспекция смотрит только туда.
- Ошибки драйверов → коды API §2.4 — только в `errors.ts`.

## 7. Тесты

- Каждый новый запрос покрыт интеграционным тестом `*.int.test.ts`, который проходит **на обоих диалектах**: `npm test` (SQLite, временный файл, WAL) и `npm run db:up && npm run test:pg` (PostgreSQL 18 с локалью `en_US.UTF-8`, отдельная схема на тестовый файл, файлы идут параллельно).
- CI (`.github/workflows/ci.yml`, задача `test`) гоняет оба прогона на каждый push и PR: PostgreSQL поднимается тем же `compose.dev.yml`, и шаг проверяет, что `datcollate` базы — `en_US.UTF-8`. Задача не принята, пока не зелёные оба.
- База с миграциями: `createMigratedTestDatabase()` из `src/test/test-db.ts` → `{ database, db }`; в `after` — `db.destroy()`, затем `database.cleanup()`.
- Второй независимый писатель: в PostgreSQL — `database.openDb()` (свой пул); в SQLite — дочерний процесс (см. `tx.int.test.ts`), не второе соединение в том же процессе.
- Обязательные регрессии слоя БД уже есть: M10 (join `sync_playlist_items → sync_tracks` на `en_US.UTF-8`, `migrate.int.test.ts`), M11 (ограничение с `ON CONFLICT` внутри `db.write`, `heads.int.test.ts` и `tx.int.test.ts`), вложенность, `lockUser` первым, `ensureHead`, 20 параллельных писателей одного пользователя.

## 8. Чек-лист ревью запроса

- [ ] Запрос в репозитории своего модуля, принимает `q`, не открывает транзакций.
- [ ] Запись состояния пользователя — под `lockUser` первым оператором и с `seq` из головы; иначе CAS с проверкой `numUpdatedRows`.
- [ ] Нет перехвата ошибок ограничений внутри транзакции; есть `ON CONFLICT` / `RETURNING`.
- [ ] Внутри транзакции только `q`; SSE и прочие эффекты после commit; `fn` безопасно выполнить повторно.
- [ ] Нет запрещённых функций и конструкций (§4.2); `IN` не пустой и не длиннее 1000; вставки ≤ 500 строк.
- [ ] Сравнения и сортировка только по `ID` и числам; `BOOL` как `0 | 1`; `JSON` через `jsonCodec`.
- [ ] Время и идентификаторы из TS.
- [ ] Интеграционный тест зелёный на SQLite и на PostgreSQL.
