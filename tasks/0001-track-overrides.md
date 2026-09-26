# Своё название, исполнитель и альбом трека (только текст)

Статус: сделано — контракт в `docs/API.md` (§4.8, §4.5, §9.2, §11), сервер 0.1.1; `features.sync.kinds` включает `track.override.set`

Клиентские задания, которые ждут это: `melogoldWindows/tasks/0011-track-overrides.md`,
`melogoldAndroid/tasks/0012-track-overrides.md`, `melogoldiOSmacOS/tasks/0014-track-overrides.md`,
`melogoldLinux/tasks/0005-track-overrides.md`.

## 1. Что нужно пользователю

Melogold — обход ограничений и цензуры в музыке. Альбом, который сначала зацензурировали, а потом удалили, лежит на
YouTube разными видео от разных людей: у каждого своё название («Artist — Song (live, fan upload)»), свой канал вместо
исполнителя, альбома нет. Пользователь собирает такие треки в плейлист и хочет, чтобы они выглядели одним альбомом:
то же название альбома, правильные названия песен и исполнитель — **на всех его устройствах**, а не только там, где
он поправил.

**Решение пользователя (2026-09-26):** на сервере храним **только текст** — название, исполнителя, альбом. Файлы,
обложки и свои аудиозаписи не храним: у публичного сервера 30 ГБ диска, для файлов это мало. Текстовая правка — сотни
байт на трек, миллионы правок укладываются в сотни мегабайт.

## 2. Почему нельзя на текущем контракте

`sync_tracks` хранит метаданные YouTube на пользователя, но (`src/modules/sync/tracks.ts`):

- строка перезаписывается любым op с `tracks[]`, в котором другое `title` или `artistsText`, — другое устройство,
  лайкнув трек или добавив его в плейлист, вернёт оригинальное название с YouTube;
- смена одного `albumTitle` строку не перезаписывает;
- это «как на YouTube», а не «как хочет пользователь»: смешивать нельзя, иначе оригинал потеряется и «Вернуть как на
  YouTube» будет не из чего.

Нужна отдельная сущность — переопределение поверх метаданных YouTube.

## 3. Контракт (утверждён пользователем 2026-09-26; внести в `docs/API.md`)

**Новый вид op** `track.override.set` (§4.8), `entityKey` = `ovr:<videoId>`, побеждает более поздний `at` (как
`like.set`):

| kind                 | Обязательные поля | Необязательные                       | entityKey       |
| -------------------- | ----------------- | ------------------------------------ | --------------- |
| `track.override.set` | `videoId`         | `title`, `artistsText`, `albumTitle` | `ovr:<videoId>` |

- Замена целиком: отсутствующее или пустое поле — у этого поля правки нет (показывается YouTube). Все три пустые —
  правка снята (строка становится `deleted`). Так не нужно различать `null` и отсутствие поля (в разборе ops они
  одинаковы, AGENTS.md «Контракт»).
- Нормализация, как у `TrackInput` (DESIGN §3.9): trim, обрезка до 500 единиц UTF-16 без разрыва суррогатной пары,
  неверный тип → поле пустое. Метаданные не приводят к отказу.
- В плоский `SyncOp` добавляются `artistsText?: string` и `albumTitle?: string` (`title` уже есть).
- `features.sync.kinds` включает `track.override.set` — по нему клиенты включают функцию (отдельный флаг не нужен).

**Ответ синка**, поток `library`:

```ts
type TrackOverrideRow = {
  videoId: VideoId;
  title: string | null;
  artistsText: string | null;
  albumTitle: string | null;
  updatedAt: Iso;
  deleted: boolean;
};
// SyncResponse: + overrides: TrackOverrideRow[]
// SyncInclude:  + overrides?: VideoId[]
```

**Квота:** `limits.sync.maxTrackOverrides` = 150 000 (как `maxTracks`); сверх — `deferred quota_exceeded` (§2.3).

**Экспорт** (§4.5): `library.overrides: TrackOverrideRow[]` (живые).

**DDL** (§9.2, новая расширяющая миграция):

```sql
CREATE TABLE sync_track_overrides (
  user_id      <uuid>   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id     <text>   NOT NULL,
  title        <text>,
  artists_text <text>,
  album_title  <text>,
  updated_at   <ts>     NOT NULL,
  seq          <bigint> NOT NULL,
  deleted      <bool>   NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX sync_track_overrides_pull ON sync_track_overrides (user_id, seq);
```

Типы — по правилам `docs/database.md` и §9.1 (оба диалекта).

**Не меняется:** `sync_tracks`, общие тексты (§4.10) и их поиск, другие пользователи сервера — правка видна только её
автору.

## 4. Проверка

- Интеграционные тесты на SQLite и PostgreSQL: установка, замена, снятие (все поля пустые → `deleted`), победа более
  позднего `at`, `include.overrides`, квота, экспорт, удаление аккаунта удаляет строки.
- Два устройства: правка на одном приходит на другое; `like.set` с оригинальными `tracks[]` правку не трогает.
- `openapi:check`, `schema:sql` — сгенерированные файлы закоммичены.
