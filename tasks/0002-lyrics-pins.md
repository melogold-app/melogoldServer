# Закреплённый текст песни: найденный автоматически одинаков на всех устройствах

Статус: открыто — контракт **утверждён пользователем 2026-09-26**; первым шагом внести его в `docs/API.md`, затем код

Клиентские задания, которые ждут это: `melogoldWindows/tasks/0012-lyrics-pins.md`,
`melogoldAndroid/tasks/0013-lyrics-pins.md`, `melogoldiOSmacOS/tasks/0015-lyrics-pins.md`,
`melogoldLinux/tasks/0006-lyrics-pins.md`.

## 1. Что нужно пользователю

Найденный автоматически текст (YouTube Music → LrcLib → KuGou) сейчас каждое устройство ищет само и хранит у себя
(API §4.10: на сервер уходят только свои тексты). У трека, для которого у поставщиков несколько вариантов, на телефоне и
на компьютере может оказаться разный текст.

Пользователь: «если клиент включил песню и лирика уже правильная, он ничего не делает и его всё устраивает — значит, на
другом устройстве должно быть так же; нужно пометить, что вот такая лирика — дефолт. Если поменял или сделал свою —
тем более».

**Решение пользователя (2026-09-26):**
- трек проиграл **30 секунд** (порог записи в историю) с найденным автоматически текстом, и пользователь его не менял —
  устройство **закрепляет** этот текст;
- на сервере хранится **ссылка** на текст у поставщика, а не сам текст: ~150 байт против ~5 КБ на трек (2 млн
  закреплений — около 0,3 ГБ вместо 10 ГБ; у публичного сервера 30 ГБ диска);
- свой текст (§4.10: набранный, из файла, выбранный в «Найти другой текст») важнее закреплённого и хранится, как
  сейчас, целиком.

## 2. Контракт (утверждён; внести в `docs/API.md`)

**Новый вид op** `lyrics.pin.set` (§4.8), поток `library`, `entityKey` = `lpin:<videoId>`, побеждает более поздний `at`:

| kind | Обязательные поля | Необязательные | entityKey |
|---|---|---|---|
| `lyrics.pin.set` | `videoId` | `source`, `ref`, `startTimeMs` | `lpin:<videoId>` |

- `source` — `youtube_music | lrclib | kugou` (как источники §4.10); `ref` — номер текста у поставщика, ≤ 200 единиц
  UTF-16:
  - `lrclib` — id записи (`GET https://lrclib.net/api/get/{id}`);
  - `youtube_music` — browseId текста (`MPLYt…`, из `next`), текст берётся `browse`;
  - `kugou` — `<id>:<accesskey>` (`krcs.kugou.com/download`).
- `startTimeMs` — сдвиг «позже», 0..86 400 000, как у своих текстов (сдвиг «раньше» остаётся на устройстве).
- Пустой `ref` или неизвестный `source` — закрепление снято (`deleted`). Замена целиком, как `track.override.set`.
- В плоский `SyncOp` добавляются `source?: string`, `ref?: string`, `startTimeMs?: number`.
- `features.sync.kinds` включает `lyrics.pin.set`.

**Ответ синка:**
```ts
type LyricsPinRow = { videoId: VideoId; source: string | null; ref: string | null; startTimeMs: number | null;
                      updatedAt: Iso; deleted: boolean };
// SyncResponse: + lyricsPins: LyricsPinRow[]
// SyncInclude:  + lyricsPins?: VideoId[]
```

**Квота:** `limits.sync.maxLyricsPins` = 150 000; сверх — `deferred quota_exceeded`. **Экспорт** (§4.5):
`library.lyricsPins` (живые).

**DDL** (новая расширяющая миграция):
```sql
CREATE TABLE sync_lyrics_pins (
  user_id       <uuid>   NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  video_id      <text>   NOT NULL,
  source        <text>,
  ref           <text>,
  start_time_ms <int>,
  updated_at    <ts>     NOT NULL,
  seq           <bigint> NOT NULL,
  deleted       <bool>   NOT NULL,
  PRIMARY KEY (user_id, video_id)
);
CREATE INDEX sync_lyrics_pins_pull ON sync_lyrics_pins (user_id, seq);
```

**Не меняется:** свои тексты §4.10 и общие (`shared`) — закрепления личные и другим пользователям не показываются;
сервер сам к поставщикам не ходит и текст не хранит.

## 3. Проверка

Интеграционные тесты на SQLite и PostgreSQL: установка, замена, снятие, победа более позднего `at`,
`include.lyricsPins`, квота, экспорт, удаление аккаунта. `openapi:check`, `schema:sql`.
