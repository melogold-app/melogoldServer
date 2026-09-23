# Melogold Server: архитектура MVP

> **Статус: нормативный, 2026-09-23.** Документация состоит из трёх файлов:
> - `docs/DESIGN.md` (этот файл): что строим и почему;
> - `docs/API.md`: точный контракт (поля, коды ошибок, SSE, DDL, env);
> - `docs/PLAN.md`: план реализации.
>
> Если документы расходятся, прав `API.md`, затем этот файл. Все прежние черновики заменены: design-v1, SYNC-V2, AUTH-DEVICES, STACK-DB, PACKAGING, «контракт v1». Замечания ревью (B1, M1–M19, m1–m30) учтены. Где было нужно решение, оно принято и обосновано в §1. Вопросы к владельцу собраны в §12.

**Сокращения путей:**
- `S/` = `/Users/maxim/Documents/melogold/melogoldServer/`
- `R/` = `/Users/maxim/Documents/melogold/melogoldAndroid/`
- `A/` = `R/app/src/main/kotlin/app/vitune/android/`
- `C/` = `/Users/maxim/Documents/VPN/clementineServer/src/`

**Сверено с кодом 23.09.2026:**
- Clementine:
  - `C/utils/errors.ts:56-67`: форма ошибки, `error` = текст сообщения;
  - `C/app.ts:36-44`: `trustProxy` по числу хопов;
  - `C/app.ts:108-139`: обработчик ошибок и `/health`;
  - `C/modules/live/live.service.ts:54-55`: heartbeat 15 с, retry 5 с;
  - `C/modules/live/live.service.ts:112`: 64 потока на пользователя;
  - `C/modules/live/live.service.ts:201-206`: `system.connected`;
  - `C/modules/live/live.service.ts:269-276`: конверт события;
  - `C/modules/live/live.routes.ts:166-187`: кадры SSE;
  - `C/modules/auth/refresh-token.service.ts:8-17`: окно grace 24 ч и его причина;
  - `C/modules/auth/auth.service.ts:1013-1020`: параметры argon2id;
  - `C/modules/auth/security.service.ts:147-163`: фиктивный хеш.
- Android:
  - `A/models/Playlist.kt:13`: поле `thumbnail`;
  - `A/models/Event.kt:20-25`: без естественного ключа;
  - `A/service/PlayerService.kt:166`: `LOCAL_KEY_PREFIX`;
  - `A/service/PlayerService.kt:253`: `flatMapMerge`;
  - `A/service/PlayerService.kt:461-491`: запись прослушивания;
  - `A/service/PlayerService.kt:1440`: `mediaItem?.let(Database::insert)`;
  - `A/Database.kt:250-265`: `history()` по `max(ROWID)`;
  - `A/Database.kt:373-374`: `incrementTotalPlayTimeMs`;
  - `A/Database.kt:685-689`: `clearEvents`, `clearEventsFor`;
  - `A/Database.kt:733`: `title … .orEmpty()`;
  - `A/Database.kt:827`: версия схемы 30;
  - `R/app/build.gradle.kts:25-26`: minSdk 24, targetSdk 37;
  - `R/app/src/main/AndroidManifest.xml:48`: `allowBackup="true"`.
- Пакеты (в распакованном виде):
  - kysely 0.29.6: `SqliteAdapter.supportsTransactionalDdl=false`, `SqliteDriver.beginTransaction` шлёт `begin`, controlled transaction поддерживает `savepoint`;
  - better-sqlite3 13.0.3: `gypfile:false`, в пакете `prebuilds/{linux,linuxmusl}-{x64,arm64}.node`, `SQLITE_DEFAULT_FOREIGN_KEYS=1` (`deps/defines.gypi:14`);
  - @fastify/rate-limit 11.2.0: экспортирует `normalizeIP(ip, ipv6Subnet)` (`index.js:32`, `:385`).

---

## 0. Кратко

- **Как ViTune, без аккаунта.** Синхронизация включается по желанию:
  - официальный сервер `https://api.melogold.app`;
  - свой сервер: одна команда установки, адрес вводится в клиенте.
- **Сервер хранит только метаданные:**
  - аккаунты и устройства;
  - треки: **любой** videoId YouTube плюс отображаемые данные;
  - лайки, закладки альбомов и артистов, плейлисты с порядком;
  - история прослушиваний и счётчики времени;
  - состояние «продолжить на другом устройстве».

  Аудио, загрузок, прокси YouTube и OpenSubsonic нет. Клиенты ходят в YouTube сами.
