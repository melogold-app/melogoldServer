# AGENTS.md: правила для агентов и участников

## Источники истины

1. `docs/API.md`: точный контракт (эндпоинты, поля, коды ошибок, SSE, DDL, переменные окружения).
2. `docs/DESIGN.md`: архитектура и причины решений.
3. `docs/PLAN.md`: этапы, задачи, владение файлами, приёмка.
4. `docs/database.md`: правила переносимого SQL и транзакций (обязательны).

Если документы расходятся, прав `API.md`, затем `DESIGN.md`. Эндпоинты, поля и коды не придумываются: изменение контракта начинается с правки `docs/API.md`.

## Стек и рантайм

- Node 24 LTS (`.node-version`, `engines: >=24`). API новее Node 24 не используются.
- TypeScript 6 только для typecheck: `node` исполняет `.ts` напрямую (type stripping), сборки и `dist/` нет.
- Отсюда правила кода:
  - относительные импорты с расширением `.ts` (`import { x } from "./x.ts"`);
  - только стираемый синтаксис (`erasableSyntaxOnly`): без `enum`, `namespace`, декораторов и parameter properties;
  - импорт типов через `import type` (`verbatimModuleSyntax`).
- Длины строк считаются в единицах UTF-16 (API §1.4). В zod 4.6 `.min()`, `.max()` и `.length()` у строк считают кодовые точки, поэтому лимиты строк проверяются через `value.length`.
- Fastify 5, zod 4 (`fastify-type-provider-zod`), OpenAPI 3.0.3, Kysely 0.29 (SQLite через better-sqlite3 и PostgreSQL 18 через `pg`), argon2id.

## Команды

| Команда                                     | Что делает                                                                                   |
| ------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `npm ci`                                    | установка зависимостей                                                                       |
| `npm run typecheck`                         | `tsc` без эмита                                                                              |
| `npm run lint` / `npm run lint:fix`         | ESLint (type-checked, правила импорта и `process.env`)                                       |
| `npm run format` / `npm run format:check`   | Prettier                                                                                     |
| `npm test`                                  | все `src/**/*.test.ts` на SQLite (`TEST_DB=sqlite`)                                          |
| `npm run db:up`, затем `npm run test:pg`    | PostgreSQL 18 (`en_US.UTF-8`, порт 55432) из `compose.dev.yml` и те же тесты на нём          |
| `npm run openapi` / `npm run openapi:check` | генерация `openapi/*` и `spec/error-codes.json` / проверка, что они закоммичены              |
| `npm run schema:sql`                        | генерация `docs/schema.*.sql`, `src/db/schema.snapshot.json` и `src/db/types.ts` из миграций |
| `npm run dev`                               | сервер с `--watch`, переменные из `.env` (образец — `.env.example`)                          |
| `npm run check`                             | typecheck, lint, format:check и тесты на SQLite одной командой                               |

## Обязательные правила

- **Владение файлами.** Каждый файл принадлежит одной задаче `docs/PLAN.md`. Замороженные после M0 файлы (список в PLAN, «Общие правила», п. 2) меняет только ведущий.
- **Генерируемые файлы** (`openapi/*`, `spec/error-codes.json`, `docs/schema.*.sql`, `src/db/schema.snapshot.json`, `src/db/types.ts`) руками не правятся: `npm run openapi && npm run schema:sql`.
- **`process.env`** читается только в `src/config/env.ts` (функция `parseEnv`), `src/test/test-db.ts` и `scripts/`. Остальной код получает конфигурацию через контекст.
- **`kysely`** импортируется только в `src/db/**`, `*.repository.ts`, `src/modules/sync/**`, миграциях, тестах и `scripts/`. Репозиторий чужого модуля импортировать нельзя.
- **Слои модуля:** `routes` — схемы и вызов сервиса; `service` — логика, `ctx.db.read/write`, `AppError` с кодом, SSE после commit; `repository` — `(q, …)` только по своим таблицам.
- **SQL:** один код на оба диалекта; ограничения не перехватываются внутри транзакции (`ON CONFLICT` и `RETURNING`); `lockUser` — первый оператор сериализуемой записи; в транзакции нет сети и argon2. Каждый новый запрос покрыт интеграционным тестом.
- **Ошибки:** клиенты ветвятся только по `code` из реестра `src/http/error-codes.ts`. Сервисы бросают только `new AppError(code, { details })` из `src/http/errors.ts`: статус и текст берутся из реестра, обязательные детали проверяет typecheck.
- **HTTP-политика маршрута** (auth из API §3, лимит тела §1.9, лимиты частоты §1.10, `X-Sync-Protocol`, проверка диска) задаётся одной таблицей `src/http/route-policy.ts`, а не опциями маршрутов. Маршрут вне таблицы закрыт (`bearer`, 120/мин user). Вызывающий Bearer-маршрута — `requireAuth(request)`.
- **Время и строки:** время на входе — `parseIso`, на выходе — `formatIso` (`src/lib/time.ts`); длины строк — `utf16LengthBetween`, обрезка — `truncateUtf16` (`src/lib/strings.ts`). Время берётся только из `ctx.clock`.
- **Сессии и удаление устройств** — только через `issueSession` (`src/lib/session.ts`) и `removeDevicesInTx` + `afterRemove` после commit (`src/lib/device-removal.ts`).
- **Контракт** (`src/contract/**`): каждый DTO — zod-схема с `.meta({ id })` = имя компонента из API §4/§6/§11; полный список с направлением — `CONTRACT_COMPONENTS` (`src/contract/index.ts`), сверку с `docs/API.md` делают `src/contract/*.test.ts`.
  - Запросы проверяются: поле `?` — `optional()` (отсутствие и `null` дают `undefined`), длины — `text()` в UTF-16, время — `Iso` (на выходе epoch-мс), лишние ключи отбрасываются.
  - Ответы проверяются только по структуре (ключи, `null`, типы, целые); форматы и длины только документируются, перечисления — `type: string` с `*_VALUES` в коде.
  - `POST /sync` валидирует `SyncRequestEnvelope` (только `opId`/`kind`/`at`/`base`), а `SyncRequest` с плоским `SyncOp` — только источник OpenAPI. Метаданные `TrackInput` схема пропускает как `unknown`, чистит сервис (DESIGN §3.9).
- **Матрица DESIGN §4.8** — только функции `src/modules/security/policy.ts` (`Gate`: `allow` / `verify_password` / `refuse`).
- **Личных значений по умолчанию нет** ни в коде, ни в конфигурации.

## Тесты

- `*.test.ts` — чистые функции; `*.int.test.ts` — на настоящей БД, гоняются на **обоих** диалектах (`npm test` и `npm run test:pg`).
- Раннер — `node:test`, HTTP через `app.inject`.

## Definition of Done

Зелёные `npm run typecheck`, `lint`, `format:check`, `openapi:check`, `npm test` и `npm run test:pg`. Задача не принята, пока оба прогона БД не зелёные.

## Git

- Сообщения коммитов — conventional commits на русском: `feat(db): …`, `fix(auth): …`, `docs: …`.
- Теги и деплой делает только ведущий.
