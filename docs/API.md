# Melogold API v1: контракт

**Статус: нормативный, 2026-09-23.** По этому документу сервер и четыре клиента (Android/Kotlin, macOS/Swift, Windows/C#, Linux/Rust) реализуют дословно:
- эндпоинты;
- поля JSON;
- коды ошибок;
- события SSE;
- форматы QR;
- DDL;
- переменные окружения.

Обоснования решений находятся в `docs/DESIGN.md`, алгоритмы — в DESIGN §3–§4.

**Сверено с кодом:**
- `C/utils/errors.ts:56-67`: `sendError` отдаёт `{statusCode, error: message, message, ...details}`, поле `error` несёт текст;
- `C/modules/live/live.service.ts:201-206`: `system.connected` с `{heartbeatMs, retryMs}`;
- `C/modules/live/live.service.ts:269-276`: конверт `{id, type, at, payload}`;
- `C/modules/live/live.routes.ts:166-187`: первым идёт `retry:`, затем кадры `id:` + `data:` без `event:`, heartbeat приходит комментарием.

Здесь и далее `C/` = `/Users/maxim/Documents/VPN/clementineServer/src/`.

---

## 1. Соглашения

### 1.1 Base URL, версии, OpenAPI
- **Base URL** = `scheme://host[:port][/prefix]`, без `/` в конце. Официальный сервер: `https://api.melogold.app`. Клиент только склеивает base и путь.
- **Версии в URL нет.** Совместимость определяют:
  - для HTTP API — `apiVersion`/`minApiVersion` из `/server/info` (сейчас 1/1);
  - для синхронизации и playback — `features.sync.protocol`/`minProtocol` (1/1) плюс заголовок `X-Sync-Protocol`.
- **Что можно добавлять внутри `apiVersion: 1`:**
  - эндпоинты;
  - необязательные поля запросов и поля ответов;
  - новые значения строковых перечислений в ответах;
  - новые коды ошибок, `kind` операций и события SSE.
- **OpenAPI 3.0.3:**
  - доступна по `GET /openapi.json`, а также в ассетах релиза: `openapi.json`, `openapi.yaml`, `error-codes.json`;
  - у каждой операции есть `operationId` из §3 и `tags`;
  - каждое тело и каждый вложенный объект — именованный компонент с именем из §4. Inline-схемы запрещены.
- **Лицензия файлов контракта:** см. DESIGN §12, вопрос 2.

### 1.2 Заголовки

| Запрос | Где | Правило |
|---|---|---|
| `Authorization: Bearer <accessToken>` | все маршруты, кроме помеченных public | закрыто по умолчанию |
| `Content-Type: application/json` | любой POST/PUT/PATCH | UTF-8. **Тело — JSON-объект, как минимум `{}`**. Иное → `415 unsupported_media_type`. Пустое тело → `400 invalid_json` |
| `Accept-Encoding: gzip` | все | рекомендуется |
| `User-Agent: melogold-<android\|macos\|windows\|linux>/<semver>` | все | обязателен у клиентов, сервер только логирует |
| `Accept-Language` | все | BCP 47. Влияет только на строки, которые сервер пишет сам (имя плейлиста восстановления, «Без названия»). Сообщения ошибок не локализуются |
| `X-Sync-Protocol: 1` | `/sync`, `/sync/summary`, `/sync/merge-plan`, `/playback/state` | обязателен. Нет или не целое → `400 invalid_request`. Вне `[minProtocol, protocol]` → `409 protocol_unsupported` |
| `X-Request-Id` | необязательный | `^[A-Za-z0-9._-]{8,64}$`, иначе генерируется свой |

Заголовков `X-HWID` и `X-Device-*` нет. Устройство определяется claim `did` в токене, метаданные приходят блоком `device` в теле.

| Ответ | Когда |
|---|---|
| `X-Request-Id` | всегда |
| `Retry-After: <сек>` | 429, 503 |
| `Cache-Control: no-store` | все JSON, кроме `/server/info` (`public, max-age=60`) |
| `Content-Encoding: gzip` | JSON ≥ 1 КиБ при `HTTP_COMPRESSION=true`. SSE не сжимается |
| `Access-Control-Allow-Origin: *` | только `/server/info`, `/health`, `/health/live`. Остальное по `CORS_ORIGINS` (по умолчанию выключено) |

Ответы, которые пришли **не** в формате JSON (например, от Caddy или шлюза), клиент разбирает по HTTP-статусу:
- 413 → уменьшить пакет;
- 502/503/504 → backoff.

### 1.3 JSON
- **Ключи** в camelCase. Перечисления — строки в lowercase: `snake_case` для кодов, `dot.case` для `kind` и типов SSE.
- **Ответы:**
  - каждое объявленное поле присутствует всегда; если значения нет, приходит `null`;
  - массивы никогда не `null`;
  - исключения: детали в `ErrorResponse` (только у своих кодов) и ключи `ServerInfo.features.*` (отсутствие ключа означает «функция не поддерживается»).
- **Запросы:**
  - поле с `?` можно опустить или передать `null`;
  - поле без `?` обязательно;
  - лишние поля отбрасываются молча.
- **Клиенты** игнорируют неизвестные поля и переживают неизвестные значения перечислений. В OpenAPI у полей ответов тип `type: string`, а список значений указан в `description`. `enum` используется только в запросах.
- **Полиморфизма нет** (`oneOf`/`anyOf`/discriminator). `SyncOp` описан плоской схемой с полем `kind`.

### 1.4 Строки и числа
- **Санитизация.** До валидации сервер обходит все строки тела запроса:
  - удаляет `U+0000`;
  - заменяет одиночные суррогаты на `U+FFFD`.
- **Длины** всех строк считаются в **единицах UTF-16**. На разных платформах это:
  - Kotlin, C#: `String.length`;
  - Swift: `s.utf16.count`;
  - Rust: `s.encode_utf16().count()`;
  - JS: `s.length`.

  Лимит N в UTF-16 гарантирует не больше N кодовых точек, поэтому проверки длины в БД согласованы с zod.
- **Обрезка до лимита** не разрывает суррогатную пару.
- **Числа** только целые:
  - `Int32` ≤ 2 147 483 647 (zod `.max`);
  - остальные ≤ 2^53−1.

  Дробных чисел в API нет.

### 1.5 Время
- **Сервер отдаёт** время строго в виде `YYYY-MM-DDTHH:mm:ss.sssZ`.
- **Сервер принимает** `^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?Z$`:
  - дробная часть усекается до мс, поэтому `Instant.toString()` (JVM) и `"o"` (C#) подходят без переделки;
  - допустимый диапазон [2000-01-01, 2100-01-01);
  - смещения, кроме `Z`, не принимаются.
- **В БД** время хранится как epoch-мс UTC.
- **Единицы в именах полей:** `*Ms` для миллисекунд, `*Seconds` для секунд.
- **`serverTime`** есть в `/server/info`, `AuthSession`, `RefreshResponse`, `MeResponse`, `/sync`, `/sync/summary`, `GET/PUT /playback/state`. Клиент пересчитывает `clockOffset`, если расхождение больше 2 с.

### 1.6 Форматы

| Тип | Правило |
|---|---|
| `Uuid` | `^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, **только lowercase**. Клиент генерирует v4 для `opId`, `playlistId`, `eventId`, `sessionId` |
| `VideoId` | `^[A-Za-z0-9_-]{11}$`: **любое** видео YouTube. Треки `local:*` не передаются |
| `BrowseId` | `^[A-Za-z0-9_-]{1,64}$`: альбом, артист, канал `UC…`, `browseId` плейлиста |
| `HttpUrl` | `^https?://`, до 2048 символов |
| `Login` | на входе 1..64. Нормализация: NFKC → trim → lowercase. Новый: `^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$`, не из резервного списка |
| `Password` | NFKC перед hash и verify. Новый: 8..128 символов UTF-16 и ≤ 512 байт UTF-8. Проверяемый: 1..128 символов и ≤ 512 байт |
| `Hwid` | `^[0-9a-f]{64}$` = `hex(sha256("melogold-hwid-v1\|" + platformId + "\|" + serverId))`. `platformId`: Android `ANDROID_ID`; macOS `IOPlatformUUID`; Windows `MachineGuid\|installSalt`; Linux `/etc/machine-id\|installSalt`. Запасной — случайный UUID в приватном хранилище. Векторы: `spec/hwid.vectors.json` |
| `Platform` | `^[a-z0-9_]{1,16}$`. Известные значения: `android`, `macos`, `windows`, `linux`, `other`. Хранится как пришло |
| `DeviceName` | удалить C0/C1, U+200E/U+200F, U+202A–U+202E, U+2066–U+2069; схлопнуть пробелы; trim. После очистки 1..64 символов |
| `Cursor` | `""` или `^[0-9a-f]{8}\.[0-9]{1,16}\.[0-9]{1,16}$`. Непрозрачен |
| `RecoveryCode` | вывод `XXXX-XXXX-XXXX-XXXX-XXXX`, Crockford `0123456789ABCDEFGHJKMNPQRSTVWXYZ`. Ввод: upper, удалить пробелы, `-`, `_`; `O→0`, `I,L→1`; ровно 20 символов |
| `UserCode` | вывод `XXXX-XXXX`, тот же алфавит и нормализация, ровно 8 символов |
| `VerifyCode` | `^[0-9]{2}$` |
| `LinkToken` | `^[A-Za-z0-9_-]{43}$` |
| `PollSecret` | `^mgps_[A-Za-z0-9_-]{43}$` |
| `RefreshToken` | `mgrt1.<b64url>.<b64url>`, до 1024 символов |
| `PowChallenge` | `mgpow1.<b64url>.<b64url>`, до 256 символов. `PowNonce`: `^[0-9]{1,16}$` |

### 1.7 Аутентификация
**Access-токен:**
- JWT HS256, claims `{sub, did, av, rid, iat, exp}`, TTL `ACCESS_TOKEN_TTL_SECONDS`;
- клиент JWT не разбирает, срок жизни берёт из `accessTokenExpiresAt`.

**Guard** проверяет каждый запрос по шагам:
1. нет Bearer → `401 unauthorized`;
2. подпись или формат неверны → `401 access_token_invalid`; токен истёк → `401 access_token_expired`;
3. нет устройства `did`/`sub` у неудалённого пользователя → `401 session_revoked`;
4. `auth_version ≠ av` → `401 access_token_expired`;
5. подтверждение `rid` (DESIGN §4.3);
6. `last_seen_at`, не чаще раза в 5 мин.

На Bearer-маршрутах 401 означает только проблему токена. Неверный пароль при повторной проверке — это `403 invalid_password`.

**Refresh:** ротация по CAS, окно `REFRESH_GRACE_SECONDS` отдаёт только **неподтверждённого** преемника (DESIGN §4.4).

**Обязанности клиента:**
- refresh single-flight, проактивно за 60 с до истечения;
- новый refresh сохраняется **до** первого использования нового access;
- на `access_token_expired` или `access_token_invalid` — один refresh и один повтор запроса;
- на `session_revoked` или любую 401 от `/auth/refresh` → `AuthRequired`: токены стираются, а библиотека, outbox и `binding` сохраняются;
- сетевые ошибки и 5xx токены не стирают.

### 1.8 Идемпотентность и повторы

| Запрос | Автоматический повтор |
|---|---|
| GET; PUT и DELETE `/playback/state` | да |
| `POST /sync` | да. Ops идемпотентны, повтор возвращает `replayed: true` |
| `POST /sync/merge-plan` | да |
| `POST /auth/refresh` | да. В окне grace возвращается тот же преемник, если он не подтверждён |
| `POST /auth/logout`, `/auth/link/cancel`, `/auth/link/poll` | да. poll после `completed` в течение 60 с повторно выдаёт ту же сессию |
| `POST /auth/me/links/resolve`, `approve`/`deny`/`cancel`, `/auth/me/recovery-code/confirm` | да: повтор в достигнутом статусе даёт тот же ответ |
| `register`, `recover`, `me/password`, `me/recovery-code`, `me/delete`, `revoke`, `revoke-others`, `link/requests`, `link/claim`, `me/links` | **нет**. На сетевой ошибке клиент перечитывает состояние: после register — пробует login, после recover — login новым паролем, затем `GET /auth/me` и `devices` |

### 1.9 Лимиты тела
- `/sync` — 4 МиБ, а также **бюджет работы**: Σ(`videoIds` + `entries` + `tracks`) по всем ops не больше 20 000;
- `/sync/merge-plan` — 1 МиБ;
- `/playback/state` — 128 КиБ;
- `/auth/**` — 16 КиБ;
- остальное — 64 КиБ.

Превышение любого из них → `413 payload_too_large`.

### 1.10 Лимиты частоты
**Ключи:**
- `ip` — `request.ip` с учётом `TRUST_PROXY`: IPv4 целиком, IPv6 по префиксу `/56` (`normalizeIP(ip, 56)` из `@fastify/rate-limit`);
- `user` — проверенный `sub`;
- `device` — проверенный `did`;
- `rt` — `did` из refresh-токена с проверенным HMAC (невалидный токен → ключ `ip`);
- `ps` — `sha256(pollSecret)`.

При `RATE_LIMIT_ENABLED=false` лимиты не действуют.

| Маршрут | Лимит |
|---|---|
| `GET /` | 60/мин ip |
| `GET /server/info` | 120/мин ip |
| `GET /auth/register/challenge` | 30/мин ip |
| `POST /auth/register` | 30/ч ip + PoW (если включён) |
| `POST /auth/login` | 60/10 мин ip + троттлинг по логину в БД |
| `POST /auth/refresh` | 30/мин rt |
| `POST /auth/logout` | 30/мин rt |
| `POST /auth/recover` | 20/ч ip |
| `POST /auth/link/requests` | 30/10 мин ip, не больше 20 активных запросов на ip |
| `POST /auth/link/claim` | 30/10 мин ip |
| `POST /auth/link/poll`, `/auth/link/cancel` | 60/мин ps и 600/мин ip |
| Bearer по умолчанию | 120/мин user |
| `GET /auth/me/events` | 30 открытий/мин user; не больше 4 потоков на устройство и 64 на пользователя |
| `POST /auth/me/links` | 10/10 мин user, не больше 3 активных |
| `POST /auth/me/links/resolve` | 20/10 мин user |
| `me/password`, `me/recovery-code`, `me/delete` | 5/ч user + reauth |
| `GET /auth/me/export` | 3/ч user |
| `GET /sync/summary`, `POST /sync/merge-plan` | 10/мин user |
| `POST /sync` | 120/мин user |
| `GET /playback/state` | 60/мин device |
| `PUT /playback/state` | 30/мин device |
| `DELETE /playback/state` | 10/мин user |
| `/health*`, `/openapi.json`, `/docs` | без лимита |

---

## 2. Ошибки

### 2.1 Конверт
```ts
type ErrorResponse = {
  statusCode: number;
  error: string;                // = message (форма Clementine)
  message: string;              // английский текст для логов; не для UI и не для логики; у 5xx общий текст
  code: string;                 // §2.2 — единственное, по чему ветвятся клиенты
  // детали — только у своих кодов:
  retryAfterSeconds?: number; issues?: ValidationIssue[]; minLength?: number; maxLength?: number;
  deviceLimit?: number; deviceCount?: number; minProtocol?: number; maxProtocol?: number;
  floorCursor?: string; minDeviceAgeDays?: number;
};
type ValidationIssue = { path: string /* "ops.3.opId" */; code: string /* код zod */ };
```
```json
{"statusCode":409,"error":"Device limit reached","message":"Device limit reached","code":"device_limit_reached","deviceLimit":20,"deviceCount":20}
```
- Обработчик ошибок регистрируется до маршрутов.
- Отказ никогда не отдаётся со статусом 200.
- Ошибки ограничений БД и драйверов переводятся в коды по §2.4. Прочие сырые ошибки → `500 internal_error`.

### 2.2 Коды (полный реестр → `spec/error-codes.json`)

| HTTP | `code` | Детали | Где | Клиент |
|---|---|---|---|---|
| 400 | `invalid_request` | `issues` | любой | ошибка клиента. На `/sync` — бисекция пакета (DESIGN §3.9) |
| 400 | `invalid_json` | — | любой | ошибка клиента |
| 400 | `invalid_login_format` | — | register | подсказка у поля |
| 400 | `password_too_short` / `password_too_long` | `minLength` / `maxLength` | register, recover, me/password | подсказка у поля |
| 400 | `password_too_common`, `password_contains_login` | — | то же | подсказка у поля |
| 401 | `unauthorized` | — | Bearer | ошибка клиента |
| 401 | `access_token_invalid`, `access_token_expired` | — | Bearer | refresh и один повтор |
| 401 | `session_revoked` | — | Bearer, refresh | `AuthRequired` |
| 401 | `invalid_credentials` | — | login | «Неверный логин или пароль» |
| 401 | `invalid_recovery_code` | — | recover | одинаково для неизвестного логина и неверного кода |
| 401 | `invalid_refresh_token`, `refresh_token_reused`, `device_mismatch` | — | refresh | `AuthRequired` (при `reused`: «сеанс завершён из соображений безопасности») |
| 403 | `registration_closed` | — | register | спрятать регистрацию |
| 403 | `pow_required`, `pow_invalid` | — | register | получить challenge, решить, повторить (один раз) |
| 403 | `invalid_password` | — | me/password, me/recovery-code, me/delete, revoke*, PATCH devices | повторная проверка не прошла (счётчик reauth) |
| 403 | `current_password_required` | `minDeviceAgeDays` | me/password | запросить старый пароль |
| 403 | `security_cooldown` | `retryAfterSeconds` | me/recovery-code, me/delete | объяснить задержку |
| 403 | `cooldown_restricted` | `retryAfterSeconds` | revoke*, PATCH devices, me/password | «Это устройство ограничено после смены пароля без старого» |
| 403 | `recent_device_restricted` | — | revoke*, PATCH devices | запросить пароль и повторить с `password` |
| 403 | `link_denied` | — | link/poll | «Отклонено» |
| 404 | `not_found` | — | неизвестный маршрут | — |
| 404 | `device_not_found` | — | devices/{id} | перечитать список |
| 404 | `link_not_found` | — | link/*, me/links/* | «Код не найден» |
| 409 | `login_taken` | — | register | подсказка у поля |
| 409 | `device_limit_reached` | `deviceLimit`, `deviceCount` | login, approve, poll | открыть список устройств |
| 409 | `cannot_revoke_current_device` | — | revoke | использовать logout |
| 409 | `link_already_claimed`, `link_wrong_mode`, `link_not_claimed` | — | link/* | пересоздать или отменить |
| 409 | `link_verify_mismatch` | — | approve | «Число не совпало — привязка отклонена» |
| 409 | `recovery_code_outdated` | — | recovery-code/confirm | перечитать `/auth/me` |
| 409 | `protocol_unsupported` | `minProtocol`, `maxProtocol` | sync, playback | `Incompatible` |
| 409 | `playback_queue_required` | — | PUT playback | повторить с `queue` |
| 410 | `link_expired`, `link_cancelled` | — | link/* | пересоздать привязку |
| 410 | `cursor_invalid` | — | sync | `Merging(silent)` |
| 410 | `cursor_expired` | `floorCursor` | sync | `FullResync(authoritative)` |
| 413 | `payload_too_large` | — | любой | `/sync`: пакет вдвое; playback: окно вдвое |
| 415 | `unsupported_media_type` | — | любой | ошибка клиента |
| 429 | `rate_limited` | `retryAfterSeconds` + заголовок | любой | backoff |
| 429 | `login_throttled` | `retryAfterSeconds` | login | обратный отсчёт |
| 429 | `reauth_throttled` | `retryAfterSeconds` | действия с паролем | обратный отсчёт |
| 500 | `internal_error` | — | любой | общий текст |
| 501 | `not_implemented` | — | заглушки разработки | — |
| 503 | `server_busy` | `retryAfterSeconds` + заголовок | argon2, занятость или таймаут БД, CAS playback | backoff |
| 503 | `unavailable` | `retryAfterSeconds?` | `/health`, нет соединения с БД | backoff |
| 503 | `storage_full` | `retryAfterSeconds` | запись данных при нехватке диска | backoff, показать «сервер переполнен» |

### 2.3 Коды результатов ops (`OpResult.code`, не HTTP)

| Код | Статус | Клиент |
|---|---|---|
| `playlist_deleted` | `rejected` | удалить op |
| `invalid_video_id` | `rejected` | удалить op |
| `unknown_kind` | `deferred` | оставить (повтор при смене версии) |
| `invalid_payload` | `deferred` | оставить |
| `quota_exceeded` | `deferred` | оставить, показать квоту |
| `playlist_not_found` | `deferred` | оставить |
| `op_rate_limited` | `deferred` + `retryAfterSeconds` | **держать как pending**, повторить позже |
| `client_bug`, `server_error` | только локально | ставит клиент (DESIGN §3.9) |

### 2.4 Ошибки БД → HTTP (только `src/db/errors.ts`)

| Ошибка | Ответ |
|---|---|
| unique / FK (PG `23505`/`23503`; SQLite `SQLITE_CONSTRAINT_UNIQUE`/`_PRIMARYKEY`/`_FOREIGNKEY`) | сервис переводит в свой код. Непереведённая → 500 |
| PG `40P01`, `40001`, `55P03`, `57014`, `53300`; SQLite `SQLITE_BUSY` после `busy_timeout` | `503 server_busy`, `Retry-After: 1..2` |
| PG `08*`, `57P01` | `503 unavailable`, `Retry-After: 5` |
| PG `53100`; SQLite `SQLITE_FULL` | `503 storage_full`, `Retry-After: 600` |
| PG `22021` (NUL), `22003` (переполнение) | не должны возникать (§1.4). Если возникли → 500 и это баг |

---

## 3. Эндпоинты

| # | Метод | Путь | operationId | Auth | 2xx | Назначение |
|---|---|---|---|---|---|---|
| 1 | GET | `/` | — (вне OpenAPI) | public | 200 html | страница для камеры телефона: имя, URL, кнопка `melogold://server?…` |
| 2 | GET | `/health` | `getHealth` | public | 200 | readiness (`SELECT 1`, 2 с) |
| 3 | GET | `/health/live` | `getLiveness` | public | 200 | liveness |
| 4 | GET | `/openapi.json` | — | public | 200 | спецификация |
| 5 | GET | `/server/info` | `getServerInfo` | public | 200 | discovery |
| 6 | GET | `/auth/register/challenge` | `getRegisterChallenge` | public | 200 | вызов PoW |
| 7 | POST | `/auth/register` | `register` | public | 201 | аккаунт, устройство, код восстановления |
| 8 | POST | `/auth/login` | `login` | public | 200 | вход |
| 9 | POST | `/auth/refresh` | `refreshSession` | refresh | 200 | ротация |
| 10 | POST | `/auth/logout` | `logout` | refresh | 204 | удалить своё устройство |
| 11 | POST | `/auth/recover` | `recoverAccount` | public | 200 | сброс пароля кодом |
| 12 | POST | `/auth/link/requests` | `createLinkRequest` | public | 201 | новое устройство показывает QR (`request`) |
| 13 | POST | `/auth/link/claim` | `claimLink` | public | 200 | новое устройство сканирует приглашение (`invite`) |
| 14 | POST | `/auth/link/poll` | `pollLink` | pollSecret | 200 | long-poll до 25 с, выдача сессии |
| 15 | POST | `/auth/link/cancel` | `cancelLinkRequest` | pollSecret | 204 | отмена новым устройством |
| 16 | GET | `/auth/me` | `getMe` | Bearer | 200 | профиль и текущее устройство |
| 17 | GET | `/auth/me/events` | `streamEvents` | Bearer | 200 SSE | живые события (§6) |
| 18 | GET | `/auth/me/devices` | `listDevices` | Bearer | 200 | список устройств |
| 19 | PATCH | `/auth/me/devices/{deviceId}` | `renameDevice` | Bearer | 200 | переименовать |
| 20 | POST | `/auth/me/devices/{deviceId}/revoke` | `revokeDevice` | Bearer | 204 | отозвать другое устройство |
| 21 | POST | `/auth/me/devices/revoke-others` | `revokeOtherDevices` | Bearer | 200 | завершить другие сеансы |
| 22 | POST | `/auth/me/password` | `changePassword` | Bearer | 200 | смена пароля |
| 23 | POST | `/auth/me/recovery-code` | `rotateRecoveryCode` | Bearer | 200 | новый код |
| 24 | POST | `/auth/me/recovery-code/confirm` | `confirmRecoveryCode` | Bearer | 204 | «код сохранён» |
| 25 | POST | `/auth/me/delete` | `deleteAccount` | Bearer | 204 | удаление аккаунта |
| 26 | GET | `/auth/me/export` | `exportAccount` | Bearer | 200 | выгрузка JSON (поток) |
| 27 | POST | `/auth/me/links` | `createLinkInvite` | Bearer | 201 | вошедшее устройство показывает QR (`invite`) |
| 28 | POST | `/auth/me/links/resolve` | `resolveLink` | Bearer | 200 | вошедшее сканирует или вводит код (`request`) |
| 29 | GET | `/auth/me/links/{linkId}` | `getLink` | Bearer | 200 | карточка одобрения |
| 30 | POST | `/auth/me/links/{linkId}/approve` | `approveLink` | Bearer | 200 | одобрить (со сверкой числа) |
| 31 | POST | `/auth/me/links/{linkId}/deny` | `denyLink` | Bearer | 200 | отклонить |
| 32 | POST | `/auth/me/links/{linkId}/cancel` | `cancelLink` | Bearer | 204 | отменить |
| 33 | GET | `/sync/summary` | `getSyncSummary` | Bearer + XSP | 200 | сводка для диалога слияния |
| 34 | POST | `/sync/merge-plan` | `planMerge` | Bearer + XSP | 200 | план слияния плейлистов |
| 35 | POST | `/sync` | `sync` | Bearer + XSP | 200 | отправить ops и получить изменения |
| 36 | GET | `/playback/state` | `getPlaybackState` | Bearer + XSP | 200 | состояние |
| 37 | PUT | `/playback/state` | `putPlaybackState` | Bearer + XSP | 200 | публикация |
| 38 | DELETE | `/playback/state` | `clearPlaybackState` | Bearer + XSP | 204 | «забыть текущее воспроизведение» |
| — | GET | `/docs` | — | public | 200 | только при `OPENAPI_DOCS_UI=true` |

- XSP — заголовок `X-Sync-Protocol`.
- Параметры `{deviceId}` и `{linkId}` имеют тип `Uuid`. Неверный формат → `400 invalid_request`.
- Маршрутов `/history*`, `/link/*` и `DELETE /auth/me/devices/{id}` **нет**.

---

## 4. Схемы и эндпоинты по разделам
Нотация: `?` означает «можно опустить или передать `null`». Имена типов совпадают с компонентами OpenAPI.

### 4.1 Общие типы
```ts
type Iso = string; type Uuid = string; type VideoId = string; type BrowseId = string; type Cursor = string;

type ArtistRef = { id: BrowseId | null; name: string /*1..200*/ };

type TrackDto = {                     // ответ; трек = любое видео YouTube
  videoId: VideoId;
  title: string;                      // 1..500; при metadataStub = videoId
  artistsText: string | null;         // ≤500; для обычного видео — имя канала
  artists: ArtistRef[];               // ≤50; для видео — [{id:"UC…", name:<канал>}] или []
  albumId: BrowseId | null;
  albumTitle: string | null;          // ≤500
  durationMs: number | null;          // Int32; null — неизвестно или live
  durationText: string | null;        // ≤16: "3:33", "1:02:03"
  thumbnailUrl: string | null;        // HttpUrl
  explicit: boolean;
  videoType: string | null;           // song|video|ugc|live|podcast_episode|… (≤32, [a-z_])
  metadataStub: boolean;              // true — метаданных нет
};
type TrackInput = {                   // запрос; разбор мягкий (DESIGN §3.9): неверные поля → null, неверный элемент отбрасывается
  videoId: string; title?: string; artistsText?: string; artists?: ArtistRef[]; albumId?: string; albumTitle?: string;
  durationMs?: number; durationText?: string; thumbnailUrl?: string; explicit?: boolean; videoType?: string;
};
type DeviceInput = {
  hwid: string; name: string; platform: string;             // Hwid, DeviceName, Platform
  osVersion?: string; model?: string; clientVersion?: string;   // ≤64 каждое
};
type DevicePatch = {                  // refresh: hwid обязателен, остальные поля — если изменились
  hwid: string; name?: string; osVersion?: string; model?: string; clientVersion?: string;
};
type DeviceDto = {
  id: Uuid; name: string /* customName ?? reportedName */; reportedName: string; customName: string | null;
  platform: string; osVersion: string | null; model: string | null; clientVersion: string | null;
  linkedVia: string;                  // register|login|link|recovery
  linkedByDeviceId: Uuid | null;
  createdAt: Iso; lastSeenAt: Iso; lastSyncAt: Iso | null;
  recentUntil: Iso | null;            // до этого момента устройство «новое» (DESIGN §4.8), иначе null
  isCurrent: boolean;
};
type SecurityCooldown = { until: Iso; startedAt: Iso; deviceId: Uuid | null; deviceName: string | null };
type RecoveryCodeStatus = { createdAt: Iso; confirmed: boolean };
type UserDto = {
  id: Uuid; login: string; createdAt: Iso; passwordChangedAt: Iso;
  recoveryCodeStatus: RecoveryCodeStatus;
  securityCooldown: SecurityCooldown | null;
};
type TokenPair = { accessToken: string; accessTokenExpiresAt: Iso; refreshToken: string; refreshTokenExpiresAt: Iso };
type AuthSession = {                  // register, login, recover, завершение привязки (poll)
  user: UserDto; device: DeviceDto; tokens: TokenPair; serverId: Uuid; serverTime: Iso;
  recoveryCode: string | null;        // только register и recover
  signedOutDevices: number;           // recover: сколько устройств удалено; иначе 0
};
```
Пример видео, которого нет в каталоге YTM:
```json
{"videoId":"a1B2c3D4e5F","title":"Artist — Song (live 2014, fan upload)","artistsText":"Some Channel","artists":[{"id":"UCabcdefghijklmnopqrstuv","name":"Some Channel"}],"albumId":null,"albumTitle":null,"durationMs":254000,"durationText":"4:14","thumbnailUrl":"https://i.ytimg.com/vi/a1B2c3D4e5F/hqdefault.jpg","explicit":false,"videoType":"ugc","metadataStub":false}
```
Заглушка:
```json
{"videoId":"dQw4w9WgXcQ","title":"dQw4w9WgXcQ","artistsText":null,"artists":[],"albumId":null,"albumTitle":null,"durationMs":null,"durationText":null,"thumbnailUrl":null,"explicit":false,"videoType":null,"metadataStub":true}
```

### 4.2 Сервер
**`GET /health` → `HealthResponse`.** Если идёт останов или БД недоступна → `503 unavailable`.
```ts
type HealthResponse = { status: string /*ok*/; version: string; db: string /*sqlite|postgres*/ };
type LivenessResponse = { status: string /*ok*/ };
```
```json
{"status":"ok","version":"0.1.0","db":"postgres"}
```

**`GET /server/info` → `ServerInfo`**
```ts
type ServerInfo = {
  software: string;                   // всегда "melogold-server"
  version: string; revision: string;  // semver; git sha (7)
  apiVersion: number; minApiVersion: number;
  serverId: Uuid; instanceName: string; publicUrl: string | null;
  secureTransport: boolean;           // запрос пришёл по https (с учётом TRUST_PROXY)
  registration: string;               // open|closed ("first" отдаётся как open, пока нет пользователей)
  features: {
    sync?: { protocol: number; minProtocol: number; kinds: string[]; streams: string[] };
    playback?: { version: number };
    deviceLinking?: { version: number; modes: string[]; ttlSeconds: number; longPollSeconds: number };
    recoveryCode?: { version: number }; export?: { version: number }; accountDeletion?: { version: number };
    registrationPow?: { version: number };      // есть, если PoW сейчас требуется
  };
  limits: ServerLimits;               // §11
  links: { source: string /* …/tree/<GIT_SHA> */; privacy: string | null; contact: string | null };
  serverTime: Iso;
};
```
```json
{"software":"melogold-server","version":"0.1.0","revision":"3f9c2ab","apiVersion":1,"minApiVersion":1,
 "serverId":"6f1c2c0e-8a3b-4f7e-9c1d-2b5e7a9f0c11","instanceName":"Melogold","publicUrl":"https://api.melogold.app",
 "secureTransport":true,"registration":"open",
 "features":{"sync":{"protocol":1,"minProtocol":1,"kinds":["like.set","bookmark.set","playlist.create","playlist.update","playlist.delete","playlist.items.add","playlist.item.remove","playlist.item.move","playlist.items.replace","playlist.import","play.add","play.baseline","history.clear","history.forget"],"streams":["library","history"]},
  "playback":{"version":1},"deviceLinking":{"version":1,"modes":["request","invite"],"ttlSeconds":300,"longPollSeconds":25},
  "recoveryCode":{"version":1},"export":{"version":1},"accountDeletion":{"version":1},"registrationPow":{"version":1}},
 "limits":{"sync":{"maxOpsPerRequest":500,"maxBodyBytes":4194304,"maxWorkUnitsPerRequest":20000,"defaultPageSize":500,"maxPageSize":2000,"maxVideoIdsPerAdd":500,"maxVideoIdsPerList":10000,"maxBaselineEntries":500,"maxIncludeKeys":1000,"maxPlaylists":1000,"maxPlaylistItems":10000,"maxItemsTotal":100000,"maxLikes":100000,"maxBookmarksPerType":20000,"maxTracks":150000,"maxPlayStats":100000,"maxPlayEvents":60000,"playAddPerHour":2000},
  "history":{"retentionDays":400,"maxEvents":50000,"mergeUploadMax":20000},
  "playback":{"queueMax":200,"maxBodyBytes":131072},
  "account":{"maxDevices":20,"newDeviceRestrictHours":24,"login":{"minLength":3,"maxLength":32,"pattern":"^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$"},"password":{"minLength":8,"maxLength":128}}},
 "links":{"source":"https://github.com/melogold-app/melogoldServer/tree/3f9c2ab1d0e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8","privacy":"https://melogold.app/privacy","contact":null},
 "serverTime":"2026-09-23T10:00:00.000Z"}
```
Клиент не создаёт ops тех видов, которых нет в `features.sync.kinds`, и прячет соответствующий UI.

### 4.3 Регистрация, вход, сессии
**`GET /auth/register/challenge` → `RegisterChallenge`**
```ts
type RegisterChallenge = { challenge: string /*PowChallenge*/; bits: number; expiresAt: Iso };
```
```json
{"challenge":"mgpow1.eyJuIjoiUjNKdl8xLTJ0QSIsImIiOjE4LCJleHAiOjE3OTAxNTgyMDAwMDB9.kQ3v","bits":18,"expiresAt":"2026-09-23T10:10:00.000Z"}
```
- **Решение:** клиент перебирает `nonce` = "0", "1", …, пока `sha256(UTF-8(challenge + ":" + nonce))` не начнётся хотя бы с `bits` нулевых битов.
- Вызов одноразовый, TTL 10 мин.
- Векторы: `spec/pow.vectors.json`.

**`POST /auth/register` → 201 `AuthSession`** (`recoveryCode` не `null`)
```ts
type RegisterRequest = { login: string; password: string; device: DeviceInput; pow?: PowSolution };
type PowSolution = { challenge: string; nonce: string };
```
```json
{"login":"Maxim","password":"две собаки и кот","device":{"hwid":"3fa9c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1","name":"Google Pixel 8","platform":"android","osVersion":"16","model":"Google Pixel 8","clientVersion":"1.3.0"},"pow":{"challenge":"mgpow1.eyJu….kQ3v","nonce":"183422"}}
```
```json
{"user":{"id":"0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f","login":"maxim","createdAt":"2026-09-23T10:00:00.000Z","passwordChangedAt":"2026-09-23T10:00:00.000Z","recoveryCodeStatus":{"createdAt":"2026-09-23T10:00:00.000Z","confirmed":false},"securityCooldown":null},
 "device":{"id":"9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b","name":"Google Pixel 8","reportedName":"Google Pixel 8","customName":null,"platform":"android","osVersion":"16","model":"Google Pixel 8","clientVersion":"1.3.0","linkedVia":"register","linkedByDeviceId":null,"createdAt":"2026-09-23T10:00:00.000Z","lastSeenAt":"2026-09-23T10:00:00.000Z","lastSyncAt":null,"recentUntil":null,"isCurrent":true},
 "tokens":{"accessToken":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.c2ln","accessTokenExpiresAt":"2026-09-23T10:15:00.000Z","refreshToken":"mgrt1.eyJ0eXAiOiJyZWZyZXNoIn0.Xk3q","refreshTokenExpiresAt":"2026-12-22T10:00:00.000Z"},
 "serverId":"6f1c2c0e-8a3b-4f7e-9c1d-2b5e7a9f0c11","serverTime":"2026-09-23T10:00:00.000Z","recoveryCode":"7KQ2-MX9D-4TNP-B8RW-3HZF","signedOutDevices":0}
```
- **Ошибки:** 400 `invalid_login_format`, `password_*`, `invalid_request`; 403 `registration_closed`, `pow_required`, `pow_invalid`; 409 `login_taken`; 429; 503 `server_busy`, `storage_full`.
- **Порядок проверок:** режим → PoW → схема → логин → занятость → политика пароля → argon2 → транзакция (DESIGN §4.2).

**`POST /auth/login` → 200 `AuthSession`**
```ts
type LoginRequest = { login: string /*1..64*/; password: string; device: DeviceInput };
```
```json
{"login":"maxim","password":"две собаки и кот","device":{"hwid":"7c1e0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f","name":"DESKTOP-7Q2","platform":"windows","osVersion":"11 24H2","clientVersion":"0.4.0"}}
```
- **Ошибки:** 401 `invalid_credentials`; 429 `login_throttled`, `rate_limited`; 409 `device_limit_reached` (только после верного пароля); 503.
- **Уже известный `(user, hwid)`:** строка переиспользуется, её токены удаляются, лимит не проверяется.
- **Новое устройство** создаётся с `linked_via='login'`. Оно считается «новым» (`recentUntil`).

**`POST /auth/refresh` → 200 `RefreshResponse`**
```ts
type RefreshRequest = { refreshToken: string; device: DevicePatch };
type RefreshResponse = { tokens: TokenPair; device: DeviceDto; serverId: Uuid; serverTime: Iso };
```
```json
{"refreshToken":"mgrt1.eyJ0eXAiOiJyZWZyZXNoIn0.Xk3q","device":{"hwid":"3fa9c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1","clientVersion":"1.3.1"}}
```
Ошибки (все 401): `invalid_refresh_token`, `session_revoked`, `refresh_token_reused`, `device_mismatch`.

**`POST /auth/logout` → 204**
```ts
type LogoutRequest = { refreshToken: string };
```
- Отвечает **всегда 204**.
- Действует, только если токен текущий или находится в окне grace (DESIGN §4.5).
- Остальным устройствам уходит `devices.updated{device_signed_out}`.

**`GET /auth/me` → 200 `MeResponse`**
```ts
type MeResponse = { user: UserDto; device: DeviceDto; serverId: Uuid; serverTime: Iso };
```
```json
{"user":{"id":"0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f","login":"maxim","createdAt":"2026-09-23T10:00:00.000Z","passwordChangedAt":"2026-09-30T08:00:00.000Z","recoveryCodeStatus":{"createdAt":"2026-09-23T10:00:00.000Z","confirmed":false},"securityCooldown":{"until":"2026-10-07T08:00:00.000Z","startedAt":"2026-09-30T08:00:00.000Z","deviceId":"77b2c1d0-3e4f-4a5b-8c6d-7e8f9a0b1c2d","deviceName":"MacBook Air"}},"device":{"id":"9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b","name":"Google Pixel 8","reportedName":"Google Pixel 8","customName":null,"platform":"android","osVersion":"16","model":"Google Pixel 8","clientVersion":"1.3.0","linkedVia":"register","linkedByDeviceId":null,"createdAt":"2026-09-23T10:00:00.000Z","lastSeenAt":"2026-09-30T08:05:00.000Z","lastSyncAt":"2026-09-30T08:04:00.000Z","recentUntil":null,"isCurrent":true},"serverId":"6f1c2c0e-8a3b-4f7e-9c1d-2b5e7a9f0c11","serverTime":"2026-09-30T08:05:00.000Z"}
```
Если `securityCooldown ≠ null` и `deviceId` — не текущее устройство, клиент показывает плашку «Пароль изменён на „MacBook Air“ без старого пароля. Это не вы? → Отозвать».

### 4.4 Устройства
```ts
type DeviceListResponse = { devices: DeviceDto[]; maxDevices: number | null };  // текущее первым, остальные по lastSeenAt ↓
type RenameDeviceRequest = { name: string | null; password?: string };            // null → вернуть reportedName
type RevokeDeviceRequest = { password?: string };
type RevokeOthersRequest = { password?: string };
type RevokeOthersResponse = { revokedCount: number };
```
**`GET /auth/me/devices`:**
```json
{"devices":[{"id":"9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b","name":"Google Pixel 8","reportedName":"Google Pixel 8","customName":null,"platform":"android","osVersion":"16","model":"Google Pixel 8","clientVersion":"1.3.0","linkedVia":"register","linkedByDeviceId":null,"createdAt":"2026-09-23T10:00:00.000Z","lastSeenAt":"2026-09-23T10:05:00.000Z","lastSyncAt":"2026-09-23T10:04:00.000Z","recentUntil":null,"isCurrent":true}],"maxDevices":20}
```
**`PATCH /auth/me/devices/{id}`:** `{"name":"Рабочий ноутбук"}` → 200 `DeviceDto`.
- Ошибки: 404 `device_not_found`; 403 `recent_device_restricted`, `cooldown_restricted`, `invalid_password`; 429 `reauth_throttled`.

**`POST /auth/me/devices/{id}/revoke`:** `{}` или `{"password":"…"}` → 204.
- Ошибки: 409 `cannot_revoke_current_device`; 404; 403 `recent_device_restricted`, `cooldown_restricted`, `invalid_password`; 429.
- Порядок: commit → `session.invalidated{device_revoked}` адресно → `closeDevice` → `devices.updated{device_removed}`.

**`POST /auth/me/devices/revoke-others`:** `{}` → `{"revokedCount":3}`. Те же правила для каждой цели. При 403 ни одно устройство не удаляется.

Правила 403 — матрица DESIGN §4.8.

### 4.5 Аккаунт
```ts
type ChangePasswordRequest = { currentPassword?: string; newPassword: string; signOutOtherDevices?: boolean /*false*/ };
type ChangePasswordResponse = { user: UserDto; tokens: TokenPair; signedOutDevices: number };
type RotateRecoveryCodeRequest = { password: string };
type RecoveryCodeResponse = { recoveryCode: string; createdAt: Iso };
type ConfirmRecoveryCodeRequest = { recoveryCodeCreatedAt: Iso };
type DeleteAccountRequest = { password: string };
type RecoverRequest = { login: string; recoveryCode: string; newPassword: string; device: DeviceInput };
```
**`POST /auth/me/password`**
```json
{"currentPassword":"старый пароль","newPassword":"новый длинный пароль","signOutOtherDevices":true}
```
```json
{"user":{"id":"0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f","login":"maxim","createdAt":"2026-09-23T10:00:00.000Z","passwordChangedAt":"2026-09-24T08:00:00.000Z","recoveryCodeStatus":{"createdAt":"2026-09-23T10:00:00.000Z","confirmed":true},"securityCooldown":null},"tokens":{"accessToken":"eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.e30.c2ln","accessTokenExpiresAt":"2026-09-24T08:15:00.000Z","refreshToken":"mgrt1.eyJ0eXAiOiJyZWZyZXNoIn0.Qw9z","refreshTokenExpiresAt":"2026-12-23T08:00:00.000Z"},"signedOutDevices":2}
```
- Всегда `auth_version+1`, потоки пользователя закрываются.
- **Без `currentPassword`:**
  - нужен возраст устройства ≥ `PASSWORD_RESET_DEVICE_MIN_AGE_DAYS`;
  - устройство не должно было отзывать другие без пароля за последние 7 дней;
  - устройство не под ограничениями кулдауна, и нет кулдауна с живым инициатором.

  Тогда `signOutOtherDevices` принудительно `false`, запускается кулдаун, остальным уходит `account.updated{password_changed_without_old}`.
- **Ошибки:** 403 `current_password_required{minDeviceAgeDays}`, `cooldown_restricted`, `invalid_password`; 400 `password_*`; 429 `reauth_throttled`.

**`POST /auth/me/recovery-code`**
- Запрос: `{"password":"…"}`.
- Ответ: `{"recoveryCode":"N3W0-ABCD-EFGH-JKMN-PQRS","createdAt":"2026-09-24T08:00:00.000Z"}`.
- Ошибки: 403 `security_cooldown{retryAfterSeconds}`, `invalid_password`.
- Остальным устройствам уходит `account.updated{recovery_code_rotated}`.

**`POST /auth/me/recovery-code/confirm`**
- Запрос: `{"recoveryCodeCreatedAt":"2026-09-24T08:00:00.000Z"}` → 204.
- Ошибка: 409 `recovery_code_outdated`.

**`POST /auth/me/delete`**
- Запрос: `{"password":"…"}` → 204.
- Ошибки: 403 `security_cooldown`, `invalid_password`.
- Удаление логическое и немедленное: логин освобождается, устройства удаляются, данные чистит фоновая задача (DESIGN §4.11).

**`POST /auth/recover` → 200 `AuthSession`** (`recoveryCode` содержит новый код, `signedOutDevices` > 0)
```json
{"login":"maxim","recoveryCode":"7kq2 mx9d 4tnp b8rw 3hzf","newPassword":"новый длинный пароль","device":{"hwid":"3fa9c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1","name":"Google Pixel 8","platform":"android"}}
```
- Ошибки: 400 `password_*`; 401 `invalid_recovery_code`; 429; 503.
- Все прежние устройства удаляются, новое получает `linked_via='recovery'`, кулдаун снимается.
- Прежним устройствам уходит `session.invalidated{recovery_reset}`.

**`GET /auth/me/export` → 200 `ExportDocument`**
- Ответ потоковый, с заголовком `Content-Disposition: attachment; filename="melogold-export-<login>-<YYYY-MM-DD>.json"`.
- Это не атомарный снимок.
- Секретов не содержит.
```ts
type ExportDocument = {
  format: string /*melogold-export*/; formatVersion: number /*1*/; exportedAt: Iso;
  server: { serverId: Uuid; instanceName: string; version: string };
  account: { id: Uuid; login: string; createdAt: Iso; passwordChangedAt: Iso };
  devices: DeviceDto[];
  library: { tracks: TrackDto[]; likes: LikeRow[] /*liked*/; bookmarks: BookmarkRow[] /*bookmarked*/; playlists: ExportPlaylist[] /*живые*/ };
  history: { plays: PlayRow[] /*in_history*/; playStats: PlayStatRow[]; playForgets: PlayForgetRow[] };
  playback: PlaybackState | null;
};
type ExportPlaylist = { id: Uuid; name: string; browseId: string | null; thumbnailUrl: string | null; createdAt: Iso; items: ExportPlaylistItem[] };
type ExportPlaylistItem = { videoId: VideoId; addedAt: Iso };                  // ORDER BY sortKey, videoId (ordinal)
```
```json
{"format":"melogold-export","formatVersion":1,"exportedAt":"2026-09-23T10:00:00.000Z","server":{"serverId":"6f1c2c0e-8a3b-4f7e-9c1d-2b5e7a9f0c11","instanceName":"Melogold","version":"0.1.0"},"account":{"id":"0c3f6a2e-5d1b-4c7a-9e8f-1a2b3c4d5e6f","login":"maxim","createdAt":"2026-09-23T10:00:00.000Z","passwordChangedAt":"2026-09-23T10:00:00.000Z"},"devices":[],"library":{"tracks":[],"likes":[],"bookmarks":[],"playlists":[{"id":"b8e0d4c2-1a3b-4c5d-9e6f-7a8b9c0d1e2f","name":"Дорога","browseId":null,"thumbnailUrl":null,"createdAt":"2026-09-23T10:00:00.000Z","items":[{"videoId":"dQw4w9WgXcQ","addedAt":"2026-09-23T10:00:00.000Z"}]}]},"history":{"plays":[],"playStats":[],"playForgets":[]},"playback":null}
```

### 4.6 Привязка устройств (QR и код через сервер)
```ts
type CreateLinkRequestRequest = { device: DeviceInput };
type CreateLinkInviteRequest = {};                        // пустой объект
type LinkCreated = {
  linkId: Uuid; mode: string /*request|invite*/; serverId: Uuid;
  linkToken: string; userCode: string /*"K7QX-M2PD"*/;
  pollSecret: string | null;                              // только mode=request
  expiresAt: Iso; longPollSeconds: number;
};
type ResolveLinkRequest = { linkToken?: string; userCode?: string };                  // ровно одно
type ClaimLinkRequest   = { linkToken?: string; userCode?: string; device: DeviceInput };
type LinkDeviceInfo = { name: string; platform: string; osVersion: string | null; model: string | null;
                        clientVersion: string | null; alreadyLinked: boolean };        // «сообщает о себе»
type LinkDetails = {                                      // resolve и GET /auth/me/links/{id}
  linkId: Uuid; mode: string;
  status: string;                                         // pending|claimed|approved|denied|cancelled|completed|expired
  createdAt: Iso; expiresAt: Iso;
  device: LinkDeviceInfo | null;                          // null, пока invite не забран
  sameNetwork: boolean | null;                            // IPv4 целиком / IPv6 /56; null — неизвестно или LINK_NETWORK_HINT=false
  verifyChoices: string[];                                // 3 варианта VerifyCode при status=claimed, иначе []
};
type LinkAccount = { login: string };
type LinkApprover = { name: string; platform: string };
type LinkClaimed = { linkId: Uuid; status: string /*claimed*/; pollSecret: string; account: LinkAccount;
                     approverDevice: LinkApprover; verifyCode: string; expiresAt: Iso; longPollSeconds: number };
type PollLinkRequest = { pollSecret: string; waitSeconds?: number /*0..25, 25*/; knownStatus?: "pending" | "claimed" };
type LinkPollResponse = {
  linkId: Uuid; status: string;                           // pending|claimed|completed
  expiresAt: Iso;
  account: LinkAccount | null; approverDevice: LinkApprover | null;   // не null с момента claimed
  verifyCode: string | null;                              // не null с момента claimed: ПОКАЗАТЬ крупно
  session: AuthSession | null;                            // только при completed
};
type ApproveLinkRequest = { verifyCode: string };
type CancelLinkRequestRequest = { pollSecret: string };
type LinkDecisionResponse = { linkId: Uuid; status: string /*approved|denied*/ };
```

**Режим `request`** (QR показывает новое устройство):
1. Новое: `POST /auth/link/requests`
   ```json
   {"device":{"hwid":"7c1e0a9b8c7d6e5f4a3b2c1d0e9f8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d2e1f","name":"DESKTOP-7Q2","platform":"windows","osVersion":"11 24H2","clientVersion":"0.4.0"}}
   ```
   Ответ 201:
   ```json
   {"linkId":"5b0e7c1a-2d3e-4f5a-8b6c-7d8e9f0a1b2c","mode":"request","serverId":"6f1c2c0e-8a3b-4f7e-9c1d-2b5e7a9f0c11","linkToken":"q3JdV0hZxK2mP9sT4uW7yB1cE5fH8jL0nR3vX6zA2dG","userCode":"K7QX-M2PD","pollSecret":"mgps_Zr8aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5","expiresAt":"2026-09-23T10:05:00.000Z","longPollSeconds":25}
   ```
2. Вошедшее: `POST /auth/me/links/resolve` с `{"linkToken":"q3JdV0…"}` или `{"userCode":"k7qx m2pd"}` → `LinkDetails` со статусом `claimed` и `verifyChoices`.
   - Ошибки: 404 `link_not_found`; 410 `link_expired`; 409 `link_already_claimed`, `link_wrong_mode`.
3. Новое: `POST /auth/link/poll` с `{"pollSecret":"mgps_…","knownStatus":"pending"}` → `status: "claimed"`, `verifyCode: "47"`, `account`. Новое устройство крупно показывает «47».
4. Вошедшее: `POST /auth/me/links/{id}/approve` с `{"verifyCode":"47"}` → `{"linkId":"5b0e…","status":"approved"}`.
   - Неверное число → статус `denied` и `409 link_verify_mismatch`.
   - Одобрять можно только из `claimed` и только устройством `approver_device_id`, иначе `409 link_not_claimed`. Чужое устройство получает `404 link_not_found`.
   - Лимит устройств проверяется до одобрения: `409 device_limit_reached`.
5. Новое: poll с `knownStatus:"claimed"` → `completed` вместе с `session`.
   - В течение 60 с повтор того же poll снова выдаёт сессию.
   - Ошибки: 403 `link_denied`; 410 `link_expired`, `link_cancelled`; 409 `device_limit_reached`; 404.
   - Если текущий статус ≠ `knownStatus`, ответ приходит сразу, иначе ожидание до `waitSeconds`. Таймаут HTTP-клиента — 35 с.

**Режим `invite`** (QR показывает вошедшее устройство):
1. `POST /auth/me/links` с `{}` → 201 `LinkCreated`, `pollSecret: null`. Четвёртое активное приглашение отменяет самое старое.
2. Новое: `POST /auth/link/claim` → 200 `LinkClaimed`:
   ```json
   {"userCode":"K7QX-M2PD","device":{"hwid":"3fa9c1d2e4f5a6b7c8d9e0f1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6d7e8f9a0b1","name":"Google Pixel 8","platform":"android","osVersion":"16"}}
   ```
   ```json
   {"linkId":"a91c0b2d-3e4f-4a5b-8c6d-7e8f9a0b1c2d","status":"claimed","pollSecret":"mgps_Zr8aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ5","account":{"login":"maxim"},"approverDevice":{"name":"MacBook Air","platform":"macos"},"verifyCode":"47","expiresAt":"2026-09-23T10:05:00.000Z","longPollSeconds":25}
   ```
   Ошибки те же, что у resolve.
3. Создатель получает SSE `link.updated{status:"claimed"}`, затем `GET /auth/me/links/{id}` → `LinkDetails` с `verifyChoices:["12","47","85"]`. Затем approve с числом или deny. Без SSE — опрос раз в 3 с.
4. Новое: poll с `knownStatus:"claimed"`.

**Отмена:**
- новым устройством — `POST /auth/link/cancel {"pollSecret":"…"}` → 204;
- вошедшим — `POST /auth/me/links/{id}/cancel {}` → 204;
- deny — `POST /auth/me/links/{id}/deny {}` → `{"linkId":"…","status":"denied"}`.

**Прочее:**
- Статус `expired` вычисляется и в БД не пишется.
- При финальном статусе стираются `creator_net`, `other_net`, `claimant_*`.
- Устройство создаётся **только** при завершении привязки.
- Удаление одобряющего устройства переводит привязку в `cancelled`.

### 4.7 Синхронизация: сводка и план слияния
**`GET /sync/summary` → `SyncSummary`**
```ts
type SyncSummary = { cursor: Cursor; serverTime: Iso;
  counts: { likes: number; albums: number; artists: number; playlists: number; items: number; plays: number; playedTracks: number } };
```
```json
{"cursor":"a1b2c3d4.4815.4815","serverTime":"2026-09-23T10:00:00.000Z","counts":{"likes":1234,"albums":40,"artists":12,"playlists":15,"items":1830,"plays":8120,"playedTracks":2210}}
```

**`POST /sync/merge-plan` → `MergePlanResponse`** (чистая функция без записи)
```ts
type MergePlanRequest = { playlists: MergePlanInput[] /*0..5000*/ };
type MergePlanInput = { localKey: string /*1..64, уникален*/; syncId?: Uuid; name: string /*1..200*/; browseId?: string };
type MergePlanResponse = { plan: MergePlanEntry[] /*порядок как в запросе*/ };
type MergePlanEntry = { localKey: string; action: string /*merge|deleted|create*/; playlistId: Uuid; serverName: string | null };
```
**Правила** применяются проходами. Серверный плейлист можно занять только один раз. `norm(s) = s.normalize('NFKC').trim().replace(/\s+/g,' ').toLowerCase()`.
1. `syncId` живой и свободный → `merge`.
2. `syncId` удалён → `deleted`.
3. `browseId`: ровно один живой свободный серверный и ровно один такой локальный → `merge`.
4. Имя: то же правило по `norm(name)`.
5. Иначе `create`: `playlistId = syncId`, если серверу он неизвестен, иначе новый UUID.
```json
{"plan":[{"localKey":"17","action":"merge","playlistId":"0c11d2e3-f4a5-4b6c-8d7e-9f0a1b2c3d4e","serverName":"rock"},{"localKey":"18","action":"deleted","playlistId":"b8e0d4c2-1a3b-4c5d-9e6f-7a8b9c0d1e2f","serverName":null},{"localKey":"19","action":"create","playlistId":"5d2e6f7a-8b9c-4d0e-9f1a-2b3c4d5e6f7a","serverName":null}]}
```

### 4.8 `POST /sync`
```ts
type SyncRequest = {
  cursor: Cursor;                        // "" = оба потока с нуля
  limit?: number;                        // 1..2000, по умолчанию 500 (первая синхронизация — 2000)
  streams?: string[];                    // непустое подмножество ["library","history"], по умолчанию оба
  ops?: SyncOp[];                        // 0..500, без дублей opId
  include?: SyncInclude;                 // вернуть текущие строки этих ключей (всего ≤1000)
};
type SyncInclude = { likes?: VideoId[]; playlists?: Uuid[]; bookmarks?: BookmarkKey[]; playStats?: VideoId[] };
type BookmarkKey = { type: string /*album|artist*/; browseId: BrowseId };

type SyncOp = {                          // плоская схема; на маршруте проверяются только opId/kind/at/base (DESIGN §3.9)
  opId: Uuid; kind: string /*1..64*/; at: Iso; base?: string /*≤64*/;
  videoId?: string; videoIds?: string[]; after?: string; before?: string;
  liked?: boolean; likedAt?: Iso;
  type?: string; browseId?: string; bookmarked?: boolean; bookmarkedAt?: Iso;
  title?: string; subtitle?: string; thumbnailUrl?: string; year?: string;
  playlistId?: string; name?: string;
  playedAt?: Iso; playTimeMs?: number; history?: boolean; playtime?: boolean;
  mode?: string; entries?: BaselineEntry[];
  eventsBefore?: Iso; resetTotal?: boolean;
  tracks?: TrackInput[];                 // метаданные упомянутых videoId (мягкий разбор)
};
type BaselineEntry = { videoId: string; totalMs: number /*1..2^53−1*/ };

type OpResult = {
  opId: Uuid;
  status: string;                        // applied|superseded|redirected|rejected|deferred
  code: string | null;                   // §2.3
  seq: number | null;                    // отладка
  playlistId: Uuid | null;               // только redirected
  retryAfterSeconds: number | null;      // только op_rate_limited
  replayed: boolean;
};
type SyncResponse = {
  results: OpResult[];                   // в порядке ops
  cursor: Cursor; hasMore: boolean; serverTime: Iso;
  tracks: TrackDto[]; playlists: PlaylistRow[]; items: PlaylistItemRow[];
  likes: LikeRow[]; bookmarks: BookmarkRow[];
  plays: PlayRow[]; playStats: PlayStatRow[]; playForgets: PlayForgetRow[];
};
type PlaylistRow = { id: Uuid; name: string; browseId: string | null; thumbnailUrl: string | null; createdAt: Iso; deleted: boolean };
type PlaylistItemRow = { playlistId: Uuid; videoId: VideoId; present: boolean; sortKey: string; addedAt: Iso };
type LikeRow = { videoId: VideoId; liked: boolean; likedAt: Iso | null };
type BookmarkRow = { type: string; browseId: BrowseId; bookmarked: boolean; bookmarkedAt: Iso | null;
                     title: string | null; subtitle: string | null; thumbnailUrl: string | null; year: string | null };
type PlayRow = { eventId: Uuid; videoId: VideoId; playedAt: Iso; playTimeMs: number; deviceId: Uuid | null };
type PlayStatRow = { videoId: VideoId; totalPlayTimeMs: number; lastPlayedAt: Iso | null };
type PlayForgetRow = { videoId: string /*VideoId или "*"*/; eventsBefore: Iso /*включительно*/; totalBefore: Iso | null };
```

**Виды ops.** Семантика — DESIGN §3.7.

| kind | Обязательные поля | Необязательные | entityKey |
|---|---|---|---|
| `like.set` | `videoId`, `liked` | `likedAt`, `tracks` | `like:<videoId>` |
| `bookmark.set` | `type` (`album\|artist`), `browseId`, `bookmarked` | `bookmarkedAt`, `title`, `subtitle`, `thumbnailUrl`, `year` | `bm:<type>:<browseId>` |
| `playlist.create` | `playlistId`, `name` | `browseId`, `thumbnailUrl`, `videoIds` (0..10000), `tracks` | `pl:<playlistId>` |
| `playlist.update` | `playlistId`, `name` | `thumbnailUrl` (отсутствие означает `null`) | `pl:<playlistId>` |
| `playlist.delete` | `playlistId` | — | `pl:<playlistId>` |
| `playlist.items.add` | `playlistId`, `videoIds` (1..500) | `after`, `before`, `tracks` | `pl:<playlistId>` |
| `playlist.item.remove` | `playlistId`, `videoId` | — | `pl:<playlistId>` |
| `playlist.item.move` | `playlistId`, `videoId` | `after`, `before` | `pl:<playlistId>` |
| `playlist.items.replace` | `playlistId`, `videoIds` (0..10000) | `tracks` | `pl:<playlistId>` |
| `playlist.import` | `playlistId`, `name`, `videoIds` (0..10000) | `browseId`, `thumbnailUrl`, `tracks` | `pl:<playlistId>` |
| `play.add` | `videoId`, `playedAt`, `playTimeMs` (1..86400000), `history`, `playtime` (хотя бы один `true`). `opId` = eventId, `at` = `playedAt` | `tracks` | `stat:<videoId>` |
| `play.baseline` | `mode` (`add\|atLeast`), `entries` (1..500, уникальные `videoId`) | `tracks` | `stat:batch` |
| `history.clear` | `eventsBefore` | — | `hist:*` |
| `history.forget` | `videoId`, `eventsBefore`, `resetTotal` | — | `stat:<videoId>` |

**Мягкая нормализация полей op:**
- `name` обрезается до 200 символов, пустое значение превращается в «Без названия» или «Untitled».
- Для `title`, `subtitle`, `year`, `thumbnailUrl` у закладок и `thumbnailUrl` у плейлистов: обрезка, при неверном значении — `null`.
- `tracks[]` разбираются по DESIGN §3.9.

**Ошибки запроса целиком:** 400 `invalid_request`; 401; 409 `protocol_unsupported`; 410 `cursor_invalid`, `cursor_expired`; 413 (тело или бюджет); 429; 503 `server_busy`, `storage_full`.

**Пример запроса:**
```json
{"cursor":"a1b2c3d4.4800.4790","limit":500,"streams":["library","history"],
 "ops":[
  {"opId":"3f0c1d2e-4a5b-4c6d-8e7f-9a0b1c2d3e4f","kind":"like.set","at":"2026-09-23T10:00:00.123456Z","base":"a1b2c3d4.4800.4790","videoId":"a1B2c3D4e5F","liked":true,"tracks":[{"videoId":"a1B2c3D4e5F","title":"Artist — Song (live 2014, fan upload)","artistsText":"Some Channel","durationMs":254000,"videoType":"ugc"}]},
  {"opId":"7a21b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c","kind":"playlist.items.add","at":"2026-09-23T10:00:01.000Z","base":"a1b2c3d4.4800.4790","playlistId":"b8e0d4c2-1a3b-4c5d-9e6f-7a8b9c0d1e2f","videoIds":["abcdefghijk"],"after":"zyxwvutsrqp","tracks":[{"videoId":"abcdefghijk","title":""}]},
  {"opId":"b71e2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d","kind":"play.add","at":"2026-09-23T09:58:10.000Z","videoId":"a1B2c3D4e5F","playedAt":"2026-09-23T09:58:10.000Z","playTimeMs":212000,"history":true,"playtime":true},
  {"opId":"c9aa0b1c-2d3e-4f4a-8b5c-6d7e8f9a0b1c","kind":"history.forget","at":"2026-09-23T10:00:05.000Z","videoId":"abcdefghijk","eventsBefore":"2026-09-23T10:00:05.000Z","resetTotal":false}],
 "include":{"likes":["a1B2c3D4e5F"]}}
```
**Пример ответа** (у `abcdefghijk` пустой title, поэтому он стал заглушкой):
```json
{"results":[
  {"opId":"3f0c1d2e-4a5b-4c6d-8e7f-9a0b1c2d3e4f","status":"applied","code":null,"seq":4802,"playlistId":null,"retryAfterSeconds":null,"replayed":false},
  {"opId":"7a21b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c","status":"redirected","code":null,"seq":4805,"playlistId":"c9d1e2f3-a4b5-5c6d-8e7f-9a0b1c2d3e4f","retryAfterSeconds":null,"replayed":false},
  {"opId":"b71e2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d","status":"applied","code":null,"seq":4807,"playlistId":null,"retryAfterSeconds":null,"replayed":false},
  {"opId":"c9aa0b1c-2d3e-4f4a-8b5c-6d7e8f9a0b1c","status":"applied","code":null,"seq":4809,"playlistId":null,"retryAfterSeconds":null,"replayed":false}],
 "cursor":"a1b2c3d4.4809.4809","hasMore":false,"serverTime":"2026-09-23T10:00:01.004Z",
 "tracks":[{"videoId":"a1B2c3D4e5F","title":"Artist — Song (live 2014, fan upload)","artistsText":"Some Channel","artists":[],"albumId":null,"albumTitle":null,"durationMs":254000,"durationText":"4:14","thumbnailUrl":null,"explicit":false,"videoType":"ugc","metadataStub":false},
           {"videoId":"abcdefghijk","title":"abcdefghijk","artistsText":null,"artists":[],"albumId":null,"albumTitle":null,"durationMs":null,"durationText":null,"thumbnailUrl":null,"explicit":false,"videoType":null,"metadataStub":true}],
 "playlists":[{"id":"c9d1e2f3-a4b5-5c6d-8e7f-9a0b1c2d3e4f","name":"Дорога (восстановлено)","browseId":null,"thumbnailUrl":null,"createdAt":"2026-09-23T10:00:01.000Z","deleted":false}],
 "items":[{"playlistId":"c9d1e2f3-a4b5-5c6d-8e7f-9a0b1c2d3e4f","videoId":"abcdefghijk","present":true,"sortKey":"a0","addedAt":"2026-09-23T10:00:01.000Z"}],
 "likes":[{"videoId":"a1B2c3D4e5F","liked":true,"likedAt":"2026-09-23T10:00:00.123Z"}],
 "bookmarks":[],
 "plays":[{"eventId":"b71e2c3d-4e5f-4a6b-9c7d-8e9f0a1b2c3d","videoId":"a1B2c3D4e5F","playedAt":"2026-09-23T09:58:10.000Z","playTimeMs":212000,"deviceId":"9b1e2f4a-7c3d-4e5f-8a9b-0c1d2e3f4a5b"}],
 "playStats":[{"videoId":"a1B2c3D4e5F","totalPlayTimeMs":1484000,"lastPlayedAt":"2026-09-23T09:58:10.000Z"}],
 "playForgets":[{"videoId":"abcdefghijk","eventsBefore":"2026-09-23T10:00:05.000Z","totalBefore":null}]}
```
- Каждый ключ строки встречается один раз.
- Массивы упорядочены по внутреннему `seq`, `tracks` — по `videoId`.
- Порядок применения на клиенте: `tracks → playlists (по createdAt) → items → likes → bookmarks → playStats → plays → playForgets`.
- Если голова сдвинулась, после commit остальным устройствам уходит SSE `sync.changed`.

### 4.9 Playback
```ts
type PlaybackHandoff = { deviceId: Uuid; sessionId: Uuid; at: Iso };
type PlaybackHandoffInput = { deviceId: Uuid; sessionId: Uuid };
type PlaybackState = {
  rev: number;                           // max(prev.rev+1, serverNowMs); не убывает и после DELETE
  deviceId: Uuid; deviceName: string | null; sessionId: Uuid; queueVersion: number;
  index: number; positionMs: number; durationMs: number | null; playing: boolean;
  at: Iso /*effAt*/; updatedAt: Iso;
  queue: TrackDto[];                     // 1..200
  handoffFrom: PlaybackHandoff | null;
};
type PlaybackStateResponse = { state: PlaybackState | null; serverTime: Iso };
type PlaybackPut = {
  sessionId: Uuid; queueVersion: number /*Int32 ≥0*/; at: Iso;
  index: number /*0..len-1*/; positionMs: number /*Int53 ≥0*/; durationMs?: number; playing: boolean;
  queue?: TrackInput[];                  // 1..200; videoId каждого обязан быть верным (иначе 400)
  handoffFrom?: PlaybackHandoffInput;    // только при «Слушать здесь»
};
type PlaybackPutResult = {
  applied: boolean; rev: number | null;
  reason: string | null;                 // newer_state|handed_off при !applied
  state: PlaybackState | null;           // при !applied — текущее состояние сервера (с queue)
  serverTime: Iso;
};
```
**`PUT /playback/state`:**
```json
{"sessionId":"e2a1b3c4-d5e6-4f7a-8b9c-0d1e2f3a4b5c","queueVersion":3,"at":"2026-09-23T10:00:00.000Z","index":0,"positionMs":83000,"durationMs":213000,"playing":true,"queue":[{"videoId":"dQw4w9WgXcQ","title":"Never Gonna Give You Up","artistsText":"Rick Astley"}],"handoffFrom":{"deviceId":"77b2c1d0-3e4f-4a5b-8c6d-7e8f9a0b1c2d","sessionId":"41c0d1e2-f3a4-4b5c-8d6e-7f8a9b0c1d2e"}}
```
```json
{"applied":true,"rev":1790157600000,"reason":null,"state":null,"serverTime":"2026-09-23T10:00:00.140Z"}
```
- **Правила** — DESIGN §3.12.3:
  1. `handed_off`;
  2. `newer_state`;
  3. `409 playback_queue_required`;
  4. CAS, до 3 попыток, затем `503 server_busy`.
- **Ошибки:** `400` (`index` вне очереди, неверный элемент очереди), `413`, `503 storage_full`.
- **`GET`** → `{"state":null,"serverTime":"…"}` (нет состояния или очищено) либо полное состояние.
- **`DELETE`** → 204. Сервер ставит надгробие, затем SSE `playback.updated{cleared:true}`.

---

## 5. Состояния и переходы, на которые ссылается контракт
- **Лимит устройств** проверяется при создании новой строки `devices` (login с новым hwid, approve, завершение привязки) под `lockUser`. При переиспользовании hwid не проверяется.
- **Троттлинг:**
  - `auth_throttle(login)`: окно 15 мин, 5 неудач бесплатно, затем `min(30 с·2^(n−6), 15 мин)`;
  - `auth_throttle(reauth, userId)`: 5 неудач → 15 мин;
  - успешная попытка удаляет строку.
- **Удаление устройства** означает отзыв сессии. Каскадом удаляются токены, незавершённые привязки с этим одобряющим получают статус `cancelled`.
- **Фоновые задачи:**
  - `retention` ежедневно в `RETENTION_RUN_AT_UTC` (04:30) ±10 мин, пачками по 5000;
  - `auth-cleanup` ежечасно;
  - `account-purge` каждые 15 мин;
  - `sqlite-maintenance` (только SQLite) каждые 6 ч и ежедневно;
  - `disk-guard` раз в минуту.

  Задачи не публикуют SSE и не двигают `seq`.
- **Restore** всегда приводит к смене epoch всех пользователей до старта API (DESIGN §3.15).

---

## 6. SSE: `GET /auth/me/events`

**Транспорт:**
- заголовки: `Authorization: Bearer`; ответ `text/event-stream; charset=utf-8`, `Cache-Control: no-store, no-transform`, `X-Accel-Buffering: no`;
- первый кадр — `retry: 5000`, затем событие `system.connected`;
- кадр события: `id: <uuid>\ndata: <LiveEvent JSON>\n\n`, **без строки `event:`**;
- heartbeat — комментарий `: heartbeat <ms>` каждые `SSE_HEARTBEAT_SECONDS`.

**Реплея нет,** `Last-Event-ID` игнорируется. После (пере)подключения клиент делает `POST /sync` (если есть binding), `GET /playback/state` и перечитывает открытые экраны.

**Сервер закрывает поток:**
- при `exp` access-токена, которым поток открыт;
- после `session.invalidated` устройства и при удалении устройства;
- при росте `auth_version`;
- при пакетной проверке на heartbeat: устройство пропало → сначала `session.invalidated{device_revoked}`;
- при останове сервера.

**Лимиты:** не больше 4 потоков на устройство и 64 на пользователя, при превышении вытесняется самый старый.

**Клиент:**
- перед `exp` открывает новый поток с новым токеном и закрывает старый;
- после прочих закрытий сервером ждёт случайно 0–15 с, затем 1, 2, 5, 10, 30 с и далее до 5 мин с jitter.

**События публикуются только после commit.**

```ts
type LiveEvent = { id: Uuid; type: string; at: Iso; payload: object | null };
```

| type | Кому | Payload | Когда |
|---|---|---|---|
| `system.connected` | этому потоку | `SystemConnectedPayload {heartbeatMs, retryMs}` | открытие |
| `sync.changed` | все устройства пользователя, кроме автора | `SyncChangedPayload {cursor}` | после commit со сдвигом головы; склейка 2 с |
| `playback.updated` | все, кроме автора | `PlaybackUpdatedPayload {rev, cleared, state: PlaybackSummary \| null}` | значимое изменение или DELETE; не чаще 1/с |
| `devices.updated` | все устройства пользователя | `DevicesUpdatedPayload {reason, deviceId: Uuid \| null}`; reason: `device_added\|device_removed\|device_renamed\|device_signed_out` | создание, отзыв, rename, logout, token reuse |
| `session.invalidated` | адресно | `SessionInvalidatedPayload {reason, forceRelogin: true}`; reason: `device_revoked\|password_changed\|recovery_reset\|token_reuse\|account_deleted` | до закрытия потоков |
| `account.updated` | все, кроме автора | `AccountUpdatedPayload {reason, byDevice: {id, name}}`; reason: `password_changed\|password_changed_without_old\|recovery_code_rotated` | действия безопасности |
| `link.updated` | устройство-одобряющее | `LinkUpdatedPayload {linkId, status}`; status: `claimed\|cancelled\|completed` | действие другой стороны |

```ts
type PlaybackSummary = {
  rev: number; deviceId: Uuid; deviceName: string | null; sessionId: Uuid; queueVersion: number;
  index: number; queueLength: number; track: TrackDto | null;
  positionMs: number; durationMs: number | null; playing: boolean; at: Iso; updatedAt: Iso;
  handoffFrom: PlaybackHandoff | null;
};
```
```text
retry: 5000

id: 1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b
data: {"id":"1f2e3d4c-5b6a-4978-8a7b-6c5d4e3f2a1b","type":"account.updated","at":"2026-09-30T08:00:00.200Z","payload":{"reason":"password_changed_without_old","byDevice":{"id":"77b2c1d0-3e4f-4a5b-8c6d-7e8f9a0b1c2d","name":"MacBook Air"}}}

: heartbeat 1790157625000
```
- **Автопауза:** устройство A ставит паузу, если `handoffFrom.deviceId == A`, `handoffFrom.sessionId` — текущая сессия A и `serverNow − handoffFrom.at < 5 мин`.
- **OpenAPI:** маршрут описан ответом `text/event-stream` со схемой `LiveEvent`. Все `*Payload` и `PlaybackSummary` зарегистрированы в `components.schemas`, их наличие проверяет CI.

---

## 7. Discovery, QR и deep links

### 7.1 Проверка адреса сервера (одинаково во всех клиентах)
1. **Нормализация:**
   - trim;
   - без схемы → `https://`;
   - схема и хост в lowercase;
   - убрать `/` в конце;
   - userinfo, query или fragment → ошибка;
   - префикс пути сохраняется.
2. **Транспорт:**
   - `https` разрешён на любой хост;
   - `http` разрешён, только если хост — IP из `10/8`, `172.16/12`, `192.168/16`, `169.254/16`, `127/8`, `100.64/10`, `fc00::/7`, `fe80::/10`, `::1`, либо имя `*.local`, `*.lan`, `*.home.arpa`, `*.internal` или одно слово;
   - проверка повторяется **после DNS-резолва**: все адреса должны быть приватными;
   - при HTTP постоянно виден бейдж «Незащищённое соединение».
   - Платформенные особенности:
     - Android 17 при targetSdk 37: до подключения запросить `ACCESS_LOCAL_NETWORK`;
     - macOS: `NSAllowsLocalNetworking` плюс `NSLocalNetworkUsageDescription`, диапазон `100.64/10` только по HTTPS;
     - Windows MSIX: capability `privateNetworkClientServer`.
3. **`GET {base}/server/info`**, таймаут 10 с. Требуется 200 и `software == "melogold-server"`.
4. **Совместимость:**
   - API: `minApiVersion ≤ A_max && apiVersion ≥ A_min`;
   - протокол синхронизации: `minProtocol ≤ P ≤ protocol`;
   - `P < minProtocol` → обновить клиент, `P > protocol` → «обновите сервер».
5. **Показать** `instanceName`, host, `version`, `registration`, `secureTransport`.
   - Значок «Официальный» — только если origin == `https://api.melogold.app` **и** `serverId == OFFICIAL_SERVER_ID` (константа сборки).
   - Иначе показать «Сторонний сервер — его владелец видит вашу библиотеку».
6. **`binding = serverId + ":" + userId`.** Тот же `serverId` по другому адресу меняет только base URL. Если `publicUrl ≠ base` и он https, предложить переключиться.
7. **Повторная проверка** — при входе, раз в сутки и после `409 protocol_unsupported`.

### 7.2 Форматы QR и ссылок

| Назначение | Формат | Кто генерирует |
|---|---|---|
| Привязка устройства | `melogold://link?v=1&mode=<request\|invite>&server=<base, percent-encoded>&sid=<serverId>&token=<linkToken>` | клиент, показывающий QR |
| Адрес сервера (deep link) | `melogold://server?v=1&url=<base, percent-encoded>&sid=<serverId>` | кнопка на `GET /` |
| Адрес сервера (QR) | сам base URL (`https://music.example.com`, `http://192.168.1.50:8080`) | `melogold qr`, итог установщика |

- **Кодирование:** percent-encoding RFC 3986 (`encodeURIComponent`). Порядок параметров любой, неизвестные игнорируются.
- **QR:** коррекция уровня M, не больше 200 символов.
- **Сканер** есть только на экранах «Добавить устройство», «Войти с другого устройства» и «Свой сервер». Разбор:
  1. **`melogold://link`.** Проверки: `v==1`, `server` по §7.1 п. 1–2, `sid` — Uuid, `token` — LinkToken. Дальше:
     - `request`, сканер вошёл и его `serverId == sid` → `resolveLink{linkToken}` → карточка со сверкой числа;
     - `request`, другой `sid` → «Устройство подключается к `<host>`», запроса к серверу нет;
     - `request`, сканер не вошёл → «Сначала войдите»;
     - `invite`, сканер не вошёл → подтверждение сервера (§7.1 п. 3–5) → проверка `sid` → `claimLink{linkToken, device}`, где hwid посчитан с этим `sid`;
     - `invite`, сканер уже вошёл → «Сначала выйдите».
  2. **`melogold://server` или `http(s)` URL** — кандидат адреса сервера. Если есть `sid`, он должен совпасть.
  3. **Прочее** — «Это не код Melogold».
- **Deep link из ОС (M1).** Схема `melogold` регистрируется так:
  - Android: intent-filter `scheme=melogold`, hosts `server` и `link`;
  - macOS: `CFBundleURLSchemes`;
  - Windows: `HKCU\Software\Classes\melogold`;
  - Linux: `.desktop` с `MimeType=x-scheme-handler/melogold;`.

  Обработчик:
  - `server` → экран «Свой сервер» с заполненным адресом и подтверждением;
  - `link?mode=invite` → экран «Войти с другого устройства» с заполненным сервером и **явной кнопкой** «Подключиться», без автоматического claim;
  - `link?mode=request` **не выполняется** — показывается инструкция «Откройте Melogold → Добавить устройство → Сканировать».

  Автоматического входа или одобрения не бывает никогда.
- **Ввод без камеры:**
  - `request`: вошедшее устройство вводит `userCode` → `resolveLink{userCode}`;
  - `invite`: новое устройство вводит адрес и `userCode` → §7.1 → `claimLink{userCode}`.
- **Экран с QR** всегда показывает `userCode` (`XXXX-XXXX`), host и таймер. Экран нового устройства после claim показывает **крупно** `verifyCode`.
- **Файл кода восстановления** (десктоп): `melogold-recovery-<login>.txt` — сервер, логин, код, дата.

---

## 8. Сквозные константы протокола
- `NS_MELOGOLD_RECOVERY = cf3e0fee-fe4e-42a1-b392-e5ffb8933b87` (uuidv5 плейлиста восстановления). Не меняется.
- **Ключи порядка:** fractional indexing, алфавит `0-9A-Za-z` (base62), сравнение ordinal. Выдаёт только сервер. Ключ длиннее 48 символов → ребалансировка плейлиста.
- **Префиксы токенов:** refresh `mgrt1.`, poll `mgps_`, PoW `mgpow1.`.
- **HKDF `info`:** `melogold/jwt-access/v1`, `melogold/refresh-token/v1`, `melogold/pow/v1`.
- **Хеш кода восстановления:** `sha256("melogold-recovery-v1:" + code)`.
- **hwid:** префикс `melogold-hwid-v1|`.

---

## 9. Схема БД (один код: SQLite по умолчанию и PostgreSQL)

### 9.1 Логические типы и рендер

| Макрос | PostgreSQL | SQLite (таблица `STRICT`) | TS |
|---|---|---|---|
| `ID` | `text COLLATE "C"` | `TEXT` (BINARY) | string: UUID, videoId, browseId, хеши, логин, ключи порядка |
| `TXT` | `text` | `TEXT` | string (человеческий текст, перечисления) |
| `INT` | `integer` | `INTEGER` | number ≤ 2³¹−1 (zod `.max`) |
| `BIG` | `bigint` | `INTEGER` | number ≤ 2^53−1 |
| `TS` | `bigint` | `INTEGER` | epoch-мс UTC |
| `BOOL` | `integer CHECK (<col> IN (0,1))` | `INTEGER CHECK (<col> IN (0,1))` | `0 \| 1` |
| `JSON` | `text` | `TEXT` | `jsonCodec(zod)`; SQL внутрь не заглядывает |

**Правила рендера (реализованы в `src/db/ddl.ts`):**
1. Типы колонок берутся только из таблицы выше. В миграциях литеральных типов нет (lint).
2. Каждая таблица SQLite заканчивается `STRICT`.
3. `COLLATE "C"` только в PG и только у `ID`. **Все** колонки, которые сравниваются друг с другом или участвуют в FK, имеют тип `ID`.
4. Все PK-колонки явно `NOT NULL`.
5. `CHECK` только с `length()`, `BETWEEN`, сравнениями и `IN (0,1)` для `BOOL`. Проверка по списку перечисления в БД запрещена.
6. `DEFAULT` — только константы. Время, UUID и `epoch` генерирует TS.
7. Нет триггеров, функций, `serial`, `jsonb`, массивов.
8. SQLite для новой базы до первой таблицы: `PRAGMA auto_vacuum=INCREMENTAL`.
9. `npm run schema:sql` генерирует `docs/schema.sqlite.sql` и `docs/schema.postgres.sql`, CI проверяет, что они закоммичены.

### 9.2 DDL (миграции `src/db/migrations/NNNN_*.ts`, только расширяющие; заморожены с первого деплоя в живую БД)
```sql
-- ===== 0001_core ==========================================================
CREATE TABLE server_meta (
  key   ID  NOT NULL PRIMARY KEY,    -- server_id | created_at | first_user_id | restore_pending | restore_refresh_grace_until
  value TXT NOT NULL
);
CREATE TABLE users (
  id                           ID   NOT NULL PRIMARY KEY,
  login                        ID   NOT NULL UNIQUE CHECK (length(login) BETWEEN 3 AND 64),  -- нормализован; удалённый: '!deleted:'||id
  password_hash                TXT  NOT NULL,                                               -- PHC argon2id
  auth_version                 INT  NOT NULL DEFAULT 1,
  password_changed_at          TS   NOT NULL,
  security_cooldown_until      TS   NULL,
  security_cooldown_started_at TS   NULL,
  security_cooldown_device_id  ID   NULL,                                                   -- без FK
  recovery_code_hash           ID   NOT NULL CHECK (length(recovery_code_hash) = 64),
  recovery_code_created_at     TS   NOT NULL,
  recovery_code_confirmed_at   TS   NULL,
  created_by                   TXT  NOT NULL DEFAULT 'self',                                -- self|admin
  deleted_at                   TS   NULL,
  created_at                   TS   NOT NULL,
  updated_at                   TS   NOT NULL
);
CREATE INDEX users_deleted ON users (deleted_at) WHERE deleted_at IS NOT NULL;
CREATE TABLE devices (
  id                          ID  NOT NULL PRIMARY KEY,
  user_id                     ID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  hwid_hash                   ID  NOT NULL CHECK (length(hwid_hash) = 64),
  reported_name               TXT NOT NULL CHECK (length(reported_name) BETWEEN 1 AND 64),
  custom_name                 TXT NULL CHECK (custom_name IS NULL OR length(custom_name) BETWEEN 1 AND 64),
  platform                    TXT NOT NULL CHECK (length(platform) BETWEEN 1 AND 16),
  os_version                  TXT NULL,
  model                       TXT NULL,
  client_version              TXT NULL,
  linked_via                  TXT NOT NULL,                                                 -- register|login|link|recovery
  linked_by_device_id         ID  NULL,                                                     -- без FK
  revoked_without_password_at TS  NULL,
  created_at                  TS  NOT NULL,
  last_seen_at                TS  NOT NULL,
  last_sync_at                TS  NULL,
  UNIQUE (user_id, hwid_hash)
);
CREATE INDEX devices_last_seen ON devices (last_seen_at);
CREATE TABLE refresh_tokens (
  id                        ID NOT NULL PRIMARY KEY,                                        -- = tid
  user_id                   ID NOT NULL REFERENCES users(id)   ON DELETE CASCADE,
  device_id                 ID NOT NULL REFERENCES devices(id) ON DELETE CASCADE,
  token_hash                ID NOT NULL UNIQUE,                                             -- sha256(токен)
  expires_at                TS NOT NULL,
  rotated_to_id             ID NULL,
  rotation_grace_expires_at TS NULL,
  revoked_at                TS NULL,
  confirmed_at              TS NULL,                                                        -- первое использование access с rid=id
  created_at                TS NOT NULL
);
CREATE INDEX refresh_tokens_user    ON refresh_tokens (user_id);
CREATE INDEX refresh_tokens_device  ON refresh_tokens (device_id);
CREATE INDEX refresh_tokens_expires ON refresh_tokens (expires_at);
CREATE TABLE auth_throttle (
  scope        ID  NOT NULL,                                                                -- login|reauth
  key_hash     ID  NOT NULL,                                                                -- sha256(scope+":"+key)
  failures     INT NOT NULL DEFAULT 0,
  window_start TS  NOT NULL,
  locked_until TS  NULL,
  updated_at   TS  NOT NULL,
  PRIMARY KEY (scope, key_hash)
);

-- ===== 0002_linking =======================================================
CREATE TABLE device_links (
  id                      ID  NOT NULL PRIMARY KEY,
  mode                    TXT NOT NULL,                                                     -- request|invite
  status                  TXT NOT NULL,                                                     -- pending|claimed|approved|denied|cancelled|completed
  token_hash              ID  NOT NULL UNIQUE,
  code_hash               ID  NOT NULL UNIQUE,
  poll_secret_hash        ID  NULL UNIQUE,
  user_id                 ID  NULL REFERENCES users(id)   ON DELETE CASCADE,
  approver_device_id      ID  NULL REFERENCES devices(id) ON DELETE SET NULL,
  claimant_hwid_hash      ID  NULL,
  claimant_name           TXT NULL,
  claimant_platform       TXT NULL,
  claimant_os_version     TXT NULL,
  claimant_model          TXT NULL,
  claimant_client_version TXT NULL,
  verify_code             TXT NULL CHECK (verify_code IS NULL OR length(verify_code) = 2),
  deny_reason             TXT NULL,                                                         -- user|verify_mismatch
  creator_net             TXT NULL,                                                         -- IPv4 или IPv6/56; стирается в финальном статусе
  other_net               TXT NULL,
  result_device_id        ID  NULL,                                                         -- без FK
  result_refresh_id       ID  NULL,                                                         -- без FK; повторный poll (60 с)
  created_at              TS  NOT NULL,
  expires_at              TS  NOT NULL,
  claimed_at              TS  NULL,
  decided_at              TS  NULL,
  completed_at            TS  NULL
);
CREATE INDEX device_links_expires  ON device_links (expires_at);
CREATE INDEX device_links_user     ON device_links (user_id);
CREATE INDEX device_links_approver ON device_links (approver_device_id);
CREATE INDEX device_links_net      ON device_links (creator_net) WHERE creator_net IS NOT NULL;

-- ===== 0003_sync ==========================================================
CREATE TABLE sync_heads (
  user_id    ID  NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  epoch      ID  NOT NULL CHECK (length(epoch) = 8),
  seq        BIG NOT NULL DEFAULT 0,
  floor_seq  BIG NOT NULL DEFAULT 0,                                                        -- в MVP всегда 0
  updated_at TS  NOT NULL
);
CREATE TABLE sync_ops (
  user_id     ID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  seq         BIG  NOT NULL,
  op_id       ID   NOT NULL,
  device_id   ID   NULL,
  device_name TXT  NULL,
  kind        TXT  NOT NULL CHECK (length(kind) BETWEEN 1 AND 64),
  payload     JSON NOT NULL,                                                                -- без tracks
  status      TXT  NOT NULL,                                                                -- applied|superseded|redirected|rejected
  code        TXT  NULL,
  result      JSON NULL,
  client_at   TS   NOT NULL,
  eff_at      TS   NOT NULL,
  base_seq    BIG  NULL,
  pre_image   JSON NULL,
  server_at   TS   NOT NULL,
  PRIMARY KEY (user_id, seq)
);
CREATE UNIQUE INDEX sync_ops_op        ON sync_ops (user_id, op_id);
CREATE INDEX        sync_ops_server_at ON sync_ops (server_at);
CREATE TABLE sync_tracks (
  user_id       ID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id      ID   NOT NULL CHECK (length(video_id) = 11),
  title         TXT  NOT NULL,
  artists_text  TXT  NULL,
  artists       JSON NULL,
  album_id      ID   NULL,
  album_title   TXT  NULL,
  duration_ms   BIG  NULL,
  duration_text TXT  NULL,
  thumbnail_url TXT  NULL,
  explicit      BOOL NOT NULL DEFAULT 0,
  video_type    TXT  NULL,
  stub          BOOL NOT NULL DEFAULT 0,
  seq           BIG  NOT NULL,
  updated_at    TS   NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX sync_tracks_pull ON sync_tracks (user_id, seq);
CREATE TABLE sync_likes (
  user_id  ID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id ID   NOT NULL CHECK (length(video_id) = 11),
  liked    BOOL NOT NULL,
  liked_at TS   NULL,
  seq      BIG  NOT NULL,
  clk_at   TS   NOT NULL,
  clk_dev  ID   NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX sync_likes_pull ON sync_likes (user_id, seq);
CREATE TABLE sync_bookmarks (
  user_id       ID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          ID   NOT NULL CHECK (length(type) BETWEEN 1 AND 16),                         -- album|artist
  browse_id     ID   NOT NULL CHECK (length(browse_id) BETWEEN 1 AND 64),
  bookmarked    BOOL NOT NULL,
  bookmarked_at TS   NULL,
  title         TXT  NULL,
  subtitle      TXT  NULL,
  thumbnail_url TXT  NULL,
  year          TXT  NULL,
  seq           BIG  NOT NULL,
  clk_at        TS   NOT NULL,
  clk_dev       ID   NULL,
  PRIMARY KEY (user_id, type, browse_id)
);
CREATE INDEX sync_bookmarks_pull ON sync_bookmarks (user_id, seq);
CREATE TABLE sync_playlists (
  user_id       ID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  id            ID   NOT NULL,
  name          TXT  NOT NULL CHECK (length(name) BETWEEN 1 AND 200),
  browse_id     ID   NULL,
  thumbnail_url TXT  NULL,
  created_at    TS   NOT NULL,
  deleted       BOOL NOT NULL DEFAULT 0,
  deleted_at    TS   NULL,
  deleted_seq   BIG  NULL,
  item_count    INT  NOT NULL DEFAULT 0,                                                    -- present-элементы; квота; seq не двигает
  seq           BIG  NOT NULL,
  clk_at        TS   NOT NULL,
  clk_dev       ID   NULL,
  PRIMARY KEY (user_id, id)
);
CREATE INDEX sync_playlists_pull        ON sync_playlists (user_id, seq);
CREATE INDEX sync_playlists_live_browse ON sync_playlists (user_id, browse_id) WHERE deleted = 0 AND browse_id IS NOT NULL;
CREATE TABLE sync_playlist_items (
  user_id     ID   NOT NULL,
  playlist_id ID   NOT NULL,
  video_id    ID   NOT NULL CHECK (length(video_id) = 11),
  present     BOOL NOT NULL,
  sort_key    ID   NOT NULL CHECK (length(sort_key) BETWEEN 1 AND 64),
  added_at    TS   NOT NULL,
  seq         BIG  NOT NULL,                                                                -- = max(mem_seq, pos_seq)
  mem_seq     BIG  NOT NULL, mem_at TS NOT NULL, mem_dev ID NULL,
  pos_seq     BIG  NOT NULL, pos_at TS NOT NULL, pos_dev ID NULL,
  PRIMARY KEY (user_id, playlist_id, video_id),
  FOREIGN KEY (user_id, playlist_id) REFERENCES sync_playlists (user_id, id) ON DELETE CASCADE
);
CREATE INDEX sync_items_pull  ON sync_playlist_items (user_id, seq);
CREATE INDEX sync_items_order ON sync_playlist_items (user_id, playlist_id, sort_key, video_id) WHERE present = 1;

-- ===== 0004_playback ======================================================
CREATE TABLE playback_state (
  user_id            ID   NOT NULL PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  rev                BIG  NOT NULL,
  cleared            BOOL NOT NULL DEFAULT 0,                                               -- надгробие DELETE
  device_id          ID   NOT NULL,                                                         -- без FK
  device_name        TXT  NULL,
  session_id         ID   NOT NULL,
  queue_version      BIG  NOT NULL CHECK (queue_version >= 0),
  queue              JSON NOT NULL,                                                         -- [TrackDto] ≤200; '[]' при cleared
  idx                INT  NOT NULL CHECK (idx >= 0),
  position_ms        BIG  NOT NULL CHECK (position_ms >= 0),
  duration_ms        BIG  NULL,
  playing            BOOL NOT NULL,
  state_at           TS   NOT NULL,
  updated_at         TS   NOT NULL,
  handoff_device_id  ID   NULL,
  handoff_session_id ID   NULL,
  handoff_at         TS   NULL
);
CREATE INDEX playback_state_updated ON playback_state (updated_at);

-- ===== 0005_history =======================================================
CREATE TABLE play_events (
  user_id         ID   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  event_id        ID   NOT NULL,
  video_id        ID   NOT NULL CHECK (length(video_id) = 11),
  played_at       TS   NOT NULL,
  play_time_ms    INT  NOT NULL CHECK (play_time_ms BETWEEN 1 AND 86400000),
  in_history      BOOL NOT NULL,
  counts_playtime BOOL NOT NULL,
  device_id       ID   NULL,
  seq             BIG  NULL,                                                                -- только при in_history = 1
  received_at     TS   NOT NULL,
  PRIMARY KEY (user_id, event_id)
);
CREATE INDEX play_events_pull  ON play_events (user_id, seq) WHERE seq IS NOT NULL;
CREATE INDEX play_events_video ON play_events (user_id, video_id, played_at);
CREATE INDEX play_events_time  ON play_events (user_id, played_at);
CREATE INDEX play_events_recv  ON play_events (user_id, received_at);                     -- лимит play.add в час
CREATE INDEX play_events_idem  ON play_events (received_at) WHERE in_history = 0;
CREATE TABLE play_stats (
  user_id        ID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id       ID  NOT NULL CHECK (length(video_id) = 11),
  total_ms       BIG NOT NULL DEFAULT 0,
  last_played_at TS  NULL,
  seq            BIG NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX play_stats_pull ON play_stats (user_id, seq);
CREATE TABLE play_forgets (
  user_id       ID  NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id      ID  NOT NULL CHECK (video_id = '*' OR length(video_id) = 11),
  events_before TS  NOT NULL,
  total_before  TS  NULL,
  seq           BIG NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX play_forgets_pull ON play_forgets (user_id, seq);
-- Kysely сам создаёт kysely_migration и kysely_migration_lock.
```

### 9.3 Пример одной таблицы в обоих диалектах
```sql
-- PostgreSQL
CREATE TABLE sync_playlist_items (
  user_id text COLLATE "C" NOT NULL, playlist_id text COLLATE "C" NOT NULL,
  video_id text COLLATE "C" NOT NULL CHECK (length(video_id) = 11),
  present integer NOT NULL CHECK (present IN (0,1)),
  sort_key text COLLATE "C" NOT NULL CHECK (length(sort_key) BETWEEN 1 AND 64),
  added_at bigint NOT NULL, seq bigint NOT NULL,
  mem_seq bigint NOT NULL, mem_at bigint NOT NULL, mem_dev text COLLATE "C" NULL,
  pos_seq bigint NOT NULL, pos_at bigint NOT NULL, pos_dev text COLLATE "C" NULL,
  PRIMARY KEY (user_id, playlist_id, video_id),
  FOREIGN KEY (user_id, playlist_id) REFERENCES sync_playlists (user_id, id) ON DELETE CASCADE);
-- SQLite
CREATE TABLE sync_playlist_items (
  user_id TEXT NOT NULL, playlist_id TEXT NOT NULL,
  video_id TEXT NOT NULL CHECK (length(video_id) = 11),
  present INTEGER NOT NULL CHECK (present IN (0,1)),
  sort_key TEXT NOT NULL CHECK (length(sort_key) BETWEEN 1 AND 64),
  added_at INTEGER NOT NULL, seq INTEGER NOT NULL,
  mem_seq INTEGER NOT NULL, mem_at INTEGER NOT NULL, mem_dev TEXT NULL,
  pos_seq INTEGER NOT NULL, pos_at INTEGER NOT NULL, pos_dev TEXT NULL,
  PRIMARY KEY (user_id, playlist_id, video_id),
  FOREIGN KEY (user_id, playlist_id) REFERENCES sync_playlists (user_id, id) ON DELETE CASCADE) STRICT;
```

### 9.4 Различия диалектов во время выполнения (только `src/db/**`)

| Место | PostgreSQL | SQLite |
|---|---|---|
| Соединение | `pg.Pool({max: DATABASE_POOL_MAX, statement_timeout, ssl, application_name: "melogold"})`; `pg.types.setTypeParser(20, safeInt)` (при переполнении бросается ошибка) | одно соединение; PRAGMA `journal_mode=WAL`, `synchronous=${SQLITE_SYNCHRONOUS}`, `foreign_keys=ON`, `busy_timeout=${SQLITE_BUSY_TIMEOUT_MS}`, `temp_store=MEMORY`, `cache_size=-16000`, `journal_size_limit=67108864`; `optimize=0x10002` при открытии и раз в 6 ч |
| `db.write` | `READ COMMITTED` | `BEGIN IMMEDIATE` |
| `db.read` | `REPEATABLE READ READ ONLY` | `BEGIN` (снимок WAL); access mode `read only` выставляется всегда |
| `.forUpdate()` | как есть | вырезается `StripRowLocksPlugin` |
| Миграции | advisory lock Kysely, одна транзакция | `supportsTransactionalDdl=true` (переопределение), одна транзакция |
| Ошибка ограничения внутри транзакции | транзакция обрывается (`25P02`) | транзакция продолжается |

Правило для обоих диалектов: ошибки ограничений не ловятся внутри транзакции, используются `ON CONFLICT` или savepoint.

### 9.5 Мьютекс пользователя
```ts
lockUser(q, userId):   // первый оператор каждой сериализуемой записи пользователя
  SELECT * FROM sync_heads WHERE user_id = ? FOR UPDATE;   // SQLite: FOR UPDATE вырезан, эксклюзивность даёт BEGIN IMMEDIATE
  // нет строки → ROLLBACK, ensureHead (короткая write-tx: INSERT … ON CONFLICT (user_id) DO NOTHING), повтор
```
**Кто вызывает `lockUser`:**
- `/sync` с ops;
- создание устройства (login с новым hwid, завершение привязки);
- смена пароля, recover, revoke-others;
- удаление аккаунта.

Через `FOR UPDATE` никогда не блокируются `users`. Refresh работает через CAS по строке токена, playback — через CAS по `rev`.

---

## 10. Переменные окружения сервера
Их разбирает чистая функция `parseEnv` (zod). `process.env` читается только в `src/config/env.ts`. Личных значений по умолчанию нет.

| Переменная | По умолчанию | Смысл и проверка |
|---|---|---|
| `NODE_ENV` | `production` в образе | `development\|test\|production` |
| `HOST` / `PORT` | `0.0.0.0` в образе, `127.0.0.1` в dev / `8080` | адрес прослушивания |
| `PUBLIC_URL` | пусто | абсолютный http(s) без `/` в конце. Идёт в `/server/info.publicUrl`, на страницу `/` и в `melogold qr` |
| `INSTANCE_NAME` | `Melogold` | 1..64 |
| `SOURCE_URL` | `https://github.com/melogold-app/melogoldServer/tree/{rev}` | `{rev}` заменяется на `GIT_SHA`. Операторы изменённой версии обязаны указать свой репозиторий (AGPL §13) |
| `PRIVACY_URL`, `CONTACT` | пусто | → `links.privacy`, `links.contact` |
| `DATA_DIR` | `/data` | SQLite, `secret.key`, `.tmp/` |
| `DATABASE_URL` | `sqlite:///data/melogold.db` | `sqlite://<путь>`, `sqlite::memory:` (только тесты и OpenAPI), `postgres://`, `postgresql://` |
| `SQLITE_BUSY_TIMEOUT_MS` | `5000` | 100..60000 |
| `SQLITE_SYNCHRONOUS` | `FULL` | `FULL\|NORMAL` |
| `DATABASE_POOL_MAX` | `10` | 1..50, только PG |
| `DATABASE_SSL` | `disable` | `disable\|require\|verify-full` |
| `DATABASE_SSL_CA_FILE` | пусто | путь |
| `DATABASE_STATEMENT_TIMEOUT_MS` | `15000` | PG. Превышение → `503 server_busy` |
| `MIGRATE_ON_START` | `true` | при `false` и ожидающих миграциях сервер завершается с кодом 1 |
| `SCHEMA_CHECK` | `strict` | `strict\|warn`: сверка схемы со снапшотом при старте |
| `LOG_LEVEL` | `info` | pino |
| `TRUST_PROXY` | пусто | список IP/CIDR через запятую (формат proxy-addr). Пусто — XFF не доверяем |
| `CORS_ORIGINS` | пусто | origin через запятую |
| `HTTP_COMPRESSION` | `true` | gzip JSON |
| `OPENAPI_DOCS_UI` | `false` | включает `/docs` |
| `SHUTDOWN_GRACE_MS` | `10000` | в compose `stop_grace_period: 20s` |
| `MELOGOLD_SECRET_KEY` | пусто | 64 hex. Пусто → `/data/secret.key` (создаётся всегда, если отсутствует) |
| `ACCESS_TOKEN_TTL_SECONDS` | `900` | 300..3600 |
| `REFRESH_TOKEN_TTL_DAYS` | `90` | 7..365, скользящий |
| `REFRESH_GRACE_SECONDS` | `86400` | 60..604800 |
| `RESTORE_REFRESH_GRACE_DAYS` | `3` | 0..14, действует после restore (DESIGN §3.15) |
| `REGISTRATION` | `first` | `open\|closed\|first`. Официальный сервер: `open` |
| `REGISTRATION_POW_BITS` | `0` | 0..26; 0 = выключено. Официальный: `18` |
| `REGISTRATION_POW_SOFT_PER_HOUR` | `60` | порог адаптивной сложности |
| `RESERVED_LOGINS` | пусто | через запятую |
| `MAX_DEVICES_PER_USER` | `20` | 0 = без лимита (`maxDevices: null`) |
| `DEVICE_INACTIVE_DAYS` | `180` | |
| `PASSWORD_RESET_DEVICE_MIN_AGE_DAYS` | `7` | |
| `SECURITY_COOLDOWN_DAYS` | `7` | |
| `NEW_DEVICE_RESTRICT_HOURS` | `24` | |
| `LINK_TTL_SECONDS` | `300` | 60..900 |
| `LINK_NETWORK_HINT` | `true` | `false` → `sameNetwork: null` (режим `lan`) |
| `ARGON2_MEMORY_KIB` / `ARGON2_TIME_COST` / `ARGON2_PARALLELISM` | `65536` / `3` / `1` | ≥ 19456 / ≥ 2 / 1..4 |
| `ARGON2_MAX_CONCURRENCY` / `ARGON2_QUEUE_LIMIT` | `2` / `32` | переполнение → `503 server_busy{5}` |
| `SSE_HEARTBEAT_SECONDS` | `25` | 5..60 |
| `SSE_MAX_STREAMS_PER_DEVICE` / `SSE_MAX_STREAMS_PER_USER` | `4` / `64` | |
| `RATE_LIMIT_ENABLED` | `true` | тесты выключают |
| `HISTORY_RETENTION_DAYS` | `400` | ≥ 366 |
| `HISTORY_MAX_EVENTS` | `50000` | |
| `HISTORY_MERGE_UPLOAD_MAX` | `20000` | ≤ `HISTORY_MAX_EVENTS` |
| `SYNC_OPS_RETENTION_DAYS` | `180` | ≥ 30 |
| `PLAYBACK_RETENTION_DAYS` | `30` | |
| `RETENTION_RUN_AT_UTC` | `04:30` | `HH:MM`, jitter 10 мин (бэкап — 03:30) |
| `DISK_MIN_FREE_PERCENT` | `10` | 1..50 → `503 storage_full` |
| `APP_VERSION`, `GIT_SHA`, `TZ=UTC` | задаются при сборке образа | только чтение |
| `TEST_DB`, `TEST_DATABASE_URL` | — | только тесты, вне схемы |

**Хостовые переменные** `.env` читает только compose и host CLI, в приложение они не передаются:
- образ и режим: `MELOGOLD_IMAGE`, `COMPOSE_PROFILES`, `MELOGOLD_MODE`;
- сеть: `APP_BIND`, `APP_PORT`, `MELOGOLD_SUBNET`;
- PostgreSQL: `POSTGRES_PASSWORD`;
- память: `APP_MEM_LIMIT`, `APP_HEAP_MB`, `PG_SHARED_BUFFERS`, `PG_EFFECTIVE_CACHE_SIZE`, `PG_MEM_LIMIT`;
- бэкапы: `BACKUP_KEEP`, `BACKUP_AGE_RECIPIENT`, `BACKUP_POST_HOOK` (требует `BACKUP_AGE_RECIPIENT`).

---

## 11. Константы кода (`ServerLimits`, в env не выносятся)
```ts
type ServerLimits = {
  sync: { maxOpsPerRequest: 500; maxBodyBytes: 4194304; maxWorkUnitsPerRequest: 20000; defaultPageSize: 500; maxPageSize: 2000;
          maxVideoIdsPerAdd: 500; maxVideoIdsPerList: 10000; maxBaselineEntries: 500; maxIncludeKeys: 1000;
          maxPlaylists: 1000; maxPlaylistItems: 10000; maxItemsTotal: 100000; maxLikes: 100000; maxBookmarksPerType: 20000;
          maxTracks: 150000; maxPlayStats: 100000; maxPlayEvents: 60000; playAddPerHour: 2000 };
  history: { retentionDays: number; maxEvents: number; mergeUploadMax: number };   // из env
  playback: { queueMax: 200; maxBodyBytes: 131072 };
  account: { maxDevices: number | null; newDeviceRestrictHours: number;
             login: { minLength: 3; maxLength: 32; pattern: string }; password: { minLength: 8; maxLength: 128 } };
};
```
**Лимиты строк** (в единицах UTF-16):
- `title`, `albumTitle`, `artistsText`, `subtitle` — 500;
- имя артиста — 200;
- имя плейлиста — 200;
- `durationText` — 16;
- `year` — 16;
- `videoType` — 32;
- URL — 2048;
- `DeviceName` — 64;
- `osVersion`, `model`, `clientVersion` — 64.