- **Клиенты:** Android (Kotlin), macOS (Swift), Windows (C#), Linux (Rust). **iOS нет.** Все собираются по `openapi.json` из релиза сервера.
- **Стек:**
  - Node 24 LTS, TypeScript без сборки (type stripping);
  - Fastify 5, zod 4, OpenAPI 3.0.3;
  - Kysely 0.29: одна схема и один SQL на две БД. SQLite через better-sqlite3 13 по умолчанию, PostgreSQL 18 через `pg` при `DATABASE_URL=postgres://…`;
  - argon2id.
- **Синхронизация.** Клиент шлёт намерения (ops), сервер ведёт таблицы состояния, у каждой строки свой `seq`.
  - Курсор `epoch.lib.hist`.
  - LWW-регистры с причинным правилом `base`.
  - Удаление плейлиста окончательное, офлайн-добавления в удалённый плейлист попадают в «(восстановлено)».
  - История: события только на добавление плюс серверный счётчик времени.
- **Сессия = строка `devices`.**
  - Access JWT на 15 минут с claims `sub, did, av, rid`.
  - Refresh с ротацией. Окно для потерянного ответа не прячет кражу токена.
  - Отзыв мгновенный.
- **Привязка устройства по QR или короткому коду через сервер.**
  - Два режима: `request` (QR показывает новое устройство) и `invite` (QR показывает вошедшее).
  - Три секрета плюс сверка двузначного числа.
- **Восстановление доступа.**
  - Код восстановления 100 бит, показывается один раз, одноразовый.
  - Пароль можно сменить с любого вошедшего устройства, в том числе без старого (решение владельца, §4.8).
- **Упаковка:**
  - один контейнер distroless, данные в томе `/data`;
  - установка `curl -fsSL https://get.melogold.app | sh`, режимы `domain`, `lan`, `proxy`;
  - TLS через Caddy, PostgreSQL в профиле compose.
- **Официальный сервер:** Ubuntu 24.04, 1 vCPU, 2 ГБ, 30 ГБ, Франкфурт. PostgreSQL в контейнере, деплой только по git-тегам.

---

## 1. Решения и причины

| # | Вопрос | Решение | Почему |
|---|---|---|---|
| 1 | Что хранит сервер | Только метаданные (§0) | Решение пользователя. Нет юридических и дисковых рисков аудио |
| 2 | Что такое трек | Любой `videoId` YouTube (`^[A-Za-z0-9_-]{11}$`). Метаданные — снимок, присланный клиентом. `albumId` и артисты необязательны | Слушают перезаливы, live, каверы из обычного YouTube. На каталог YTM опираться нельзя |
| 3 | Модель синхронизации | Намерения (ops) плюс таблицы состояния с per-row `seq` и общий счётчик на пользователя | Идемпотентность по `opId`. Курсор не теряет строк. Одинаково на SQLite и PG (judge-sync) |
| 4 | Конфликты | LWW по `effAt = min(at, now)` плюс причинное правило `base`. У элемента плейлиста два регистра: членство и позиция | Одновременные перестановки разных треков сохраняются |
| 5 | История | События только на добавление (`play_events`) плюс отдельный серверный счётчик `play_stats` | В ViTune счётчик и история независимы (`A/service/PlayerService.kt:461-491`) |
| 6 | Playback | Одна строка на пользователя, CAS по `rev`, SSE, блокировка старой сессии после передачи | «Последний активный плеер», без журнала |
| 7 | Слой БД | Kysely 0.29.6: одна схема, одни миграции, один код запросов. Диалект выбирается по схеме `DATABASE_URL` | Drizzle и Prisma требуют двух схем. TypeORM подводил в Clementine (944ecb3, 31e3c68) |
| 8 | Collation в PG | Все идентификаторы — `ID` = `text COLLATE "C"` | Иначе сравнение и порядок идентификаторов зависят от локали БД (на `en_US.UTF-8` порядок не байтовый, в отличие от SQLite), а встреча двух разных не-default collation (`"C"` и `en_US.utf8`) даёт `42P22` только на PG (M10) |
| 9 | Рантайм | Node 24 LTS, `.ts` без сборки, distroless `nodejs24-debian13:nonroot` | Нет `dist/`, стек-трейсы указывают на исходник. Node 26 — после выхода в LTS |
| 10 | HTTP и контракт | Fastify 5, fastify-type-provider-zod 7, zod 4, OpenAPI **3.0.3** | Паттерны Clementine. progenitor (Rust) понимает только 3.0.x |
| 11 | Аккаунт | Логин `[a-z0-9._-]` 3–32 символа плюс пароль. Почты нет | Решение пользователя. Защита от гомоглифов. Расширить набор символов позже можно без поломок |
| 12 | Хеш пароля | argon2id m=64 МиБ, t=3, p=1, семафор 2 и очередь 32, NFKC до хеширования | `C/modules/auth/auth.service.ts:1013-1020` |
| 13 | Сессия | Access JWT HS256 на 15 мин `{sub,did,av,rid}`. Refresh `mgrt1.*` скользит 90 дней, ротируется при каждом обновлении. Сессия = строка `devices` | Мгновенный отзыв одним `DELETE`. Урок Clementine: «хвост» цепочки токенов переживал отзыв |
| 14 | Потерянный ответ refresh | Окно 24 ч возвращает преемника, **только если преемник ещё не подтверждён** (`rid`). Иначе считаем кражу и удаляем устройство | M3: окно без этого условия прятало кражу |
| 15 | Восстановление | Код 100 бит (Crockford). Смена пароля без старого — с любого вошедшего устройства, без кулдауна | Решение пользователя (принят риск украденного разблокированного телефона) |
| 16 | Регистрация | Self-host: `REGISTRATION=first`, владельца создаёт установщик **до** публикации порта. Официальный: `open` плюс PoW плюс квоты | M8 (гонка с CT-логами), M9, M16 |
| 17 | Лимиты по IP | IPv4 целиком, IPv6 по /56, высокие потолки под CGNAT. Настоящая защита — троттлинг по логину в БД и семафор argon2. Refresh лимитируется по `did` | M9 |
| 18 | Привязка устройств | Через сервер, режимы `request`/`invite`. Секреты `linkToken`, `userCode`, `pollSecret`. Сверка двузначного числа. Deep link не запускает `request` | Решение пользователя плюс M1, M2 |
| 19 | Удаление аккаунта | Сразу логическое: логин освобождается, устройства удаляются. Данные чистит фоновая задача пачками | M13: каскад на 10 млн строк держал бы писателя |
| 20 | Ключ подписи | `MELOGOLD_SECRET_KEY` из env, иначе `/data/secret.key` (0600, создаётся всегда). В БД не хранится. В бэкап попадает только с `--with-secrets` и только в зашифрованном виде | M7 |
| 21 | Восстановление из бэкапа | Только через `melogold restore`. Бэкап сам несёт флаг `restore_pending=1`, старт сервера меняет epoch всех пользователей | B1: иначе курсоры тихо теряли строки |
| 22 | Упаковка | Один контейнер, том `/data`. compose с профилями `caddy` и `postgres` | Решение пользователя |
| 23 | Установка | `curl … \| sh`, MVP-режимы `domain`, `lan`, `proxy` | M18. ip-cert и tailscale — v1.1 |
| 24 | TLS | Caddy 2.11 (`network_mode: host`) | Автоматический HTTPS, реальные IPv4/IPv6 клиентов |
| 25 | БД официального сервера | **PostgreSQL 18** в контейнере с первого дня | Запас по нагрузке. Позже не понадобится перенос SQLite→PG (`db copy` — только v1.1). PG-путь живёт в проде, SQLite-путь проверяют self-hosters |
| 26 | Деплой официального сервера | Только по тегам `vX.Y.Z[-rc.N]`. CI заходит по SSH с forced command | Прод получает ровно то, что получат self-hosters |
| 27 | Живые события | SSE в памяти одного процесса. Поток закрывается в момент `exp` токена | Как в Clementine. Отзыв не переживается (M5) |
| 28 | Обновление клиентов | GitHub Releases, сервер в этом не участвует | Решение пользователя |
| 29 | AGPL §13 | `links.source` указывает на запущенную ревизию `…/tree/<GIT_SHA>` | m28 |
| 30 | Значок «Официальный» | Совпадение origin `https://api.melogold.app` **и** `serverId`, вшитого в сборку клиента | Одно лишь поле ответа подделывается |

---

## 2. Схема

```text
 ┌──────────┐  ┌──────────┐  ┌──────────┐  ┌──────────┐
 │ Android  │  │  macOS   │  │ Windows  │  │  Linux   │     клиенты (GPL-3.0), без аккаунта = ViTune
 │ Kotlin   │  │  Swift   │  │   C#     │  │  Rust    │
 └────┬─────┘  └────┬─────┘  └────┬─────┘  └────┬─────┘
      │  поиск, потоки, метаданные — НАПРЯМУЮ ─────────────────────▶  YouTube / YouTube Music
      │             │             │             │
      └──── HTTPS: JSON API (/auth, /sync, /playback) + SSE (/auth/me/events) ────┐
                                                                                   ▼
 ┌──────────────────────────────── хост (Docker) ────────────────────────────────────────┐
 │  Caddy :443/:80 (профиль caddy, network_mode host) ──▶ 127.0.0.1:8080                  │
 │  ┌──────────── контейнер app: distroless, один процесс Node 24 ─────────────────────┐  │
 │  │ Fastify: server · auth · devices · account · linking · sync · playback · live   │  │
 │  │ jobs: retention · auth-cleanup · account-purge · sqlite-maintenance · disk-guard │  │
 │  │ CLI: melogold user|backup|restore|sync rotate-epoch|secret rotate|qr|…           │  │
 │  │ Kysely ─┬─ better-sqlite3 ─▶ /data/melogold.db (WAL)      ← DATABASE_URL=sqlite  │  │
 │  │         └─ pg.Pool ────────▶ postgres:5432                ← DATABASE_URL=postgres│  │
 │  └────────────────────────────────────────────────────────────────────────────────┘  │
 │  том melogold_data → /data: melogold.db*, secret.key, .tmp/                            │
 │  контейнер postgres:18-trixie (профиль postgres, порт наружу не публикуется)           │
 │  том melogold_pgdata → /var/lib/postgresql                                             │
 └────────────────────────────────────────────────────────────────────────────────────────┘
```

**Основные потоки:**
1. **Регистрация или вход** → `AuthSession`. Клиент сохраняет `binding = serverId:userId`.
2. **Мутация в клиенте.** Одна локальная транзакция включает доменную запись и строку outbox. Затем `POST /sync {cursor, ops}`, ответ содержит результаты ops и страницу изменений. Остальным устройствам пользователя уходит SSE `sync.changed`, и они выполняют `POST /sync`.
3. **Воспроизведение.** `PUT /playback/state`, остальным устройствам SSE `playback.updated`, на другом устройстве карточка «Слушать здесь».
4. **Новое устройство.** QR или код, одобрение на вошедшем устройстве, `link/poll` выдаёт `AuthSession`.

---

## 3. Модель данных и синхронизация

### 3.1 Что синхронизируется

| Данные | В ViTune | Статус | Модель на сервере |
|---|---|---|---|
| Лайки | `Song.likedAt` | MVP | регистр на `videoId` (`sync_likes`) |
| Закладки альбомов и артистов | `Album/Artist.bookmarkedAt` | MVP | регистр плюс снимок метаданных (`sync_bookmarks`) |
| Свои плейлисты с порядком, в том числе привязанные к YouTube | `Playlist`, `SongPlaylistMap` | MVP | регистр заголовка, окончательное удаление. У элементов два регистра: членство и позиция |
| Метаданные треков | `Song` + карты альбома и артистов | MVP | `sync_tracks`, у строки свой `seq` (m2) |
| История прослушиваний | `Event` | MVP | `play_events`, поток `history` |
| Время прослушивания | `Song.totalPlayTimeMs` | MVP | серверный счётчик `play_stats` |
| Очистка истории, «убрать из Quick Picks», «скрыть» | `clearEvents*`, удаление `Song` | MVP | водяные знаки `play_forgets` |
| «Продолжить на другом устройстве» | `QueuedMediaItem` | MVP | `playback_state`, не через `/sync` |
| Журнал изменений, отмена удаления плейлиста | — | v1.1 | `sync_ops.pre_image` уже пишется |
| Настройки, blacklist, кэши, `Format`, `Lyrics`, `SearchQuery` | — | нет | принадлежат устройству |
| Треки `local:<id>` | `LOCAL_KEY_PREFIX` (`A/service/PlayerService.kt:166`) | никогда | — |

### 3.2 Идентификаторы
- **Трек:** `videoId`, `^[A-Za-z0-9_-]{11}$`. Для `local:` клиент ops не создаёт никогда.
- **Альбом, артист, канал:** `browseId`, `^[A-Za-z0-9_-]{1,64}$`. `UC…`-id канала подходит.
- **Плейлист:** UUIDv4 в нижнем регистре, его создаёт клиент (`Playlist.syncId`). Ключ на сервере — `(user_id, id)`.
- **Элемент плейлиста:** `(playlistId, videoId)`. Трек встречается в плейлисте не больше одного раза на всех клиентах.
- **Op:** UUIDv4 `opId`. Прослушивание: `eventId` = `opId` операции `play.add` = `Event.syncId`.
- **Устройство:** `deviceId` из claim `did`, из тела запроса он не берётся никогда.
- **Сервер:** `serverId`, UUIDv4, создаётся при первом старте. Привязка локальной БД: `binding = serverId + ":" + userId`. Переезд своего сервера с IP на домен `serverId` не меняет.
- **Сеанс воспроизведения:** `sessionId`, UUIDv4.
- **Плейлист восстановления:** `uuidv5(<id удалённого>, NS_MELOGOLD_RECOVERY)`, где `NS_MELOGOLD_RECOVERY = cf3e0fee-fe4e-42a1-b392-e5ffb8933b87`. Константа выбрана один раз и больше не меняется.

### 3.3 Трек — это любое видео YouTube
- Сервер принимает любой синтаксически верный `videoId`. Не проверяет, что это «песня YTM», и в YouTube не ходит.
- **`TrackDto`** (API §4.1):
  - `videoId`, `title`;
  - `artistsText`: для обычного видео это имя канала;
  - `artists[]`: для видео `[{id: "UC…", name: <канал>}]` или `[]`;
  - `albumId` и `albumTitle` (могут быть `null`);
  - `durationMs` (`null` у live и при неизвестной длительности) и `durationText`;
  - `thumbnailUrl`;
  - `explicit`;
  - `videoType`: строка `song|video|ugc|live|podcast_episode|…`, не enum;
  - `metadataStub`.
- **Заглушка.** Если метаданных нет или `title` пуст, сервер создаёт строку с `metadataStub=true` и `title=videoId`. Op при этом **не отвергается** никогда. Клиенты узнают заглушку по флагу, а не по эвристике.
- **`durationText` и `durationMs`** выводятся друг из друга, если прислан только один: `m:ss` или `h:mm:ss` ↔ мс.
- **Метаданные строки перезаписываются и получают новый `seq`**, только если пришли настоящие данные (не заглушка) и выполнено одно из условий:
  - сохранённая строка — заглушка;
  - изменились `title` или `artistsText`;
  - `durationMs` был `null`.

  Смена одной `thumbnailUrl` строку не двигает: это защита от «пинг-понга» между устройствами.
- **Импорт и сопоставление** (YouTube-плейлисты, файлы других сервисов) делает **клиент**. Если трека нет в каталоге YTM, клиент подставляет обычное видео YouTube. Сервер различий не делает.

### 3.4 Модель конфликтов
```ts
// effAt = min(op.at, nowTx); base = libSeq из курсора клиента в момент действия (null — epoch чужой или курсор битый)
const wins = (reg: { seq: number; at: number; dev: string | null } | null,
              op:  { base: number | null; effAt: number; dev: string }) =>
     reg === null
  || (op.base !== null && reg.seq <= op.base)                    // автор видел текущее значение
  || op.effAt > reg.at                                           // одновременные правки: побеждает позднее
  || (op.effAt === reg.at && (op.dev === reg.dev || op.dev > (reg.dev ?? "")));
```

| Сущность | Правило |
|---|---|
| Лайк, закладка, заголовок плейлиста (`name`, `thumbnailUrl`) | один регистр, `wins` |
| Элемент плейлиста | регистры членства (`mem_*`) и позиции (`pos_*`) |
| Удаление плейлиста | окончательное: `deleted=1`, элементы удаляются физически, список уходит в `pre_image` |
| Прослушивание | только добавление. Повтор `eventId` ничего не делает |
| `play_stats.total_ms` | коммутативная сумма: `add` прибавляет, `atLeast` берёт максимум. Обнуление — по водяному знаку `total_before` |
| `play_forgets` | водяные знаки, только растут |
| `playback_state` | побеждает позднее по `effAt`. То же устройство записывает всегда. Старая сессия после передачи блокируется |

- **Холостая операция** (значение уже такое) ничего не пишет и `seq` не расходует.
- **Часы клиента:** `at = max(localNow + clockOffset, lastAt + 1)`. `clockOffset` пересчитывается по `serverTime`, если расхождение больше 2 с.

### 3.5 Серверное состояние (DDL — API §9)

| Таблица | Назначение | Поток |
|---|---|---|
| `sync_heads` | мьютекс пользователя, общий счётчик `seq`, `epoch`, `floor_seq` | — |
| `sync_ops` | идемпотентность ops (кроме `play.add`), аудит, `pre_image`. 180 дней | — |
| `sync_tracks` | метаданные треков пользователя, свой `seq` | library |
| `sync_likes`, `sync_bookmarks`, `sync_playlists`, `sync_playlist_items` | состояние библиотеки | library |
| `play_events` | прослушивания. `seq` только у строк с `in_history=1` | history |
| `play_stats`, `play_forgets` | счётчики и водяные знаки | history |
| `playback_state` | одна строка на пользователя, с надгробием `cleared` | — |

Правило БД: **каждая запись строки состояния пользователя U идёт в транзакции, которая держит `lockUser(U)`, и получает `seq` из `sync_heads` этой транзакции.** Поэтому порядок `seq` совпадает с порядком коммитов внутри U.

### 3.6 Курсор и потоки
- **Формат:** `"<epoch 8 hex>.<libSeq>.<histSeq>"`. Пустая строка `""` означает оба потока с нуля. Для клиента курсор непрозрачен.
- **Потоки:**
  - `library`: `sync_playlists`, `sync_playlist_items`, `sync_likes`, `sync_bookmarks`, `sync_tracks`;
  - `history`: `play_events` (только строки с `seq`), `play_stats`, `play_forgets`.
- Номера у обоих потоков из одного счётчика, но курсор у каждого свой. Новое устройство сначала получает библиотеку, потом историю.
- **Разбор курсора:**
  - строка не по формату → `400 invalid_request`;
  - чужой `epoch` или часть больше `head.seq` → `410 cursor_invalid`;
  - часть меньше `floor_seq` → `410 cursor_expired{floorCursor}` (в MVP `floor_seq=0`).
- **Страница:**
  - библиотека до `limit` строк, остаток бюджета — истории;
  - исчерпанный поток получает курсор `head.seq`;
  - `hasMore` = не исчерпан хотя бы один из запрошенных потоков.

### 3.7 Операции (ops)
**Общие поля:** `opId`, `kind`, `at`, `base?`. Поле `tracks[]` несёт метаданные упомянутых `videoId`. Они записываются **после** обработчика, если статус не `deferred` и не `rejected`. Обязательные поля каждого `kind` — в API §4.8.

**Библиотека:**

| kind | Семантика на сервере | Регистр |
|---|---|---|
| `like.set {videoId, liked, likedAt?}` | Если `wins`, записать `liked`. `liked_at`: прежнее значение, если лайк уже стоял; иначе `min(likedAt ?? effAt, now)`. При снятии — `NULL` | лайк |
| `bookmark.set {type, browseId, bookmarked, bookmarkedAt?, title?, subtitle?, thumbnailUrl?, year?}` | То же. Метаданные обновляются при победе | закладка |
| `playlist.create {playlistId, name, browseId?, thumbnailUrl?, videoIds?, tracks?}` | Строки нет → создать вместе с элементами. Живая → холостая. Удалённая → `rejected playlist_deleted` | — |
| `playlist.update {playlistId, name, thumbnailUrl?}` | Полный заголовок: отсутствие `thumbnailUrl` означает `null`. Живой плейлист и `wins` → обновить. Удалён → `rejected playlist_deleted`. Нет строки → `deferred playlist_not_found` | заголовок |
| `playlist.delete {playlistId}` | Живой → `deleted=1`, `deleted_seq`, `pre_image={name, videoIds}`, элементы удаляются физически. Уже удалён или нет строки → холостая | окончательно |
| `playlist.items.add {playlistId, videoIds[1..500], after?, before?}` | Для каждого отсутствующего `videoId`: нет строки или `wins(mem)` → `present=1`, ключ по якорям, `mem` и `pos` = этот op. Есть → холостая. Плейлист удалён: при `base < deleted_seq` или `base=null` → `redirected` в плейлист восстановления, иначе `rejected playlist_deleted` | членство, позиция |
| `playlist.item.remove {playlistId, videoId}` | Элемент есть и `wins(mem)` → `present=0` (надгробие) | членство |
| `playlist.item.move {playlistId, videoId, after?, before?}` | Элемент есть и `wins(pos)` → новый ключ по якорям | позиция |
| `playlist.items.replace {playlistId, videoIds[0..10000]}` | Зеркало YouTube, `pre_image` = текущий список. Для элементов из списка при `wins(mem)` → `present=1`. Для отсутствующих при `wins(mem)` → `present=0`. Порядок: элементы на LIS текущих ключей сохраняют ключи, остальные получают ключи между соседями с `wins(pos)` | членство, позиция |
| `playlist.import {playlistId, name, browseId?, thumbnailUrl?, videoIds[]}` | Только при слиянии. Нет строки → как `create`. Живой → недостающие дописываются в конец в данном порядке с `mem_at = pos_at = 0` (серверные надгробия побеждают). Удалён → `redirected` со всеми треками | — |

- **Якоря** работают одинаково на сервере и в клиентах:
  - `after` есть в списке → вставка сразу после него;
  - иначе `before` есть в списке → сразу перед ним;
  - иначе в конец.
  - Чтобы вставить в начало, передаётся `before` = первый синхронизируемый `videoId`.
- **Ключи порядка** выдаёт **только сервер**: fractional indexing, алфавит base62, сравнение ordinal. Если ключ длиннее 48 символов, все ключи плейлиста выдаются заново, и каждый элемент получает новый `seq`.
- **Плейлист восстановления:**
  - `id = uuidv5(deletedId, NS_MELOGOLD_RECOVERY)`;
  - имя `"<имя> (восстановлено)"` при `Accept-Language: ru*`, иначе `"<имя> (recovered)"`, обрезается до 200 символов;
  - если он сам удалён, берётся следующий по той же цепочке.

**История:**

| kind | Семантика | Пишется в `sync_ops` |
|---|---|---|
| `play.add {videoId, playedAt, playTimeMs, history, playtime}`, `opId`=eventId, `at`=playedAt | §3.11.3. Идемпотентность по PK `play_events`. Повтор → `applied, replayed:true` | нет |
| `play.baseline {mode: add\|atLeast, entries[1..500]}` | Запись пропускается, если у `videoId` `total_before ≥ effAt`. `add`: `total_ms += totalMs`. `atLeast`: `total_ms = max(total_ms, totalMs)`. Строка изменилась → новый `seq`. Все записи пропущены → `superseded` | да |
| `history.clear {eventsBefore}` | `play_forgets('*').events_before = max(старое, min(eventsBefore, now))`. Удаляются `play_events` с `in_history=1 AND played_at ≤ знак` (пачками). Счётчики не трогаются, как в ViTune | да |
| `history.forget {videoId, eventsBefore, resetTotal}` | Знак трека растёт. При `resetTotal` ещё `total_before = max(…)`, а `play_stats.total_ms = 0` с новым `seq`. Удаляются события трека с `played_at ≤ знак` | да |

**Результаты ops:**
- `applied`: эффект записан или значение уже было таким;
- `superseded`: op проиграл по всем затронутым регистрам;
- `redirected`: записано в плейлист восстановления (`playlistId` в ответе);
- `rejected`: только `playlist_deleted` и `invalid_video_id`;
- `deferred`: не сохраняется, `seq` не тратит. Коды: `unknown_kind`, `invalid_payload`, `quota_exceeded`, `playlist_not_found`, `op_rate_limited` (с `retryAfterSeconds`).

### 3.8 Алгоритм `POST /sync`
Ops применяются в **пишущей** транзакции. Страница читается **отдельной читающей транзакцией после commit** (M13): писатель SQLite занят меньше, курсор остаётся корректным (§3.5).

```ts
async function sync(ctx: Ctx, auth: Authed, req: SyncRequest): Promise<SyncResponse> {
  checkEnvelope(req);                                   // 400; бюджет Σ(videoIds+entries+tracks) ≤ 20000 → 413
  const streams = req.streams ?? ["library", "history"];
  let results: OpResult[] = [], touched = new KeySet(), headCursor: string | null = null;
  if (req.ops?.length) {
    ({ results, touched, headCursor } = await ctx.db.write(async (q) => {
      const head = await lockUser(q, auth.userId);      // первый оператор транзакции
      parseCursor(req.cursor, head);                    // 400/410 — до применения ops, откат
      const oc = newOpCtx(q, auth, head, ctx.clock.now());
      for (const raw of req.ops!) results.push(await applyOp(oc, raw));   // §3.9
      if (oc.seq === head.seq) return { results, touched: oc.touched, headCursor: null };
      await bumpHead(q, auth.userId, oc.seq, oc.now);
      return { results, touched: oc.touched, headCursor: `${head.epoch}.${oc.seq}.${oc.seq}` };
    }));
    if (headCursor) ctx.live.publishCoalesced(auth.userId, "sync.changed", { cursor: headCursor },
                                              { excludeDeviceId: auth.deviceId });   // склейка 2 с
    ctx.devices.touchLastSync(auth.deviceId);           // не чаще раза в минуту
  }
  return ctx.db.read(async (q) => {                     // PG: REPEATABLE READ READ ONLY; SQLite: BEGIN (снимок WAL)
    const head = await readHead(q, auth.userId);        // нет строки → ensureHead в короткой write-tx и повтор (m7)
    const since = parseCursor(req.cursor, head);
    if (!req.ops?.length && !req.include && atHead(since, head, streams)) return emptyPage(head, since);
    const page = await readPage(q, auth.userId, since, clamp(req.limit ?? 500, 1, 2000), head.seq, streams);
    const forced = await readRows(q, auth.userId, touched.union(req.include));
    return assemble(results, page, forced, head.epoch);
  });
}

async function applyOp(oc: OpCtx, raw: WireOp): Promise<OpResult> {
  const prev = raw.kind === "play.add" ? await findPlayEvent(oc, raw.opId) : await findSyncOp(oc, raw.opId);
  if (prev) { oc.touched.addFrom(raw, prev); return { ...resultOf(prev), replayed: true }; }
  const h = handlers[raw.kind];
  if (!h) return deferred(raw, "unknown_kind");
  const op = h.parse(raw);                              // строгая zod-схема kind; нет → invalid_payload / invalid_video_id
  if (!op.ok) return op.result;
  const env = { effAt: Math.min(op.value.at, oc.now), base: parseBaseLenient(raw.base, oc.head) };
  const r = await h.apply(oc, op.value, env);           // пишет строки с seq = oc.next(), заполняет oc.touched
  if (r.status === "deferred" || r.status === "rejected") return r;
  await upsertTracks(oc, op.value.tracks);              // санитизация §3.9, квота треков §3.10
  if (raw.kind === "play.add") return r;
  const opSeq = oc.next();
  await insertSyncOp(oc, opSeq, raw, env, r);           // payload без tracks
  return { ...r, seq: opSeq };
}
```

**`readPage`:**
- По каждой таблице потока отдельный запрос `WHERE user_id=? AND seq > ? ORDER BY seq LIMIT n+1`. `UNION ALL` с `LIMIT` в ветках не переносим между СУБД, поэтому результаты сливаются в TS.
- Затем строки: библиотека с `seq ∈ (since.lib, libEnd]`, история с `seq ∈ (since.hist, histEnd]`.

**Состав ответа.** Каждый ключ строки встречается один раз и всегда как полный текущий образ. В ответ входят:
1. страница;
2. текущие строки всех сущностей, которых коснулись ops этого запроса (при любом статусе), плюс `include`. Сюда входят `playStats` для каждого `play.*`;
3. плейлисты-родители элементов страницы, если их `seq > libEnd`;
4. `tracks` для присутствующих элементов, стоящих лайков, `plays` и `playStats` ответа.

Клиент применяет строки в порядке `tracks → playlists (по createdAt) → items → likes → bookmarks → playStats → plays → playForgets`.

**Почему курсор не теряет строки:**
- любая запись U держит `lockUser(U)` и получает `seq` в своей транзакции;
- читатель берёт голову и строки из одного снимка;
- более поздняя транзакция получает `seq > head` и может только оказаться за концом страницы.

Удаление событий по сроку хранения для клиентов удалением не считается.

### 3.9 Проверка ops и «ядовитые» операции (M14, m20)
**Уровень маршрута.** Если что-то не так, `400 invalid_request` получает весь запрос. Проверяются только:
- конверт запроса;
- `opId` (Uuid), `kind` (1..64), `at` (Iso), `base` (≤64);
- дубли `opId`;
- бюджет работы.

Остальные поля op на маршруте **не проверяются**. Технически это отдельный `validatorCompiler` маршрута `/sync` для конверта. Типизированная схема `SyncRequest` остаётся источником OpenAPI.

**Обработчик, по каждому op:**
- **Идентификаторы.** Любое поле-videoId (`videoId`, `videoIds[]`, `after`, `before`, `entries[].videoId`) не по регулярке → `rejected invalid_video_id`.
- **Структура.** Нет обязательного поля, неверный тип или недопустимое сочетание → `deferred invalid_payload`.
- **Метаданные никогда не приводят к отказу.** Они чистятся поле за полем:
  - строки обрезаются до лимита без разрыва суррогатной пары;
  - неверный тип или неверный URL → `null`;
  - пустой `title` → заглушка;
  - неверные элементы `artists[]` и `tracks[]` отбрасываются.

  Правило одно для `tracks[]`, мета закладок и `thumbnailUrl` плейлиста.
- **Имя плейлиста:** trim, обрезка до 200 символов. Пустое → «Без названия» или «Untitled» по `Accept-Language`.

**Клиент.** Цикл описан в §3.13.4.
- **400 на пакет** → бисекция: пакет делится пополам, пока виновник не останется один. Его op помечается локально `deferred/client_bug`. Это около 9 запросов вместо 500.
- **3 подряд 5xx или таймаута на одном пакете** → та же бисекция. Одиночный op, который продолжает падать, помечается `deferred/server_error`.
- **Pull без ops** (`ops: []`) выполняется **всегда**, даже если отправка застряла.
- **Повтор deferred ops:** автоматически при смене версии клиента или сервера и вручную кнопкой «Повторить».
- **Кнопка «Отбросить»** удаляет deferred op и запрашивает текущую строку сущности через `include`.

### 3.10 Квоты и бюджет запроса (M13, M16)
Константы кода, публикуются в `/server/info.limits` (API §11). Счётчики берутся через `COUNT(*)` один раз за запрос, при первой необходимости, дальше ведутся в памяти запроса. Отдельных счётчиков, которые могли бы разойтись с данными, нет.

| Что | Лимит | При превышении |
|---|---|---|
| ops в запросе / тело | 500 / 4 МиБ | 400 / 413 |
| Бюджет Σ(`videoIds` + `entries` + `tracks`) | 20 000 | `413 payload_too_large` (клиент делит пакет) |
| Живые плейлисты | 1000 | `deferred quota_exceeded` |
| Элементы в плейлисте / всего (с надгробиями) | 10 000 / 100 000 | `deferred quota_exceeded` |
| Лайки / закладки каждого типа | 100 000 / 20 000 | `deferred quota_exceeded` |
| `sync_tracks` | 150 000 | новые метаданные не сохраняются, op применяется |
| `play_stats` | 100 000 | для новых треков счётчик не создаётся, событие сохраняется |
| `play_events` (все) | 60 000 | вытесняются самые старые `in_history=0`, затем самые старые `in_history=1` |
| `play.add` | 2000 в час на пользователя | `deferred op_rate_limited{retryAfterSeconds}`: клиент держит op как pending и повторяет позже |
| Свободный диск `/data` | меньше `DISK_MIN_FREE_PERCENT` (10%) | `503 storage_full` на `/sync` с ops, `PUT /playback/state` и регистрацию. Pull и вход работают |

### 3.11 История прослушиваний

#### 3.11.1 Что считается прослушиванием
- Один сеанс `PlaybackStats` с `totalPlayTimeMs ≥ 5000` = одно событие (`A/service/PlayerService.kt:461-466`). Десктопы используют то же правило: сеанс — от начала элемента очереди до перехода или остановки, в зачёт идёт реальное время звучания.
- `timestamp` = конец сеанса.
- Треки `local:` не отправляются.

#### 3.11.2 Флаги ViTune → отправка

| `pauseHistory` | `pausePlaytime` | Отправка |
|---|---|---|
| выкл | выкл | `play.add {history:true, playtime:true}` |
| вкл | выкл | `play.add {history:false, playtime:true}` (серверная строка `in_history=0`, хранится 30 дней ради идемпотентности) |
| выкл | вкл | `play.add {history:true, playtime:false}` |
| вкл | вкл | ничего |

#### 3.11.3 Приём `play.add`
```
eff = min(playedAt, now); fAll = play_forgets['*']; fV = play_forgets[videoId]
if playAddInLastHour(user) ≥ 2000                         → deferred op_rate_limited
inHistory = history && eff > max(fAll?.events_before, fV?.events_before) && eff > now − HISTORY_RETENTION_DAYS
evictIfNeeded(user)                                        // play_events ≥ 60000 → удалить старейшие (§3.10)
INSERT play_events(event_id=opId, played_at=eff, in_history, counts_playtime=playtime, device_id=did,
                   seq = inHistory ? next() : NULL, received_at=now)
if playtime && !(fV?.total_before != null && eff <= fV.total_before) && statsQuotaAllows(videoId):
    play_stats(videoId): total_ms += playTimeMs; seq = next()        (upsert; максимум считается в TS)
if inHistory: play_stats.last_played_at = max(last_played_at, eff)   (новый seq, если строка изменилась)
status = applied; touched += stat:videoId
```
Событие, пришедшее после очистки истории, в счётчике учитывается. Так же поступает ViTune.

#### 3.11.4 Счётчик на клиенте
Инвариант:
```
Song.totalPlayTimeMs = playStats.totalPlayTimeMs (последний образ сервера) ⊕ ops этого videoId из outbox по порядку:
   play.add(playtime:true) → t += playTimeMs;  baseline add → t += totalMs;
   baseline atLeast → t = max(t, totalMs);     history.forget(resetTotal) → t = 0
```
Локальное прослушивание делает три вещи в **одной** транзакции: прибавляет к счётчику, пишет `Event` с `syncId` и ставит op в outbox.

#### 3.11.5 Удаление
- «Очистить историю» → `history.clear {eventsBefore: now}`. Другие устройства: `DELETE FROM Event WHERE timestamp <= eventsBefore`.
- «Убрать из Quick Picks» → `history.forget {resetTotal:false}`.
- «Скрыть» → `history.forget {resetTotal:true}`. Трек из библиотеки не удаляется, его счётчик обнуляется на всех устройствах.

#### 3.11.6 Хранение
- Сервер хранит 400 дней (`HISTORY_RETENTION_DAYS`) и не больше 50 000 событий `in_history=1` на пользователя.
- Строки `in_history=0` удаляются через 30 дней.
- `play_stats` и `play_forgets` живут, пока жив аккаунт.
- Удаление по сроку для клиентов удалением не считается: клиенты свою историю не чистят.

#### 3.11.7 Как десктопы строят экраны
- History: последние 100 разных `videoId` по `max(playedAt)`.
- Trending и Top за период: `Σ playTimeMs` событий за период.
- Top за всё время: `play_stats.total_ms DESC`.
- «Песни»: `total_ms > 0`.

### 3.12 «Продолжить на другом устройстве»

#### 3.12.1 Модель
- Одна строка `playback_state` на пользователя: «последний активный плеер».
- **Очередь:** окно до 200 `TrackDto`.
  - Если очередь длиннее, берутся элементы `[index−50, index+149]`.
  - Элементы `local:` выбрасываются. Если текущий элемент `local:`, клиент ничего не публикует.
  - Клиент ужимает окно так, чтобы тело было не больше 120 КиБ: сначала выбрасывает `artists`, потом сужает окно вокруг `index`. На `413` делит окно пополам (m19).

#### 3.12.2 Когда клиент публикует
- **Условия (все сразу):** есть сессия, настройка включена, в текущем сеансе звук хотя бы раз реально играл.
- **События:** смена трека, play или pause, seek, изменение очереди (`queueVersion++`), уход в фон, heartbeat раз в 60 с во время игры.
- **Склейка** 1,5 с.
- **`queue`** передаётся, только если пара `(sessionId, queueVersion)` изменилась с последнего успешного PUT.
- **Без сети** хранится только последний снимок. Если ему меньше 10 минут, он отправляется при появлении сети, иначе выбрасывается.

#### 3.12.3 Правила сервера для `PUT`
```
eff = min(at, now); s = stored (с учётом cleared)
1. s && !s.cleared && s.handoff_device_id == me && s.handoff_session_id == req.sessionId → {applied:false, reason:"handed_off", state}
2. s && !s.cleared && s.device_id != me && eff < s.state_at                           → {applied:false, reason:"newer_state", state}
3. queue не передан и (s отсутствует || s.cleared || (s.device_id, s.session_id, s.queue_version) != (me, sessionId, queueVersion))
                                                                                       → 409 playback_queue_required
4. CAS: UPDATE … WHERE user_id=? AND rev=? (новая строка: INSERT … ON CONFLICT DO NOTHING), до 3 попыток, затем 503 server_busy.
   rev = max(prev.rev + 1, nowMs); cleared=0; state_at=eff; updated_at=now;
   handoff_* = req.handoffFrom ?? (s && !s.cleared && s.device_id == me ? s.handoff_* : NULL)
```
- Неверный элемент очереди или `index` вне очереди → `400 invalid_request`: если выбросить элемент, сдвинется `index`.
- Метаданные элементов чистятся так же, как в §3.9.
- **`DELETE`** не удаляет строку, а ставит надгробие: `cleared=1`, `rev = max(prev+1, now)`, пустая очередь, `handoff_*` = NULL. Поэтому `rev` не идёт назад (m18).
- `GET` при `cleared=1` отвечает `state:null`.
- Строки старше 30 дней удаляет retention. К этому времени `rev` заведомо меньше `now`.

#### 3.12.4 SSE `playback.updated`
- **Когда отправляется** (только при значимом изменении):
  - новое устройство или сессия;
  - изменились `index` или `queueVersion`;
  - изменился `playing`;
  - передача или очистка;
  - расхождение позиции с экстраполяцией больше 10 с.
- Heartbeat обновляет строку молча.
- Не чаще раза в секунду на пользователя, trailing.
- Событие с `rev` ≤ последнего виденного игнорируется, кроме `cleared`.

#### 3.12.5 «Слушать здесь» на устройстве B
- **Показать карточку**, если выполнено всё:
  - `state.deviceId ≠ B`;
  - либо `playing` и `now − updatedAt < 3 мин` («Играет на „Pixel 8“»), либо состояние моложе 24 ч («Продолжить с „Pixel 8“ · 1:23»);
  - B сейчас не играет;
  - пользователь не скрыл этот `rev`.
- **Позиция:** `pos = positionMs + (playing ? min(serverNow − at, 3 мин) : 0)`, но не больше `durationMs − 1000`.
- **По нажатию:**
  1. `GET` с полной очередью.
  2. Собрать `MediaItem` на каждый трек.
  3. `setMediaItems(items, index, pos)` и play.
  4. Новый `sessionId`.
  5. `PUT` с `handoffFrom = {deviceId, sessionId}` из состояния.

#### 3.12.6 Автопауза на устройстве A
- **Когда:** пришёл `playback.updated` с `handoffFrom = {A, текущая сессия A}` и передаче меньше 5 мин, или PUT ответил `handed_off`.
- **Что делает A:** ставит паузу (если настройка включена), меняет `sessionId`, показывает «Воспроизведение продолжено на „Ноутбук“».
- **Android** держит SSE, пока приложение на переднем плане **или** пока играет `PlayerService`.

### 3.13 Клиент: хранение, outbox, цикл синхронизации

#### 3.13.1 Схема на клиенте
**Android:** Room v31 (сейчас 30, `A/Database.kt:827`), `AutoMigration(30,31)`, только добавления:
- `Playlist.syncId TEXT NULL UNIQUE`;
- `SongPlaylistMap.sortKey TEXT NULL`;
- `Event.syncId TEXT NULL UNIQUE`;
- `SyncOutbox(id PK AUTOINCREMENT, opId UNIQUE, kind, entityKey, json, at, base, state pending|deferred, code, attempts, createdAt)`;
- `SyncState(key PK, value)`: `binding`, `cursor`, `lastAtMs`, `clockOffsetMs`, `phase ready|merging|fullResync`, `authoritative`, `mergeMode first|silent`, `needsMerge`.

**Десктопы** (GRDB, Microsoft.Data.Sqlite, rusqlite) сразу создают те же сущности: `tracks`, `likes`, `bookmarks`, `playlists(sync_id PK…)`, `playlist_items(…, sort_key, position)`, `play_events`, `play_stats`, `outbox`, `sync_state`.

**`entityKey`:**
- `like:<vid>`;
- `bm:<type>:<id>`;
- `pl:<uuid>`: все ops плейлиста и его элементов;
- `stat:<vid>`: `play.add`, `history.forget`;
- `stat:batch`: `play.baseline`;
- `hist:*`: `history.clear`.

#### 3.13.2 Путь записи
Все экраны пишут через `LibraryRepository` и `HistoryRepository`. Одна локальная транзакция включает:
1. доменную мутацию;
2. строку outbox — только если есть `binding`, трек не `local:` и у плейлиста есть `syncId`;
3. `rebuildPlaylist` для плейлистов.

- **Без `binding`** клиент ведёт себя как ViTune.
- **Есть `binding`, но нет сессии** (`AuthRequired`):
  - ops копятся;
  - если в outbox больше 5000 `play.add`, новые прослушивания склеиваются в `play.baseline add` по треку, а история остаётся локальной;
  - если в outbox больше 50 000 строк, запись в outbox прекращается, ставится `needsMerge=true`.

#### 3.13.3 Чистые функции порядка
Функции одинаковы на всех клиентах, векторы лежат в `spec/playlist-ops.vectors.json`. Сравнение ключей ordinal:
- C#: `string.CompareOrdinal`;
- Swift: сравнение `Array(a.utf8)`;
- Kotlin и Rust: как есть.

```
applyAdd(list, ids, after?, before?)  fresh = dedupe(ids) − list; pos = after∈list ? idx(after)+1 : before∈list ? idx(before) : len
applyRemove(list, v)                  list − v
applyMove(list, v, after?, before?)   v∉list → list; rest = list−v; позиция как у add по rest
applyReplace(list, ids)               dedupe(ids)
applyImport(list, ids)                list + (dedupe(ids) − list)
applyCreate(list, ids)                list пуст ? dedupe(ids) : list
rebuildPlaylist(pl): якорь каждого local:-элемента = ближайший синхронизируемый сосед слева (или START);
  list = синхронизируемые строки с sortKey ORDER BY sortKey, videoId; затем по порядку pending и deferred ops pl:<id>;
  вплести local:-элементы за якоря (якорь исчез → в конец); переписать позиции 0..n-1
```

#### 3.13.4 Цикл (один на процесс, под mutex)
```
syncOnce():
  if phase == merging: runMerge(mergeMode)                               // §3.14, идемпотентно
  seen = (phase == fullResync && authoritative) ? KeySets() : null
  loop:
    batch = outbox.sendable(maxOps=500, maxWork=20000)   // pending по id; entityKey с более ранним deferred пропускается
    resp = sendBisecting(batch)                          // см. ниже; на неудаче отправки — POST {ops:[]} (pull всегда идёт)
      сеть/5xx/429/503 → Backoff(2 с·2^n до 5 мин, jitter, Retry-After); 401 → refresh или AuthRequired
      410 cursor_expired → phase=fullResync(authoritative), cursor=""; continue
      410 cursor_invalid → phase=merging(silent); return syncOnce()
      409 protocol_unsupported → Incompatible
    db.transaction {
      результаты: deferred → outbox.defer (op_rate_limited → pending + nextAttemptAt); остальные → outbox.delete
      redirected → уведомление о плейлисте восстановления
      destructive(resp) → автокопия БД
      applyRows(resp); seen?.addAll(keysOf(resp)); reapplyPending(touched); rebuild затронутых плейлистов
      cursor = resp.cursor; adjustClock(resp.serverTime)
    }
    if !resp.hasMore && outbox.sendable().isEmpty(): break
  if seen: db.transaction { автокопия; deleteUnseen(seen, skip = entityKey с pending/deferred ops и плейлисты без syncId); phase = ready }

sendBisecting(batch):
  400 invalid_request: |batch|==1 → defer(op, client_bug) | иначе отправить первую половину (вторая — следующей итерацией)
  3 подряд 5xx/таймаут на том же batch: |batch|==1 → defer(op, server_error) | иначе бисекция
  413 → уменьшить пакет вдвое
```

#### 3.13.5 `applyRows` на Android
- **track:**
  - `INSERT OR IGNORE Song` плюс карты альбома и артистов;
  - существующая строка перезаписывается, если серверная строка не заглушка, а локальная — заглушка или у неё другие `title`/`artistsText`.
- **playlist:**
  - `deleted` → если в плейлисте есть `local:`-элементы, он превращается в локальный «(локальные файлы)», иначе удаляется;
  - иначе upsert;
  - новые плейлисты вставляются по `createdAt`.
- **item:** `present` → `INSERT OR REPLACE` с `sortKey`, иначе удалить.
- **like, bookmark:** обновить `likedAt` / `bookmarkedAt`.
- **playStat:** счётчик по формуле §3.11.4.
- **play:** `INSERT OR IGNORE Event(…, syncId)`, счётчик **не** трогать.
- **playForget:** `DELETE Event` по водяному знаку.

Строки `Song` синхронизация не удаляет никогда. SQLite на minSdk 24 без UPSERT, поэтому только `@Insert(IGNORE)` плюс `@Update`.

#### 3.13.6 Машина состояний (общая для всех клиентов)
```
Unbound ─вход/регистрация/привязка─▶ Binding
Binding: binding совпал и !needsMerge ─▶ Ready | совпал и needsMerge ─▶ Merging(silent) ─▶ FullResync(auth) ─▶ Ready
         другой/пустой, локально пусто ─▶ FullResync(auth=false) ─▶ Ready
         другой/пустой, есть данные ─▶ диалог {Объединить → Merging(first) | Заменить → очистка → FullResync(auth) | Отмена → Unbound}
Ready ─триггер─▶ Syncing ─ok─▶ Ready; сеть/5xx ─▶ Backoff; 410 invalid ─▶ Merging(silent); 410 expired ─▶ FullResync(auth)
любое ─ refresh 401 | SSE session.invalidated ─▶ AuthRequired (данные, outbox, binding целы) ─вход─▶ Binding
любое ─ 409 protocol_unsupported ─▶ Incompatible (outbox копится)
```

**Триггеры синхронизации:**
- мутация (через 2 с; если в outbox только `play.*` — через 60 с);
- выход на передний план;
- появление сети;
- SSE `sync.changed` с другим курсором;
- `system.connected`;
- кнопка;
- таймер. Android в фоне: WorkManager при непустом outbox плюс pull раз в 12 ч.

**Автокопия БД** (3 последние) делается перед применением ответа, если он:
- снимает 100 лайков и больше;
- удаляет плейлист на 50+ треков или 5+ плейлистов;
- удаляет 30% синхронизируемых элементов;
- удаляет 500+ событий;
- а также всегда перед слиянием, заменой и `deleteUnseen`.

### 3.14 Первая синхронизация, слияние, замена
**Диалог.** Сводка собирается из `/sync/summary`, `/sync/merge-plan` и локальных подсчётов.

**Объединить (`Merging(first)`).** Одна локальная транзакция после получения `merge-plan`:
1. **Автокопия.** Из outbox **сохраняются отрицательные намерения** (M15): `like.set false`, `bookmark.set false`, `playlist.delete`, `playlist.item.remove`, `history.clear`, `history.forget`. Они сохраняются со своим исходным `at`, а `base` сбрасывается в `null`. Остальной outbox очищается: его эффект уже есть в локальном состоянии.
2. **Плейлисты по плану.**
   - `deleted` → удалить локально (с правилом `local:`).
   - `merge`/`create` → `syncId = playlistId`, `sortKey = NULL`, op `playlist.import` с синхронизируемыми `videoIds` в локальном порядке.
3. **Лайки:** `like.set {liked:true, at: likedAt, base:null}` на каждый нелокальный трек.
4. **Закладки:** `bookmark.set {…, at: bookmarkedAt, base:null}`.
5. **История:**
   - события нелокальных треков за `retentionDays`, самые новые, не больше `mergeUploadMax`;
   - событию без `syncId` присваивается UUID;
   - на каждое событие `play.add {history:true, playtime:false}`.
6. **Счётчики:** `play.baseline {mode:"add"}` пачками по 500.
7. **Отрицательные намерения из п. 1** ставятся в очередь **после** ops из п. 2–6.
8. `binding` = новый, `cursor = ""`, `phase = fullResync(authoritative=true)`.

**Тихое слияние (`Merging(silent)`).** Запускается после `410 cursor_invalid` или при `needsMerge`. Отличия от «Объединить»:
- диалога нет;
- в п. 5 выгружаются только события, у которых уже есть `syncId`;
- в п. 6 используется `atLeast`.

**Заменить:**
1. Автокопия.
2. Очистить лайки, закладки, плейлисты (правило `local:`), события и счётчики нелокальных треков.
3. Очистить outbox, `cursor=""`, `FullResync(auth=true)`.

**Смена аккаунта или сервера** = выход плюс вход. `binding` не совпадёт, поэтому появится диалог.

**Выход:**
- flush outbox (5 с);
- по умолчанию данные, `binding`, курсор и outbox сохраняются;
- «Выйти и убрать данные аккаунта» — это автокопия плюс «Заменить».

### 3.15 Восстановление сервера и epoch (B1)
**Проблема.** После восстановления из бэкапа `sync_heads.seq` откатывается. Новые записи снова получают номера, которые устройства уже видели, и устройство с курсором ниже головы молча пропустит строки.

**Защита:**
1. **Бэкап сам несёт флаг.**
   - Копия SQLite после `VACUUM INTO` получает `server_meta.restore_pending='1'`.
   - Дамп PG делается в plain-формате, и в его конец дописывается `INSERT INTO server_meta … ('restore_pending','1') ON CONFLICT … DO UPDATE`.

   Любое восстановление из такого бэкапа, даже ручное, ставит флаг.
2. **Старт сервера при `restore_pending='1'`:**
   - до `listen` выполняется `rotate-epoch --all`: каждому пользователю новый случайный `epoch`, пачками;
   - ставится `restore_refresh_grace_until = now + RESTORE_REFRESH_GRACE_DAYS` (по умолчанию 3);
   - флаг снимается;
   - в лог уходит `warn`.
3. **`melogold restore`** (SQLite и PG) делает то же самое сразу. Для PG восстановление идёт в `melogold_restoring`, а затем выполняется атомарная подмена имени базы (§7.6).
4. **Откат снапшота ВМ или тома** обнаружить невозможно. Поэтому в runbook обязательный шаг `melogold sync rotate-epoch --all`: он ставит флаг и перезапускает сервер.
5. **Refresh после восстановления.**
   - Refresh-токены, ротированные после бэкапа, в БД отсутствуют.
   - В течение `restore_refresh_grace_until` HMAC-валидный неистёкший токен с неизвестным `tid` принимается, если строка устройства `(did, sub)` существует. Прежние токены устройства удаляются, выпускается новое семейство.
   - После окна такой токен даёт `401 session_revoked` → `AuthRequired`. Данные на клиенте при этом не трогаются.
6. **Устройства** получают `410 cursor_invalid` и проходят тихое слияние (§3.14). Поэтому данные, записанные после бэкапа, возвращаются с устройств.

   **Ограничение:** удаления и очистки истории, сделанные после бэкапа, при слиянии воскреснут. Отрицательные намерения, которые ещё лежат в outbox, не теряются (M15).
7. **Тест:** `backup → запись → restore → запись (голова обгоняет старый курсор) → старый курсор получает 410`. Выполняется на обоих диалектах и в e2e установщика.

### 3.16 Конфликты на примерах

| Случай | Итог | Механизм |
|---|---|---|
| Лайк офлайн на телефоне в 10:00, снятие лайка офлайн на ноутбуке в 11:00 | не лайкнут везде | `effAt` |
| Ноутбук видел лайк и снял его, его часы отстают | не лайкнут | `base` |
| Часы устройства «в будущем» | время зажато часами сервера | `effAt = min(at, now)` |
| Одновременный reorder разных треков | оба перемещения сохранены | регистр позиции у каждого элемента |
| A удалил плейлист, B офлайн добавил в него треки, не зная об удалении | добавления B в «(восстановлено)» | `redirected` |
| То же, но B знал об удалении | отклонено | `rejected playlist_deleted` |
| Remove на A и повторное add на B одновременно | побеждает позднее | регистр членства |
| Автосинк YouTube против более позднего ручного add | ручное add остаётся | `replace` проверяет `wins` поэлементно |
| Ответ потерян, запрос повторён | ровно одно применение | `sync_ops` / PK `play_events` |
| A очистил историю в 12:00, B офлайн слушал в 11:30 и 12:30 | в истории только 12:30, счётчик учитывает оба | знак `'*'` |
| Сервер восстановлен из бэкапа | данные вернулись с устройств, счётчики не меньше максимума | epoch, тихое слияние, `atLeast` |
| Телефон играет, на ноутбуке «Слушать здесь» | ноутбук продолжает, телефон на паузе | `handoffFrom`, SSE |
| Снимок после 8 минут офлайна, другое устройство уже играет | снимок отклонён | `newer_state` |
| Две записи одного пользователя в PG | строго по очереди | `FOR UPDATE` на `sync_heads` |
| Запись в SQLite одновременно с CLI | CLI ждёт до 5 с | `BEGIN IMMEDIATE`, `busy_timeout` |

### 3.17 Обязательные правки Android (до включения синхронизации)
1. **Лайк в плеере:** убрать побочную запись из `SnapshotMutationPolicy` (`A/ui/screens/player/Player.kt:135-149`). Лайк ставится только через `LibraryRepository`.
2. **`A/service/PlayerService.kt:253`:** `flatMapMerge` → `flatMapLatest`. Лайк из уведомления — через репозиторий, текущее значение читать внутри транзакции.
3. **Все записи в синхронизируемые таблицы — только через DAO репозиториев**, SQLite-триггеры не используются. Сюда входят `Event`, `incrementTotalPlayTimeMs` (`A/Database.kt:373-374`), `clearEvents` и `clearEventsFor` (`:685-689`), плейлисты, лайки, закладки.
4. **Запись прослушивания** (`A/service/PlayerService.kt:461-491`) → `HistoryRepository.recordPlay`: одна транзакция, порог 5000 мс сохраняется.
5. **`history()`** (`A/Database.kt:250-265`): `max(ROWID)` заменить на `MAX(Event.timestamp) … GROUP BY songId ORDER BY lastPlayed DESC`.
6. **Операции с историей:**
   - «Очистить историю» (`A/ui/screens/settings/DatabaseSettings.kt:108`) → `history.clear`;
   - «Убрать из Quick Picks» (`A/ui/screens/home/HomeQuickPicks.kt:197`) → `history.forget`;
   - «Скрыть» (`A/ui/screens/home/HomeSongs.kt:276, 337`) → `history.forget{resetTotal:true}` без удаления `Song`.
7. **Автосинк YouTube-плейлиста** (`clearPlaylist`, `A/ui/screens/localplaylist/LocalPlaylistSongs.kt:344`): сравнивать новый список с текущим, `playlist.items.replace` ставить только при отличии.
8. **Пустой title.** `Song.title` пишется через `.orEmpty()` (`A/Database.kt:733`). Клиент шлёт `title` только непустым, сервер в любом случае делает заглушку (§3.9).
9. **Порядок строк при применении ответа.** `Song` появляется при разрешении потока (`A/service/PlayerService.kt:1440`), а при применении ответа события вставляются после треков.
10. **Сеть:**
    - синхронизация на Ktor **OkHttp**, не CIO;
    - `network_security_config` с cleartext, а политика LAN-HTTP (API §8.1) проверяется в коде;
    - targetSdk 37 (`R/app/build.gradle.kts:26`), поэтому до подключения к приватному адресу нужно запросить `ACCESS_LOCAL_NETWORK`.
11. **Токены и hwid-соль** исключить из Auto Backup (`allowBackup="true"`, `R/app/src/main/AndroidManifest.xml:48`) через `dataExtractionRules`.
12. **`PlayerService`:** добавить `onIsPlayingChanged` и `onPositionDiscontinuity(SEEK)` для публикации playback, плюс heartbeat 60 с.

---

## 4. Аккаунты, сессии, устройства, вход по QR, код восстановления

### 4.1 Логин и пароль
- **Логин.** Нормализация: `NFKC → trim → lowercase`.
  - Новый логин: `^[a-z0-9][a-z0-9._-]{1,30}[a-z0-9]$`, не из резервного списка (`admin`, `root`, `melogold`, `official`, `support`, … плюс `RESERVED_LOGINS`). Резервный отвечает `409 login_taken`.
  - При входе формат не проверяется, только длина 1..64.
- **Пароль.** NFKC до hash и до verify.
  - Новый: 8..128 символов UTF-16 и ≤ 512 байт UTF-8, плюс denylist (`melogold`, `мелоголд`, `vitune`, `music`, `музыка`, `youtube`, `playlist`, `плейлист`, частые пароли).
  - Коды отказа: `password_too_short|too_long|too_common|contains_login`. Последний — если логин от 4 символов входит в пароль.
  - Проверяемый пароль ограничен только длиной, чтобы смена политики никого не заперла.
- **argon2id** 64 МиБ / t=3 / p=1:
  - семафор `ARGON2_MAX_CONCURRENCY` (2, или 1 при RAM меньше 1 ГБ), очередь 32, при переполнении `503 server_busy{5}`;
  - `needsRehash` после успешной проверки;
  - фиктивный хеш для неизвестного логина через тот же семафор (`C/modules/auth/security.service.ts:147-163`).
- **Троттлинг входа** в БД (`auth_throttle`, scope `login`, ключ — нормализованный логин):
  - окно 15 мин, 5 бесплатных неудач, дальше `min(30 с·2^(n−6), 15 мин)`, ответ `429 login_throttled` без вызова argon2;
  - успешный вход удаляет строку;
  - знакомый hwid (`sha256(hwid)` совпадает с устройством пользователя) блокировку по логину обходит.
- **Повторная проверка пароля** в чувствительных действиях: `auth_throttle(scope='reauth', key=userId)`, 5 неудач → 15 мин.

### 4.2 Регистрация
- **Режимы `REGISTRATION`:**
  - `open`;
  - `closed`: аккаунты создаёт только CLI;
  - `first`: по умолчанию. Регистрация открыта, пока нет `server_meta.first_user_id`. Его ставит **любое** создание пользователя, в том числе CLI, через `INSERT … ON CONFLICT DO NOTHING RETURNING`. Нет строки в `RETURNING` → `403 registration_closed`.
- **Установщик создаёт аккаунт владельца через CLI до публикации порта и старта Caddy** (M8). Иначе бот из CT-логов займёт первый слот.
- **Proof-of-work** (M9):
  - включён, если `REGISTRATION_POW_BITS > 0` или за последний час регистраций больше `REGISTRATION_POW_SOFT_PER_HOUR`. Во втором случае сложность +4 бита, при двойном превышении +8; если база 0, включается с 16 битами;
  - клиент берёт `GET /auth/register/challenge` и ищет `nonce`, при котором `sha256(challenge + ":" + nonce)` имеет не меньше `bits` ведущих нулевых битов;
  - вызов одноразовый (TTL 10 мин). Без решения → `403 pow_required`;
  - жёсткого глобального 429 нет, поэтому один атакующий не может закрыть регистрацию всем;
  - официальный сервер: база 18 бит (около 0,2–1 с на телефоне).
- **Порядок проверок:**
  1. режим;
  2. PoW;
  3. схема и формат логина;
  4. резерв или занятость → `login_taken`;
  5. политика пароля;
  6. argon2 вне транзакции;
  7. одна транзакция: `first_user_id` → `users` (`ON CONFLICT (login) DO NOTHING RETURNING`, нет строки → `login_taken`) → `devices(linked_via='register')` → `refresh_tokens` → `sync_heads`.
- **Ограничения** ловятся только через `ON CONFLICT` или на границе транзакции (M11): в PG ошибка внутри транзакции обрывает её (25P02).

### 4.3 Access-токен и guard
- **JWT HS256**, claims `{sub, did, av, rid, iat, exp}`, TTL 900 с. `rid` — `tid` refresh-токена, вместе с которым выдан этот access. Ключ выводится через HKDF из секрета (§4.13).
- **Guard** — глобальный `onRequest` на всех непубличных маршрутах, включая SSE до hijack:
  1. нет `Bearer` → `401 unauthorized`;
  2. подпись или формат неверны → `401 access_token_invalid`; истёк → `access_token_expired`;
  3. один запрос `devices ⋈ users` по `did`, `sub` и `users.deleted_at IS NULL`. Нет строки → `401 session_revoked`;
  4. `auth_version ≠ av` → `401 access_token_expired`;
  5. **подтверждение `rid`:** если `rid` нет в LRU-наборе процесса, выполняется `UPDATE refresh_tokens SET confirmed_at=now WHERE id=rid AND confirmed_at IS NULL`, и `rid` добавляется в набор. Ошибка этой записи запрос не валит;
  6. `last_seen_at` обновляется не чаще раза в 5 мин.
- На Bearer-маршрутах код 401 означает только проблему токена или сессии. Неверный пароль при повторной проверке — `403 invalid_password`.

### 4.4 Refresh: ротация и кража (M3)
- **Формат:** `mgrt1.<b64url(JSON{typ,tid,sub,did,exp})>.<b64url(HMAC)>`, как `C/modules/auth/refresh-token.service.ts:324-501`, но с другим префиксом.
  - Токен детерминирован: одна и та же строка БД даёт ту же строку токена.
  - В БД хранится `sha256(token)`.
  - Срок скользящий: 90 дней с каждой ротации.

```ts
async function refresh(ctx, presented: string, device: DevicePatch /* hwid обязателен */) {
  const p = parseRefresh(presented, ctx.keys.refresh);          // HMAC + exp; иначе 401 invalid_refresh_token
  const out = await ctx.db.write(async (q) => {
    const now = ctx.clock.now();
    const row = await getToken(q, p.tid);
    if (!row) return (await restoreGrace(q, p, device, now)) ?? { fail: "session_revoked" };   // §3.15 п. 5
    if (!matches(p, row) || !eqHash(sha256(presented), row.token_hash)) return { fail: "invalid_refresh_token" };
    const dev = await getDevice(q, row.device_id);
    if (sha256(device.hwid) !== dev.hwid_hash) return { fail: "device_mismatch" };            // без удаления
    if (row.rotated_to_id === null && row.revoked_at === null && row.expires_at > now) {
      const succ = await casRotate(q, row, now);               // UPDATE … WHERE id=? AND rotated_to_id IS NULL AND revoked_at IS NULL
      if (succ) { await touchDevice(q, dev, device, now); return { ok: succ }; }
    }
    const cur = await getToken(q, row.id);
    if (cur.rotated_to_id && cur.rotation_grace_expires_at! > now) {
      const s = await getToken(q, cur.rotated_to_id);
      if (s && !s.rotated_to_id && !s.revoked_at && s.confirmed_at === null && s.expires_at > now)
        return { ok: s };                                      // ответ действительно потерян
      return { fail: "refresh_token_reused", removed: await removeDevicesInTx(q, row.user_id, [row.device_id], "token_reuse") };
    }
    return { fail: "invalid_refresh_token" };
  });
  if (out.removed) ctx.devices.afterRemove(out.removed);       // SSE + closeDevice строго после commit
  if (out.fail) throw new AppError(401, out.fail);
  return issueTokens(out.ok);                                   // новый access с rid = out.ok.id
}
```

**Обязанности клиента:**
- refresh выполняется single-flight, проактивно за 60 с до истечения;
- **новый refresh-токен сохраняется до первого запроса с новым access-токеном**. Иначе после краха между этими шагами старый токен будет признан кражей;
- `device.hwid` в теле refresh обязателен.

Сессия стирается **только** при 401 от refresh. Сетевые ошибки и 5xx её не трогают.

### 4.5 Logout (M4)
`POST /auth/logout {refreshToken}` всегда отвечает 204.
- Токен разбирается по HMAC без проверки срока.
- Устройство удаляется **только если** строка с этим `tid` существует, `token_hash` совпал, и токен либо текущий (`rotated_to_id IS NULL AND revoked_at IS NULL`), либо ещё в окне grace. Иначе ничего не происходит.
- После commit: `closeDevice`, остальным `devices.updated{device_signed_out}`.

### 4.6 Устройства и hwid
- **hwid** = `hex(sha256("melogold-hwid-v1|" + platformId + "|" + serverId))`, для каждого сервера свой.

  | Платформа | `platformId` |
  |---|---|
  | Android | `ANDROID_ID` (у сборок F-Droid и GitHub разные подписи, поэтому это разные устройства) |
  | macOS | `IOPlatformUUID` |
  | Windows | `MachineGuid + "|" + installSalt` |
  | Linux | `/etc/machine-id + "|" + installSalt` |

  - `installSalt` — случайный UUID, создаётся при первом запуске в данных приложения. Защищает от клонированных ВМ с общим `machine-id` (m29).
  - Запасной вариант на всех платформах — случайный UUID в приватном хранилище, исключённом из бэкапов.
  - Векторы: `spec/hwid.vectors.json`.
- **Вход с уже известным `(user, sha256(hwid))`:**
  - строка устройства переиспользуется, её токены удаляются, выпускается новое семейство;
  - лимит `MAX_DEVICES_PER_USER` (20) не проверяется.
- **Новое устройство** создаётся под `lockUser` с проверкой лимита: `409 device_limit_reached`.
- **`platform`** в запросе — `^[a-z0-9_]{1,16}$`, хранится как пришло.
  - Известные значения: `android`, `macos`, `windows`, `linux`, `other`.
  - Клиенты переживают неизвестные значения. CHECK по списку в БД нет (M19).
- **Удаление устройства** и есть отзыв сессии. Единый путь `removeDevicesInTx`:
  1. `UPDATE device_links SET status='cancelled'` для незавершённых привязок, где устройство одобряющее;
  2. `DELETE devices`, токены удаляются каскадом;
  3. после commit `afterRemove`: адресный `session.invalidated{reason}` → `live.closeDevice` → `devices.updated` остальным.

  Этим путём идут revoke, revoke-others, logout, token reuse, recover, удаление аккаунта, CLI и очистка неактивных устройств.
- **Неактивные устройства** удаляются через `DEVICE_INACTIVE_DAYS` (180), если у них нет живого refresh-токена.
- **В списке всегда видны** `createdAt`, `linkedVia`, `linkedByDeviceId`, `recentUntil`.

### 4.7 SSE и отзыв (M5)
Поток закрывается сервером в следующих случаях:
- **в момент `exp`** access-токена, которым он открыт. Клиент заранее, после проактивного refresh, открывает новый поток и закрывает старый (make-before-break);
- после `session.invalidated` своего устройства и в `closeDevice`;
- при росте `auth_version` у пользователя;
- **на каждом heartbeat** хаб пакетно проверяет `devices.id IN (…)` вместе с `auth_version` и `deleted_at`. Так ловятся изменения из CLI в соседнем процессе и из фоновых задач:
  - нет устройства → `session.invalidated{device_revoked}` и закрытие;
  - другой `av` → закрытие без события;
- при останове сервера.

**Ограничения:**
- не больше 4 потоков на устройство, при превышении вытесняется самый старый;
- не больше 64 на пользователя.

**Переподключение:** после закрытия сервером (кроме закрытия по `exp`) первая попытка через случайные 0–15 с, дальше 1, 2, 5, 10, 30 с и до 5 мин с jitter.

### 4.8 Матрица чувствительных действий
**Решение владельца продукта (2026-09-23):** пароль можно сменить **с любого вошедшего устройства, в том числе без старого пароля**. Механизма «кулдауна» и порога возраста устройства нет. Принятый риск: тот, кто завладел разблокированным устройством, может сменить пароль; владелец видит это по уведомлению на остальных устройствах и отзывает чужое устройство, а при полной потере доступа восстанавливает аккаунт кодом восстановления.

**Определение:** `recent(d)`: `d.linked_via ∉ {register, recovery}` и `now < d.created_at + NEW_DEVICE_RESTRICT_HOURS` (24 ч). Правило действует для **любого** нового устройства, в том числе созданного через login.

| Действие | Разрешено | Ограничения |
|---|---|---|
| Переименовать своё устройство | всегда | — |
| Переименовать или отозвать чужое устройство `t` | вошедшее устройство | при `recent(me) ∧ t.created_at < me.created_at` нужен пароль (`403 recent_device_restricted`) |
| `revoke-others` | то же для каждой цели | при 403 для любой цели ни одно устройство не удаляется |
| Смена пароля со старым | любое вошедшее | неверный старый → `403 invalid_password` |
| Смена пароля без старого | любое вошедшее | остальным уходит `account.updated{password_changed_without_old}` |
| Новый код восстановления | пароль | — |
| Удаление аккаунта | пароль | — |
| Одобрение привязки | вошедшее | новое устройство 24 ч считается `recent` |
| Восстановление кодом | код | удаляет все устройства |

**Интерфейс:** карточка по `account.updated{password_changed_without_old}` с кнопкой «Это не я → отозвать устройство X».

### 4.9 Код восстановления
- **Формат:** 20 символов Crockford Base32, `XXXX-XXXX-XXXX-XXXX-XXXX`, 100 бит. Генерация: `randomBytes(20)[i] % 32`, смещения нет.
- **Хранение:** `sha256("melogold-recovery-v1:" + code)`. Сравнение за постоянное время, для неизвестного логина — с фиктивным хешем.
- **Когда показывается:** один раз, после register, recover, перевыпуска и в CLI.
- **`recoveryCodeStatus.confirmed`** выставляется по кнопке «Я сохранил» (`/confirm` с `createdAt`).
- **`/auth/recover`**, порядок проверок: политика пароля → код (CAS `WHERE recovery_code_hash=:old`) → argon2 (до транзакции).
  - Итог: новый хеш пароля, `auth_version+1`, новый код, **все устройства удалены**, создано новое с `linked_via='recovery'`.
  - После commit `session.invalidated{recovery_reset}` бывшим устройствам.
- **Защита от перебора:** 20 попыток в час на IP (/56), ответ одинаков для неизвестного логина и неверного кода. Блокировки по логину нет: она дала бы DoS восстановления жертве.
- **Клиенты кода не хранят.**
  - Файл `melogold-recovery-<login>.txt` содержит сервер, логин, код и дату.
  - Android 13+ помечает буфер как sensitive и очищает его через 60 с.
- **Потеряны пароль, код и все устройства:**
  - официальный сервер восстановить аккаунт не может;
  - self-host: администратор выполняет `melogold user reset-password`.

### 4.10 Привязка устройства по QR или коду через сервер

#### 4.10.1 Режимы

| Кто вошёл | Новое устройство | Режим |
|---|---|---|
| Телефон (есть камера) | Десктоп | `request`: новое показывает QR, телефон сканирует |
| Десктоп | Телефон | `invite`: десктоп показывает QR, телефон сканирует, адрес сервера настраивается сам |
| Без камеры | любое | ввод `userCode` (`XXXX-XXXX`) |

В режиме `request` новое устройство заранее выбирает сервер: «Официальный» или «Свой: ___».

#### 4.10.2 Секреты
- `linkToken`: 32 байта, 43 символа, в QR.
- `userCode`: 40 бит, для ручного ввода.
- `pollSecret` (`mgps_…`): только у нового устройства, **без него токены не выдаются**.
- Все три хранятся как sha256.

#### 4.10.3 Состояния
```
create → pending ─(resolve в request | claim в invite: закрепить вторую сторону, сгенерировать verifyCode)→ claimed
claimed ─approve{verifyCode верный}→ approved ─poll (CAS)→ completed
claimed ─deny | approve{verifyCode неверный}→ denied;  любое нефинальное ─cancel→ cancelled
expires_at ≤ now ⇒ expired (вычисляется, в БД не пишется); TTL 300 с
```

#### 4.10.4 Сверка числа (M2)
- При `claimed` сервер выбирает `verifyCode` из двух цифр. **Новое** устройство его показывает: `LinkClaimed.verifyCode` в invite, `LinkPollResponse.verifyCode` в request.
- Карточка одобрения (`GET /auth/me/links/{id}`) даёт три варианта `verifyChoices`. Пользователь выбирает число, которое видит на новом устройстве.
- Неверный выбор → `denied` и `409 link_verify_mismatch`. Начинать нужно заново.
- Текст карточки:
  > «Выберите число, которое показывает новое устройство. Если новое устройство показало „код уже использован“ — отклоните: кто-то перехватил код.»

#### 4.10.5 Защита от фишинга
- Сфотографированный QR сессии не даёт: нужен `pollSecret`.
- Одобрение только явное:
  - имя, платформа, ОС, версия с пометкой «сообщает о себе»;
  - «создано N с назад»;
  - кнопка «Разрешить» активна через 2 с.
- Подсказка `sameNetwork`: IPv4 сравнивается целиком, IPv6 по /56.
  - Формулировки только нейтральные: «в той же сети» или «в другой сети». Слова «безопасно» нет (m6).
  - `LINK_NETWORK_HINT=false` (режим `lan`, где docker-proxy скрывает адреса) даёт `null`.
- Новое устройство видит логин аккаунта и **до первой синхронизации** подтверждает «Вы вошли как @maxim».
- `serverId` сверяется с обеих сторон, а сервер подтверждается на новом устройстве.
- **Deep link (M1).** Обработчик схемы `melogold` принимает:
  - `melogold://server` → экран «Свой сервер» с подтверждением;
  - `melogold://link?mode=invite` → экран «Войти с другого устройства» с заполненным сервером и **явной** кнопкой «Подключиться», без автоматического claim.

  `mode=request` из deep link не выполняется, показывается инструкция «Откройте Melogold → Добавить устройство → Сканировать». Режим `request` принимается только из камеры или ручного ввода внутри экрана «Добавить устройство».
- Перебор кодов: пространство 40 бит, TTL 5 мин, 30 попыток за 10 мин на IP /56, нужно одобрение. Подобрать код за это время практически невозможно.

#### 4.10.6 Завершение (атомарно, ровно один раз)
Выполняется внутри `poll` при статусе `approved`:
1. CAS `UPDATE … SET status='completed' WHERE poll_secret_hash=? AND status='approved' AND expires_at>now`.
2. Проверить одобряющее устройство: удалено → `410 link_cancelled`.
3. `lockUser`, проверка лимита.
4. UPSERT `devices` (`linked_via='link'`, `linked_by_device_id`).
5. Новый refresh, `result_refresh_id`.
6. Стереть `*_net` и `claimant_*`.

После commit `devices.updated{device_added}`. Устройство появляется **только** здесь.

**Повторный poll (m3).** В течение 60 с после `completed` тот же `pollSecret` повторно выдаёт сессию. Refresh-токен переподписывается из строки `result_refresh_id`, если он ещё не ротирован и не отозван. Иначе `410 link_expired`.

**Long-poll** держится в памяти процесса: `Map<linkId, Set<wake>>`. Любое действие будит ожидающих, SIGTERM будит всех.

### 4.11 Удаление аккаунта и экспорт
- **`POST /auth/me/delete {password}`.** Одна короткая транзакция под `lockUser`:
  1. `users.deleted_at = now`;
  2. `login = '!deleted:' || id`: логин освобождается сразу;
  3. `password_hash='!'`, `auth_version+1`;
  4. `removeDevicesInTx` для всех устройств;
  5. `DELETE device_links, playback_state` пользователя.

  После commit `session.invalidated{account_deleted}` и `closeUser`. Задача `account-purge` (каждые 15 мин) удаляет дочерние строки пачками по 5000 на транзакцию, затем строку `users`. Данные остаются в бэкапах до их ротации: у официального сервера 30 дней.
- **`GET /auth/me/export`:**
  - потоковый JSON, собирается keyset-страницами в коротких read-транзакциях. Это **не атомарный снимок**, так и указано в документации;
  - при квотах §3.10 размер не больше ~64 МБ;
  - секретов нет (хешей, токенов, hwid);
  - 3 запроса в час.

### 4.12 Фоновая очистка auth (ежечасно, пачками по 1000)
- **`refresh_tokens`:** удаляются, если `expires_at < now−1д` или если строка отозвана и её окно grace закончилось больше суток назад.
- **`device_links`:** удаляются, если `expires_at < now−1ч`.
- **`auth_throttle`:** удаляются строки старше суток без активной блокировки.
- **Неактивные устройства** удаляются через `removeDevicesInTx`.

### 4.13 Секрет сервера (M7, m22)
- **Источник мастер-ключа (32 байта):**
  - `MELOGOLD_SECRET_KEY` (64 hex), если задан;
  - иначе `/data/secret.key` (0600). Файл создаётся при любом старте, если его нет.

  Если env задан и отличается от файла, в лог пишется `warn`: при удалении env будет использован файл, и все сессии завершатся.
- **Производные ключи:** `HKDF-SHA256(ikm=key, salt=serverId, info)`, `info` = `melogold/jwt-access/v1`, `melogold/refresh-token/v1`, `melogold/pow/v1`.
- **В БД ключа нет.**
- **Бэкап** включает ключ только с `--with-secrets`, и тогда шифрование через `age` обязательно.
- **`melogold secret rotate`** пишет новый файл. Хостовый CLI после этого делает `up -d --force-recreate`. Все пользователи перелогинятся, данные и коды восстановления не затрагиваются.

---

## 5. API

Точный контракт — `docs/API.md`: соглашения, ошибки, схемы с примерами, SSE, QR, DDL, env. Машиночитаемый — `GET /openapi.json` и ассеты релиза `openapi.json`, `openapi.yaml`, `error-codes.json`.

| # | Метод и путь | Auth | Назначение |
|---|---|---|---|
| 1 | `GET /` | public | HTML-страница для камеры телефона |
| 2–4 | `GET /health`, `/health/live`, `/openapi.json` | public | readiness, liveness, спецификация |
| 5 | `GET /server/info` | public | discovery, `serverId`, функции, лимиты |
| 6 | `GET /auth/register/challenge` | public | вызов PoW |
| 7 | `POST /auth/register` | public | аккаунт + устройство + код восстановления |
| 8 | `POST /auth/login` | public | вход |
| 9 | `POST /auth/refresh` | refresh | ротация |
| 10 | `POST /auth/logout` | refresh | удалить своё устройство |
| 11 | `POST /auth/recover` | public | сброс пароля кодом |
| 12–15 | `POST /auth/link/{requests,claim,poll,cancel}` | public / pollSecret | сторона нового устройства |
| 16 | `GET /auth/me` | Bearer | профиль |
| 17 | `GET /auth/me/events` | Bearer | SSE |
| 18–21 | `GET /auth/me/devices`, `PATCH …/{id}`, `POST …/{id}/revoke`, `POST …/revoke-others` | Bearer | устройства |
| 22–26 | `POST /auth/me/password`, `/recovery-code`, `/recovery-code/confirm`, `/delete`, `GET /auth/me/export` | Bearer | аккаунт |
| 27–32 | `POST /auth/me/links`, `/resolve`, `GET /{id}`, `POST /{id}/{approve,deny,cancel}` | Bearer | сторона вошедшего устройства |
| 33–35 | `GET /sync/summary`, `POST /sync/merge-plan`, `POST /sync` | Bearer + `X-Sync-Protocol` | синхронизация |
| 36–38 | `GET/PUT/DELETE /playback/state` | Bearer + `X-Sync-Protocol` | продолжить на другом устройстве |

---

## 6. Стек и структура репозитория

### 6.1 Версии (сентябрь 2026)

| Компонент | Версия | Примечание |
|---|---|---|
| Node | 24 LTS (24.21) | до 30.04.2028. Переход на 26 после его выхода в LTS (28.10.2026), это смена `ARG` |
| TypeScript | 6.0.x, только typecheck | `erasableSyntaxOnly`: без `enum`, декораторов, parameter properties |
| Fastify | 5.12 | плюс `@fastify/{swagger 9.9, rate-limit 11.2, jwt 10.2, helmet 13, cors 11, compress 9}` |
| zod | 4.6 | `fastify-type-provider-zod` 7.0 |
| Kysely | `~0.29.6` | `Migrator` из `kysely/migration` |
| better-sqlite3 | `^13.0.3` | prebuilds внутри пакета, SQLite 3.53.x |
| pg | 8.23 | `setTypeParser(20)`: int8 → number с проверкой |
| argon2 | 0.45 | PHC, `needsRehash` |
| close-with-grace | 2.5 | остановка |
| Тесты | `node:test` | `app.inject` |
| Линт | ESLint 10, typescript-eslint 8 (type-checked), Prettier 3 | — |

`node:sqlite` как второй драйвер — v1.1 (M18).

### 6.2 Слой БД (правила, полностью — в `docs/database.md`)

**Диалекты и транзакции:**
- Диалект выбирается по `DATABASE_URL`: `sqlite:///path`, `sqlite::memory:` (только тесты и генерация OpenAPI), `postgres://` или `postgresql://`.
- `db.write(fn)`:
  - PG: `READ COMMITTED`;
  - SQLite: `BEGIN IMMEDIATE`, через свой `SqliteDriver.beginTransaction`.
- `db.read(fn)` **всегда** выставляет access mode `read only` (m8):
  - PG: `REPEATABLE READ READ ONLY`;
  - SQLite: `BEGIN` (снимок WAL).
- `db.run(fn)` — одиночный запрос. Вложенные `read`/`write`/`run` бросают ошибку (проверка через `AsyncLocalStorage`): в SQLite они дали бы вечное ожидание мьютекса.
- `lockUser(q, userId)` — **первый оператор** каждой сериализуемой записи пользователя: `SELECT … FROM sync_heads … FOR UPDATE`. В SQLite плагин `StripRowLocksPlugin` вырезает `FOR UPDATE`, эксклюзивность обеспечивает `BEGIN IMMEDIATE`. Строка `sync_heads` создаётся при регистрации, в CLI и backfill-миграцией. Подстраховка — `ensureHead` короткой пишущей транзакцией (m7).
- Миграции:
  - SQLite: `supportsTransactionalDdl=true` через переопределение адаптера, весь прогон в одной транзакции;
  - PG: advisory lock Kysely.

**Типы (M10, m9):**
- Логические типы: `ID`, `TXT`, `INT`, `BIG`, `TS`, `BOOL`, `JSON` (API §9.1).
- **Все идентификаторы — `ID` = `text COLLATE "C"`** (PG) / `TEXT` (SQLite).
- Таблицы SQLite создаются `STRICT`, поэтому допустимы только `INTEGER`, `TEXT`, `REAL`, `BLOB`, `ANY`.
- Типы колонок задаёт только помощник `ddl(dialect)`. Lint запрещает литеральные типы в миграциях.
- IN-CHECK только у `BOOL`. Остальные перечисления проверяет zod (M19).

**SQL:**
- **Ошибки ограничений** (M11):
  - нарушения ограничений внутри транзакции не ловятся (`try { insert } catch { update }` запрещён);
  - вместо этого `ON CONFLICT … DO NOTHING|DO UPDATE` и `RETURNING`;
  - если без перехвата не обойтись — savepoint (controlled transaction Kysely) или граница транзакции;
  - есть тест.
- **Запрещено:**
  - `now()`, `gen_random_uuid()`, `random()`, триггеры, функции, `serial`, `jsonb`, массивы;
  - `GREATEST/LEAST`, `ILIKE/LIKE`, `lower()`;
  - JSON- и date-функции;
  - `UNION ALL` с `LIMIT` в ветках;
  - `ORDER BY` по человеческому тексту;
  - пустой `IN ()`.
- Пачки: вставки по 500 строк, `IN` по 1000 значений, `DELETE` по 5000 строк на транзакцию.
- Бюджет транзакции 2 с. Внутри транзакции нет сети, argon2 и `await` чего-либо, кроме `q`.

**Ошибки драйверов (m10)** переводит в коды только `src/db/errors.ts`. Сырые ошибки дают `500 internal_error`, кроме перечисленных:

| Ошибка | Ответ |
|---|---|
| PG `40P01`, `40001`, `55P03`, `57014`, `53300`; SQLite `BUSY` | `503 server_busy` + `Retry-After` |
| PG `08xxx`, `57P01` | `503 unavailable` |
| PG `53100`; SQLite `FULL` | `503 storage_full` |

**Схема при старте (m23):**
- Интроспекция таблиц, колонок и nullable сверяется с `src/db/schema.snapshot.json`. Расхождение → выход с кодом 1. `SCHEMA_CHECK=warn` понижает это до предупреждения.
- **Миграции замораживаются с первого деплоя в любую живую БД**, включая `v0.1.0-rc.1` на официальном сервере. Дальше — только новые файлы.
- Если применены неизвестные коду миграции, а все известные тоже применены (откат образа), это `warn`, и `migrateToLatest` не вызывается.

### 6.3 Структура репозитория
```
melogoldServer/
├─ AGENTS.md  README.md  LICENSE  package.json  package-lock.json  tsconfig.json  eslint.config.js
├─ .prettierrc.json  .editorconfig  .gitattributes (*.sh, deploy/**, docker/melogold → eol=lf)  .node-version  .dockerignore
├─ Dockerfile  compose.dev.yml  docker/melogold                   # лаунчер #!/nodejs/bin/node
├─ .github/workflows/{ci.yml, image.yml, release.yml, deploy-official.yml}  .github/dependabot.yml
├─ deploy/installer/{install.sh.in, build.sh}
├─ deploy/templates/{compose.yaml, Caddyfile.domain, env.example, melogold, melogold-backup.service, melogold-backup.timer}
├─ deploy/official/{harden-vps.sh, bootstrap-official.sh, daemon.json, 52melogold-unattended, ci-entry.sh,
│                   offsite-backup.sh, restore-check.sh, melogold-offsite.{service,timer}, melogold-restore-check.{service,timer}, backup.env.example}
├─ docs/{DESIGN.md, API.md, PLAN.md, database.md, self-hosting.md, operations.md, security.md, UPGRADING.md,
│        schema.sqlite.sql, schema.postgres.sql}                    # schema.*.sql генерируются из миграций
├─ openapi/{openapi.json, openapi.yaml}                            # генерируются и коммитятся
├─ spec/{LICENSE, error-codes.json, playlist-ops.vectors.json, history-totals.vectors.json, playback-rules.vectors.json,
│        pow.vectors.json, hwid.vectors.json, sync-scenarios/{library,playlists,history}.json}
├─ scripts/{gen-openapi.ts, gen-error-codes.ts, gen-schema-sql.ts, smoke.sh, bench/}
└─ src/
   ├─ main.ts (serve | CLI, CLI не импортирует fastify)  server.ts  app.ts  context.ts  healthcheck.ts
   ├─ cli/{index.ts, commands/*.ts}
   ├─ config/{env.ts, secret-key.ts}
   ├─ db/{index.ts, tx.ts, types.ts, ddl.ts, dialect-sqlite.ts, dialect-postgres.ts, plugins.ts, errors.ts, codecs.ts,
   │      batch.ts, heads.ts, migrate.ts, schema-check.ts, schema.snapshot.json, migrations/{index.ts, 0001_core.ts … 0005_history.ts}}
   ├─ http/{errors.ts, error-codes.ts, error-handler.ts, auth-guard.ts, sanitize.ts, rate-limit.ts, client-ip.ts,
   │        openapi.ts, logging.ts, disk-guard.ts}
   ├─ contract/{common.ts, server.ts, auth.ts, devices.ts, account.ts, linking.ts, sync.ts, playback.ts, live.ts}   # zod DTO
   ├─ lib/{clock.ts, ids.ts, crypto.ts, time.ts, strings.ts, semaphore.ts, tokens.ts, session.ts, device-removal.ts}
   ├─ jobs/{scheduler.ts, index.ts}
   ├─ modules/
   │  ├─ server/{server.routes.ts, server.service.ts, landing.ts}
   │  ├─ security/policy.ts                                         # чистые функции §4.8
   │  ├─ auth/{auth.routes.ts, auth.service.ts, refresh.service.ts, password.ts, argon2-pool.ts, throttle.ts, pow.ts, auth.repository.ts}
   │  ├─ devices/{devices.routes.ts, devices.service.ts, devices.repository.ts}
   │  ├─ account/{account.routes.ts, account.service.ts, recovery-code.ts, export.ts, purge.job.ts}
   │  ├─ linking/{linking.routes.ts, linking.service.ts, linking.repository.ts, long-poll.ts}
   │  ├─ live/{live.routes.ts, live.hub.ts, live.events.ts, revalidate.ts}
   │  ├─ sync/{sync.routes.ts, sync.service.ts, cursor.ts, wins.ts, page.ts, quotas.ts, tracks.ts, lenient.ts, summary.ts,
   │  │        ops/{index.ts, types.ts, like-set.ts, bookmark-set.ts, playlist-*.ts, play-add.ts, play-baseline.ts,
   │  │             history-clear.ts, history-forget.ts},
   │  │        playlists/{sort-keys.ts, lis.ts, anchors.ts, recovery.ts, merge-plan.ts}, history/retention.job.ts}
   │  ├─ playback/{playback.routes.ts, playback.service.ts, playback.repository.ts, playback.job.ts}
   │  └─ maintenance/{auth-cleanup.job.ts, sqlite-maintenance.job.ts, backup.ts, restore.ts, rotate-epoch.ts, verify-release.ts}
   └─ test/{test-db.ts, test-app.ts, factories.ts, contract/*.test.ts}
```

**Слои модуля:**
- `routes`: только схемы и вызов сервиса.
- `service`: логика, `ctx.db.write/read`, `AppError` с кодом, SSE **после** commit.
- `repository`: `(q, …)` только по своим таблицам.

**Правила импорта (ESLint `no-restricted-imports`):**
- `kysely` — только в `db/**`, `*.repository.ts`, `sync/**`, `migrations/**`;
- репозиторий чужого модуля импортировать нельзя;
- `process.env` читается только в `config/env.ts`, `test/test-db.ts`, `scripts/`.

**Реестр кодов ошибок:**
- `http/error-codes.ts` → `spec/error-codes.json`;
- клиенты ветвятся **только** по `code`.

---

## 7. Упаковка: Docker, установка одной командой, обновление, бэкап

### 7.1 Образ (нормативный Dockerfile, m26)
```dockerfile
# syntax=docker/dockerfile:1.10
ARG NODE_MAJOR=24
# deps собирается на ЦЕЛЕВОЙ платформе (нативные раннеры amd64/arm64), glibc = debian13
FROM node:${NODE_MAJOR}-trixie-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN --mount=type=cache,target=/root/.npm npm ci --omit=dev --ignore-scripts \
 && node --input-type=module -e "await import('better-sqlite3'); await import('argon2')" \
 && mkdir -p /skel/data/.tmp

FROM gcr.io/distroless/nodejs${NODE_MAJOR}-debian13:nonroot
WORKDIR /app
ENV NODE_ENV=production TZ=UTC HOST=0.0.0.0 PORT=8080 DATA_DIR=/data DATABASE_URL=sqlite:///data/melogold.db
COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY src ./src
COPY openapi ./openapi
COPY --from=deps --chown=65532:65532 /skel/data /data
COPY --chmod=755 docker/melogold /usr/local/bin/melogold
ARG APP_VERSION=0.0.0-dev
ARG GIT_SHA=unknown
ENV APP_VERSION=$APP_VERSION GIT_SHA=$GIT_SHA
LABEL org.opencontainers.image.source="https://github.com/melogold-app/melogoldServer" \
      org.opencontainers.image.licenses="AGPL-3.0-only" app.melogold.compose-schema="1"
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --start-period=60s --start-interval=2s --retries=3 \
  CMD ["/nodejs/bin/node", "/app/src/healthcheck.ts"]
ENTRYPOINT ["/usr/local/bin/melogold"]
CMD ["serve"]
```
- **`docker/melogold`:**
  ```
  #!/nodejs/bin/node
  import("/app/src/main.ts").then((m) => m.main(process.argv.slice(2)));
  ```
  Файл без расширения исполняется как CJS, а `import()` загружает TS через type stripping. `serve` запускает сервер, остальные команды — CLI без fastify.
- **`--ignore-scripts` безопасен** (m25): у better-sqlite3 13.0.3 `gypfile:false` и prebuilds в пакете, argon2 находит свой prebuild при загрузке. Проверка — шаг `import` в стадии `deps`.
- **`VOLUME` не объявляется.** Приложение по `/proc/self/mountinfo` проверяет, что `/data` смонтирован, и громко предупреждает, если нет.
- **`.dockerignore`** исключает тесты, `spec/`, `docs/`, `deploy/`, `.git`, `node_modules`.
- **Цель по размеру:** меньше 80 МБ сжатого образа.

### 7.2 compose (шаблон `deploy/templates/compose.yaml`, основное)
- **Сервис `app`:**
  - `image: ${MELOGOLD_IMAGE}` — точный тег@digest;
  - `init: true`, `read_only: true`, `tmpfs /tmp`, `cap_drop: [ALL]`, `no-new-privileges`;
  - том `data:/data`;
  - `ports: ["${APP_BIND:-127.0.0.1}:${APP_PORT:-8080}:8080"]`;
  - `mem_limit: ${APP_MEM_LIMIT:-512m}`, `NODE_OPTIONS=--max-old-space-size=${APP_HEAP_MB:-192}` (M17);
  - `oom_score_adj: 300`, `stop_grace_period: 20s`, logging `local` 10m×3;
  - environment: `DATABASE_URL`, `PUBLIC_URL`, `INSTANCE_NAME`, **`REGISTRATION: ${REGISTRATION:-first}`** (M8), `TRUST_PROXY`, `ARGON2_MAX_CONCURRENCY`, `REGISTRATION_POW_BITS`, `LINK_NETWORK_HINT`, `LOG_LEVEL`.
- **Сеть `default`:** фиксированная подсеть `${MELOGOLD_SUBNET:-172.30.83.0/24}`. Установщик проверяет, что она свободна.
- **`postgres`** (профиль `postgres`):
  - образ `postgres:18-trixie`, том на `/var/lib/postgresql` (раскладка PG 18);
  - `POSTGRES_INITDB_ARGS=--locale-provider=builtin --builtin-locale=C.UTF-8`;
  - `mem_limit ${PG_MEM_LIMIT:-512m}`;
  - параметры памяти из `.env`, **порт не публикуется**.
- **`caddy`** (профиль `caddy`): `caddy:2.11-alpine`, `network_mode: host`, `admin off`, `mem_limit 128m`.
- **Лимит памяти приложения:** `APP_MEM_LIMIT ≥ APP_HEAP_MB + 2·ARGON2_MEMORY + 128 МБ`. Установщик вычисляет его сам: при 192/2/64 это 512m.

**Caddyfile (режим domain):**
```caddyfile
{
	admin off
}
{$SITE} {
	encode {
		zstd
		gzip
		match {
			header Content-Type application/json*
		}
	}
	request_body {
		max_size 5MiB
	}
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	reverse_proxy 127.0.0.1:{$APP_PORT}
}
import Caddyfile.d/*.caddy
```
- `5MiB`, а не `4MB`: это 4 000 000 байт, меньше тела `/sync` (m11).
- Ответы Caddy без JSON клиенты разбирают по статусу.
- Access-лог Caddy не пишется.

**`TRUST_PROXY` (m17)** — список CIDR, а не число хопов:
- `domain` и `proxy` (приложение слушает только `127.0.0.1`, прокси на том же хосте): `127.0.0.1/32,::1/128,<MELOGOLD_SUBNET>`. docker-proxy подключается к контейнеру с адреса шлюза подсети.
- `lan`: пусто. Все клиенты видны через шлюз, `LINK_NETWORK_HINT=false`.
- Удалённый обратный прокси в MVP не поддерживается (лимиты по IP не работают). В `docs/self-hosting.md` описан `docker run --network host` с `TRUST_PROXY=<IP прокси>`.

### 7.3 Установка одной командой
```
curl -fsSL https://get.melogold.app | sh                                              # интерактивно
curl -fsSL https://get.melogold.app | sudo sh -s -- --domain music.example.com --admin-login maxim --yes
curl -fsSL https://get.melogold.app | sh -s -- --lan --admin-login maxim --yes
curl -fsSL https://get.melogold.app | sh -s -- --proxy --public-url https://m.example.com --port 8080 --yes
curl -fsSL https://get.melogold.app | sudo sh -s -- --restore ./melogold-backup-….tar.gz
```
- Запасной адрес: `https://github.com/melogold-app/melogoldServer/releases/latest/download/install.sh`.
- Один POSIX-sh файл, весь код в функциях, последняя строка — `main "$@"`.

**Флаги:**
- `--dir`, `--owner`;
- `--domain FQDN | --lan | --proxy`;
- `--port`, `--public-url`;
- `--db sqlite|postgres`, `--database-url`;
- `--registration first|open|closed`, `--admin-login`, `--name`;
- `--version`, `--image`;
- `--install-docker`, `--yes`, `--no-start`, `--no-backup-timer`, `--no-qr`, `--allow-public-http`, `--lang ru|en`;
- действия: `--upgrade`, `--reconfigure`, `--repair`, `--uninstall [--purge]`, `--restore FILE`.

**Шаги:**
1. **Платформа:** Linux x86_64 или aarch64 (armv7 — отказ). macOS только `--lan` для тестов.
2. **Права:** root → `/opt/melogold` и systemd-таймер, иначе `~/melogold` и cron.
3. **Существующая установка** (`$DIR/.env` есть) → меню или `--repair`.
   - Если **тома `melogold_data`/`melogold_pgdata` есть, а `.env` нет** (m24), секреты не перегенерируются. Установщик останавливается и предлагает `--restore` или восстановить `.env`.
   - Процедура сброса пароля PG описана в `docs/operations.md`.
4. **Docker:** Engine ≥ 24, Compose ≥ 2.20.2. Установка через get.docker.com — только с согласия пользователя.
5. **Предпроверки:** RAM, диск, NTP, свободные порты. Если 80/443 заняты, предлагается `--proxy`.
6. **Режим:**
   - `domain`: DNS сверяется с адресами хоста. Несовпадение — предупреждение.
   - `lan`: IP берётся из `ip route get 1.1.1.1`. Если на хосте публичный IP, без `--allow-public-http` отказ: опубликованный порт Docker обходит ufw.
   - `proxy`.
7. **БД:** `sqlite` (по умолчанию) или `postgres`.
8. **Генерация (`umask 077`).**
   - `POSTGRES_PASSWORD` берётся из `/dev/urandom`.
   - `.env` пишется атомарно.
   - **Значения в одинарных кавычках**, `INSTANCE_NAME` без `'` и перевода строки (m24).
   - Лимиты памяти считаются по `/proc/meminfo`. При RAM меньше 1 ГБ `ARGON2_MAX_CONCURRENCY=1`.
9. **Managed-файлы:** `compose.yaml`, `Caddyfile`, `melogold` (host CLI). Прошлые версии сохраняются в `.state/prev/`. `compose.override.yaml` и `caddy.d/` не трогаются.
10. **Образ.** `docker pull`, в `.env` записывается `MELOGOLD_IMAGE=<repo>:<ver>@sha256:…`.
11. **Владелец до публикации (M8).**
    1. `APP_BIND=127.0.0.1`, профили без `caddy`, `up -d app`, ожидание `/health`.
    2. `melogold user add <login>`: пароль с TTY или сгенерированный (при `--yes`), код восстановления печатается один раз.
    3. Только после этого включаются `caddy` или `APP_BIND=0.0.0.0` (`lan`) и выполняется `up -d`.

    Если нет `--admin-login` и `--registration` не задан явно, установка с `--yes` отказывает.
12. **Юниты бэкапа:** `melogold-backup.timer`, 03:30 UTC ± 30 мин.
13. **Фаервол** (с вопросом): ufw или firewalld, 80/tcp, 443/tcp, 443/udp.
14. **Ожидание здоровья:**
    - локальный `/health` до 120 с;
    - в режиме `domain` `https://…/health` до 180 с;
    - при неудаче диагностика: DNS, порт 80, хвост логов.
15. **Итог:** URL, режим, БД, команды, предупреждения. **QR адреса сервера** (`melogold qr`) и подсказка «Melogold → Настройки → Синхронизация → Свой сервер → Сканировать QR».

**Раскладка на хосте:**
- `$DIR/`:
  - `compose.yaml`, `Caddyfile`, `melogold` (managed);
  - `compose.override.yaml`, `caddy.d/` (пользовательские);
  - `.env` (600);
  - `backups/` (700);
  - `.state/{installer-version, upgrade-history.log, last-backup, prev/, lock/}`.
- Тома Docker: `melogold_data`, `melogold_pgdata`, `melogold_caddy_data`, `melogold_caddy_config`.

### 7.4 Host CLI `melogold` (POSIX sh)
Команды внутри контейнера вызываются с `-e NODE_OPTIONS=--max-old-space-size=96`, чтобы второй процесс Node не вытеснил сервер из cgroup (M17).

| Команда | Что делает |
|---|---|
| `status` | `compose ps`, версия, режим, URL, размер томов, последний бэкап, число рестартов |
| `logs [svc] [-f]`, `start`, `stop`, `restart` | `restart` — это `up -d --force-recreate`, он перечитывает `.env` |
| `upgrade [--version X \| --image REF] [--yes] [--major]` | §7.5 |
| `rollback` | предыдущий `MELOGOLD_IMAGE` и managed-файлы из `.state/prev`, затем `up -d` |
| `backup [--tag T] [--keep N] [--with-secrets]`, `restore FILE [--yes] [--drop-previous]`, `verify-backup FILE` | §7.6 |
| `user add\|reset-password\|delete\|list [--usage]\|devices\|revoke-device` | пароль только с TTY |
| `sync rotate-epoch --all\|<login>` | ставит `restore_pending` и перезапускает (или ротирует конкретного пользователя) |
| `secret rotate` | новый `/data/secret.key`, затем `up -d --force-recreate` |
| `qr`, `config`, `config set K=V`, `pull-deps`, `version`, `uninstall [--purge]` | как в PACKAGING §5. `--purge` требует ввести `DELETE ALL DATA` |

`doctor` и `self-update` — v1.1.

### 7.5 Обновление
1. Взять lock. Определить цель: последний релиз через редирект `/releases/latest` или `--version`/`--image`. Смена мажора (минора при 0.x) требует `--major`.
2. Скачать `install.sh`, `SHA256SUMS` и `SHA256SUMS.minisig` целевого тега.
   - **Подпись проверяет текущий, уже доверенный образ** (m25): `docker run --rm $CURRENT_IMAGE verify-release`. Публичный ключ minisign вшит в код сервера.
   - Хеш `install.sh` сверяется. Managed-файлы обновляются, в `.env` дописываются новые ключи, затем `compose config -q`.
3. Проверить совместимость меток `app.melogold.compose-schema`.
4. `melogold backup --tag pre-upgrade --keep 5`.
5. `pull app`, затем `docker compose run --rm --no-deps -T app migrate </dev/null`. Если миграция упала — вернуть прежний образ, выход с кодом 1. Миграции внутри мажора только расширяющие.
6. Записать новый `MELOGOLD_IMAGE`, `up -d --remove-orphans`, сверить `.Image`.
7. Проверки: `/health` локально и публично, запрос с `Bearer invalid` → 401. Провал → автооткат плюс хвост логов.
8. Строка в `upgrade-history.log`. Хранятся текущий и предыдущий образы.

Watchtower и автообновление по умолчанию не предлагаются.

### 7.6 Бэкап и восстановление (B1, M7)
**Артефакт** `melogold-backup-<UTC>-<tag>.tar.gz[.age]` (600), внутри:
- `manifest.json`: `format`, `createdAt`, `serverVersion`, `serverId`, `schemaVersion`, `db`, `sha256`;
- `db.sqlite` **или** `db.sql` (plain-дамп PG);
- `env.redacted`: `.env` без `POSTGRES_PASSWORD`;
- `secret.key` и полный `env` — **только** при `--with-secrets`, который требует `BACKUP_AGE_RECIPIENT`. `BACKUP_POST_HOOK` тоже разрешён только вместе с `age`.

**SQLite, онлайн:**
1. `compose exec -T app melogold backup --out -`.
2. Внутри: `VACUUM INTO /data/.tmp/b.sqlite` → `PRAGMA integrity_check` → в копии `restore_pending='1'` → поток в stdout.

**PostgreSQL:**
```
compose exec -T postgres pg_dump -U melogold -d melogold --format=plain --no-owner --no-privileges </dev/null
  | { cat; printf '\nINSERT INTO server_meta (key, value) VALUES (%s, %s) ON CONFLICT (key) DO UPDATE SET value = excluded.value;\n' "'restore_pending'" "'1'"; }
  > .partial/db.sql
```

**`restore FILE`:**
1. Проверить tar, manifest и sha256. Тип БД должен совпадать, иначе отказ: конвертация — v1.1. `schemaVersion` ≤ миграций образа.
2. Бэкап текущего состояния с тегом `pre-restore`, затем `stop app`.
3. Восстановить базу:
   - **SQLite:** `run --rm --no-deps -T app melogold restore --from - < db.sqlite`. Внутри: `integrity_check` → текущий файл в `/data/.pre-restore/` → удалить `-wal`/`-shm` → `rename` → rotate-epoch всем → флаг снят.
   - **PostgreSQL:**
     1. `DROP/CREATE DATABASE melogold_restoring`;
     2. `psql -v ON_ERROR_STOP=1 --single-transaction -d melogold_restoring < db.sql` (флаг ставится последней строкой дампа);
     3. завершить сессии;
     4. `ALTER DATABASE melogold RENAME TO melogold_pre_restore_<ts>`, затем `ALTER DATABASE melogold_restoring RENAME TO melogold`;
     5. `run --rm --no-deps -T app melogold sync rotate-epoch --all`.
4. С `--with-secrets` восстановить `secret.key`.
5. `up -d app`, `/health`, сверить `serverId` с manifest.

Даже если скрипт прервётся посередине, флаг уже стоит в базе, и старт сервера сам сменит epoch.

**`verify-backup`:**
- SQLite: `integrity_check` и счётчики строк;
- PG: восстановление во временную `melogold_verify`, счётчики, `DROP`.

**Перенос на новый хост:** `install.sh --restore FILE`.

### 7.7 `docker run` для опытных
```bash
docker run --rm -it -v melogold-data:/data ghcr.io/melogold-app/melogold-server:0.1 user add maxim   # сначала владелец
docker run -d --name melogold --restart unless-stopped -p 8080:8080 -v melogold-data:/data \
  -e PUBLIC_URL=http://192.168.1.50:8080 -e LINK_NETWORK_HINT=false ghcr.io/melogold-app/melogold-server:0.1
docker exec melogold melogold backup --out - > melogold-$(date +%F).sqlite
```
- Бэкапьте весь том: в нём лежит `secret.key`.
- Обновление: `pull`, затем `rm -f` и тот же `docker run`. Миграции выполняются при старте.

---

## 8. Официальный сервер: развёртывание

### 8.1 Решения
- **Хост:** Ubuntu 24.04, 1 vCPU, 2 ГБ, 30 ГБ, Франкфурт.
- **Установка:** тот же `install.sh` с `--domain api.melogold.app --db postgres --registration open` плюс `deploy/official/`.
- **`.env`:**
  - `APP_MEM_LIMIT=640m`, `APP_HEAP_MB=256`, `ARGON2_MAX_CONCURRENCY=2`;
  - `PG_SHARED_BUFFERS=256MB`, `PG_EFFECTIVE_CACHE_SIZE=768MB`, `PG_MEM_LIMIT=768m`;
  - `REGISTRATION_POW_BITS=18`;
  - `PRIVACY_URL=https://melogold.app/privacy`, `CONTACT=<после Q3>`.
- **DNS в Cloudflare:**
  - `api` — только DNS (A и AAAA при рабочем IPv6), без проксирования: иначе все клиенты выглядят как IP Cloudflare;
  - `get` — через прокси, Redirect Rule 302 на `…/releases/latest/download/install.sh`.
- **Деплой:**
  - только теги `vX.Y.Z` и `vX.Y.Z-rc.N`;
  - GitHub Environment `production`;
  - `concurrency: production, cancel-in-progress: false`.
- **SSH для CI:**
  - в `authorized_keys` пользователя `deploy`: `restrict,command="/opt/melogold/official/ci-entry.sh"`;
  - скрипт пропускает только `upgrade <ghcr.io/melogold-app/melogold-server[:tag]@sha256:…>` и `status`;
  - `known_hosts` закреплён в `vars.DEPLOY_KNOWN_HOSTS`.
- **Секрет сервера:** копия `/data/secret.key` лежит в менеджере паролей владельца. Off-site бэкапы делаются с `--with-secrets` и шифруются `age`.

### 8.2 `harden-vps.sh` (адаптация `clementineServer/deploy/harden-vps.sh`)
- **Переносится без изменений:**
  - определение порта SSH;
  - предупреждение о закрываемых портах;
  - правило SSH до включения ufw;
  - пароли отключаются только по флагу;
  - `sshd -t` с откатом;
  - идемпотентность.
- **Меняется:**
  - файл называется `00-melogold-hardening.conf`: sshd берёт первое значение;
  - обязательная проверка `sshd -T | grep 'passwordauthentication no'`, иначе откат и код 1;
  - ключи проверяются у root и у `deploy`;
  - вход проверяется через `journalctl -u ssh` (в OpenSSH ≥ 9.8 процесс называется `sshd-session`);
  - fail2ban: `backend=systemd`, `banaction=ufw`, `bantime.increment`;
  - ufw: 22/tcp, 80/tcp, 443/tcp, 443/udp;
  - swap 2 ГБ, `swappiness=10`;
  - `journald SystemMaxUse=200M`;
  - unattended-upgrades с перезагрузкой в 04:45 UTC (после retention);
  - `tcp_syncookies=1`, часовой пояс UTC.

### 8.3 Runbook первого запуска
- **Фаза 0 (Mac, GitHub, DNS):**
  1. Купить `melogold.app`, завести DNS (§8.1).
  2. Сгенерировать ключи: `ssh-keygen -t ed25519 -f ~/.ssh/melogold_deploy`, `age-keygen`, `minisign -G`. Приватные ключи — в менеджер паролей, публичный ключ minisign — в код.
  3. CI зелёный, тег `v0.1.0-rc.1`.
  4. Сделать пакет GHCR публичным, проверить анонимный `docker pull`.
- **Фаза 1 (хост):**
  1. `ssh-copy-id`.
  2. Сверить отпечаток хоста в веб-консоли хостера и записать его в `DEPLOY_KNOWN_HOSTS`.
  3. `harden-vps.sh`, затем `--disable-password-auth` из второй сессии, проверка `Permission denied (publickey)`.
- **Фаза 2 (подготовка):**
  1. `bootstrap-official.sh`: Docker из apt-репозитория Docker, `daemon.json` (`log-driver local`, `live-restore`), пользователь `deploy`, `age`, `rclone`, `jq`, юниты.
  2. Проверки: `docker info`, `swapon`, `ufw status`, `fail2ban-client`.
- **Фаза 3 (установка):**
  1. `install.sh --dir /opt/melogold --owner deploy --domain api.melogold.app --db postgres --registration open --version 0.1.0-rc.1 --no-backup-timer --yes`, затем правка `.env` по §8.1.
  2. **Миграции с этого момента заморожены.**
  3. Проверки: `ss -tlnp` (5432 не слушается, 8080 только на 127.0.0.1), HTTPS, `308` с http.
  4. Сценарий с двумя устройствами: регистрация, QR-привязка, отзыв, передача воспроизведения.
- **Фаза 4 (CI-деплой):**
  1. vars и secrets.
  2. Ручной `deploy-official` с rc.
  3. Тег `v0.1.0` проходит весь путь до `/server/info.version=0.1.0`.
  4. Репетиция `rollback`.
- **Фаза 5 (бэкапы и мониторинг):**
  - Backblaze B2 EU, ключ без `deleteFiles`, lifecycle 30 дней.
  - `melogold-offsite.timer` каждые 6 ч: `backup --tag offsite --with-secrets --keep 8` → `rclone copyto` → `rclone check` → `df < 85%` → heartbeat healthchecks.io. Ошибка → `/fail`.
  - `melogold-restore-check.timer` раз в неделю: `verify-backup` последнего дампа, затем heartbeat.
  - Внешний uptime-мониторинг `/health` раз в минуту с проверкой SSL, алерты в Telegram.
- **Фаза 6 (публикация):**
  1. `install.sh --lan` на чистой ВМ и на arm64.
  2. `serverId` официального сервера вшить в клиенты как `OFFICIAL_SERVER_ID`.
  3. Сервер по умолчанию в клиентах — `https://api.melogold.app`.
  4. Обновить README (там сейчас PostgreSQL 16, YTM и iOS — `S/README.md:12,25,39`).

### 8.4 Бюджет ресурсов

| Компонент | Лимит | Обычно | Пик |
|---|---|---|---|
| ОС, sshd, journald, fail2ban | — | ~250 МБ | ~380 |
| dockerd, containerd | — | ~100 | ~150 |
| Caddy | 128m | 30–50 | ~80 |
| PostgreSQL | 768m | 300–450 | ~600 |
| app | 640m (heap 256) | 120–180 | ~450 (argon2 2×64 МиБ) |
| Разовые задачи (migrate, pg_dump, age, rclone) | — | — | +150 |
| **Итого** | | **~0,9–1,1 ГБ** | **~1,7 ГБ**, swap 2 ГБ как страховка |

- **Диск:**
  - ОС ~4 ГБ;
  - образы ~1 ГБ;
  - БД: оценка ~5–12 МБ на тяжёлого пользователя. Квоты §3.10 ограничивают худший случай;
  - 8 локальных дампов;
  - алерт при 85% занятости и `storage_full` при 90%.
- **CPU:** argon2 ~150 мс на хеш, потолок ~6 входов в секунду.

### 8.5 Обслуживание и аварии
- **Раз в месяц:** `apt full-upgrade`, `melogold pull-deps`, `df -h`.
- **Раз в квартал:** восстановление off-site бэкапа на Mac (`--lan --db postgres`).
- **Потеря VPS:**
  1. Новый хост, `harden-vps.sh`, `bootstrap-official.sh`.
  2. `age -d` последнего дампа.
  3. `install.sh --restore FILE --owner deploy`. `secret.key` едет из зашифрованного бэкапа.
  4. Переключить DNS (TTL 300).

  Epoch сменится, клиенты пройдут **тихое слияние** без диалога. Сессии сохраняются благодаря ключу и окну `RESTORE_REFRESH_GRACE_DAYS`. RPO 6 ч, RTO ~45 мин.
- **Откат снапшота VPS у хостера:** сразу `melogold sync rotate-epoch --all` (B1).
- **Мажорное обновление PostgreSQL:** бэкап, новый том, restore — по `docs/UPGRADING.md`.

---

## 9. Безопасность

| Угроза | Защита |
|---|---|
| Перебор аккаунтов | фиктивный хеш через тот же семафор; одинаковые 401 и 429 |
| Подбор пароля к логину | троттлинг по логину в БД с экспонентой до 15 мин; denylist |
| Credential stuffing | лимиты по IP (IPv4 целиком, IPv6 /56) плюс семафор argon2 (потолок CPU, затем 503) |
| Блокировка входа владельцу (DoS) | обход троттлинга для знакомого hwid; вход через QR; существующие сессии живут |
| Кража refresh | ротация; окно отдаёт только неподтверждённого преемника (`rid`); повтор удаляет устройство; `hwid` обязателен |
| Кража access | 15 мин; guard проверяет устройство на каждом запросе; SSE закрывается при `exp` |
| Выход старым токеном | logout только текущим токеном или токеном в окне grace (M4) |
| Украденный разблокированный телефон | принятый риск (§4.8): уведомление `account.updated`, отзыв устройства, код восстановления |
| Фишинговый QR или deep link | `request` только из сканера внутри приложения; явное одобрение; задержка 2 с; сверка числа; логин аккаунта на новом устройстве; `serverId` |
| Подглядывание за QR или кодом invite | `pollSecret`; сверка числа; текст «код уже использован — отклоните» |
| QR ведёт на злой сервер | подтверждение сервера; значок «Официальный» только по origin и `serverId` |
| Утечка БД | argon2id; хеши токенов и кодов; **ключ подписи не в БД** |
| Утечка бэкапа | ключ в бэкапе только зашифрованным (`age`) |
| Подделка IP через XFF | `TRUST_PROXY` — CIDR доверенного прокси; приложение слушает только 127.0.0.1 за прокси |
| Злоупотребление хранилищем | квоты §3.10, лимит `play.add` в час, `storage_full` |
| Заспамленная регистрация | PoW с адаптивной сложностью, лимиты по IP, режим `first` для self-host |
| Подмена имени устройства | удаление управляющих и bidi-символов; пометка «сообщает о себе» |
| Цепочка поставок | `npm ci --ignore-scripts`; Actions по SHA; `SHA256SUMS` с подписью minisign, проверяемой текущим образом; образ по digest |

**Приватность и логи:**
- `disableRequestLogging`. Свой `onResponse` пишет `reqId`, метод, шаблон маршрута, статус, время. Тела запросов и query не пишутся.
- **IP в логи не попадают.** В записях о срабатывании лимита — `ipTag = HMAC-SHA256(dailyKey, ip)[:12]`, ключ живёт только в памяти и меняется в 00:00 UTC (m16).
- `videoId` вместе с `userId` на уровне `info` не пишется.
- **Маскирование** (m13): `authorization`, `cookie`, `*.password*`, `*.currentPassword`, `*.newPassword`, `*.refreshToken`, `*.accessToken`, `*.recoveryCode`, `*.pollSecret`, `*.linkToken`, `*.userCode`, `*.hwid`, `*.pow`. Поле ответа `code` (код ошибки) не маскируется.
- В БД IP нет, кроме `creator_net`/`other_net` незавершённой привязки. Они стираются при финальном статусе.

---

## 10. Тестирование и CI

**Тесты** (`node:test`, `app.inject`):
- `*.test.ts` — чистые функции: курсор, `wins`, LIS, ключи порядка, векторы `spec/*`, политика паролей, PoW, hwid, матрица §4.8, `parseEnv`.
- `*.int.test.ts` на настоящей БД. **Каждый гоняется на двух диалектах:**
  - `TEST_DB=sqlite`: временный файл, WAL;
  - `TEST_DB=postgres`: отдельная схема на файл. **CI использует базу с локалью `en_US.UTF-8`**, чтобы ловить ошибки collation (M10).
- **Контрактные тесты:**
  - у каждой ошибки есть 4 ключа и `code` из реестра;
  - закрытость по умолчанию: маршрут без токена → 401;
  - у каждой операции OpenAPI есть `operationId`, 4xx-ответ (кроме проб `GET /health` и `GET /health/live`: входа у них нет, ответы только 200 или 5xx) и именованные компоненты;
  - `spec/error-codes.json` совпадает с кодом.
- **Паритет схемы:** интроспекция совпадает со снапшотом на обоих диалектах.
- **Обязательные регрессии ревью:**
  - B1: restore;
  - M3: grace и `rid`;
  - M4: logout старым токеном;
  - M5: SSE после revoke из CLI и после `exp`;
  - M6: матрица;
  - M10: join items → tracks на PG с не-C локалью, байтовый порядок `video_id` и `collation_name = 'C'` у обеих колонок join;
  - M11: конфликт внутри транзакции;
  - M12: `\u0000` и int > 2³¹ → 400 или санитизация, а не 500;
  - M13: бюджет → 413;
  - M14: мусорные метаданные → op применён;
  - M15: отрицательные ops переживают слияние (клиентский вектор в `spec/sync-scenarios`);
  - M16: квоты;
  - m3: повторный poll;
  - m18: `rev` после DELETE.
- **Конкурентность:** 20 параллельных `POST /sync` одного пользователя: `seq` строго растёт, pull с нуля совпадает с прямым чтением таблиц.
- **Нагрузочный прогон** до публичного запуска: `scripts/bench`, autocannon в `--cpus=1 --memory=512m` на обоих диалектах. Цель: p95 пишущего `/sync` меньше 300 мс при 50 пишущих транзакциях в секунду.

**CI (все Actions закреплены по SHA):**
- `ci.yml` (PR, push):
  - `static`: typecheck, lint, format, `openapi:check` (генерация и `git diff --exit-code`), `redocly lint`, `oasdiff breaking` против последнего релиза (после `v0.1.0`);
  - `test`: матрица `sqlite` и `postgres:18` (локаль en_US.UTF-8), amd64;
  - `docker`: сборка amd64 и `scripts/smoke.sh` (без env: register → login → sync → restart → данные на месте), плюс **один smoke на `ubuntu-24.04-arm`**.
- `image.yml` (main и теги):
  - сборка по архитектурам на нативных раннерах, push by digest, слияние манифеста;
  - теги `edge`/`sha-*` для main, semver для `v*`;
  - **e2e установщика** на тегах: `--lan` × {sqlite, postgres}: status → user add → backup → verify → запись → restore → проверка 410 → повторный install (no-op) → upgrade с предыдущего релиза → uninstall.
- `release.yml`: `install.sh`, `openapi.json`, `openapi.yaml`, `error-codes.json`, `SHA256SUMS`, `SHA256SUMS.minisig`, GitHub Release. Версия в `package.json` = тегу.
- `deploy-official.yml`: §8.1.
- Trivy, attestations, Node 26 non-blocking — v1.1.

---

## 11. Ограничения и что отложено

**Ограничения MVP:**
1. **Один процесс:** SSE, лимиты частоты, long-poll и семафор живут в памяти. `--scale` не поддерживается.
2. **SQLite — один писатель на сервер.** Для больших инстансов нужен PostgreSQL. Встроенного переноса SQLite↔PG нет: путь — новый сервер и «Объединить».
3. **Треки `local:`** не синхронизируются. В плейлисте они держатся за левого соседа.
4. Трек встречается в плейлисте один раз. Две одновременные полные пересортировки дают гибридный порядок.
5. **Удаление плейлиста окончательное.** Офлайн-добавления попадают в «(восстановлено)», остальные офлайн-правки теряются.
6. **Надгробия библиотеки не удаляются.** Элементы с `present=0` занимают квоту 100 000. `floor_seq` зарезервирован.
7. **После восстановления сервера** удаления, сделанные после бэкапа, воскресают при тихом слиянии, если их намерений уже нет в outbox. Откат снапшота ВМ сам не обнаруживается: см. runbook.
8. `sync_ops` хранится 180 дней, строки `in_history=0` — 30 дней. Более старые повторы не распознаются.
9. **Метаданные треков** обновляются только вместе с ops. Переименования на YouTube сами до устройств не доходят.
10. **История на сервере:** 400 дней и 50 000 событий. Выгрузка при слиянии — до 20 000.
11. **Воспроизведение:** один слушатель на аккаунт, удалённого управления нет, «радио» не передаётся.
12. **Экспорт** — не атомарный снимок.
13. **Официальный сервер** не может восстановить аккаунт без пароля, кода и устройств.
14. **Удалённый обратный прокси** (не на том же хосте) не поддерживается для лимитов по IP. В режиме `lan` все IPv6-клиенты видны как один адрес.
15. Все цифры производительности — оценки до прогона `scripts/bench`.

**Отложено в v1.1:**
- установка: `--ip-cert` (Let's Encrypt для IP), `--tailscale`, mDNS `_melogold._tcp`, `/.well-known/melogold.json`;
- CLI: `melogold doctor`, `self-update`, `db copy` (SQLite↔PG);
- драйвер `node:sqlite`;
- синхронизация: `GET /sync/log`, восстановление удалённого плейлиста из `pre_image`, сборка надгробий и `cursor_expired`;
- квоты через env;
- тикеты SSE для веб-клиента;
- Trivy, attestations, PITR (WAL-G).

---

## 12. Открытые вопросы к пользователю

1. ~~Смена пароля без старого~~ — **решено (2026-09-23):** с любого вошедшего устройства, без кулдауна (§4.8).
2. ~~Лицензия файлов контракта~~ — **решено (2026-09-23):** `openapi/*` и `spec/*` под **CC0-1.0**: файл `spec/LICENSE` (и `openapi/LICENSE`) с текстом CC0 и SPDX-заголовок `CC0-1.0` в генерируемых файлах. Остальной код сервера — AGPL-3.0.
3. **Юридические данные официального сервера (ЕС):**
   - оператор (имя или организация) и выходные данные;
   - текст политики конфиденциальности на `melogold.app/privacy`;
   - контакт для жалоб (`CONTACT`: почта или Matrix);
   - минимальный возраст — **рекомендация 16 лет** (GDPR, Германия);
   - срок хранения данных удалённых аккаунтов в бэкапах — **рекомендация 30 дней**.

   Без этого публичную регистрацию открывать нельзя.
4. **Покупки и аккаунты** (действия с вашей стороны):
   - купить `melogold.app` и завести DNS в Cloudflare (нужен бесплатный Redirect Rule для `get`);
   - Backblaze B2 (EU) для off-site бэкапов;
   - healthchecks.io и бот в Telegram для алертов;
   - VPS с работающим IPv6 (желательно) и доступом к веб-консоли.
