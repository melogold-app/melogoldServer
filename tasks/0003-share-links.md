# Ссылки: поделиться плейлистом, альбомом, треком; открыть ссылку Spotify, Apple, Яндекса

Статус: открыто — контракт **утверждён пользователем 2026-09-30**; первым шагом внести контракт в
`docs/API.md`, затем код

Клиентские задания: `melogoldAndroid/tasks/0017-share-links.md`, `melogoldWindows/tasks/0016-share-links.md`,
`melogoldiOSmacOS/tasks/0019-share-links.md`, `melogoldLinux/tasks/0010-share-links.md`.
Из бэклога: `melogoldAndroid/docs/BACKLOG.md`, P2 «Шаринг плейлистов».

## 1. Что нужно пользователю

Отправить другу альбом, плейлист или трек ссылкой. Тот, у кого есть Melogold, открывает её в приложении и сохраняет себе,
а у кого нет — слушает на YouTube. И обратно: друг прислал ссылку Spotify, Apple Music или Яндекс Музыки, а она
открывается в Melogold тем же треком или альбомом.

Альбомы, артисты, треки и плейлисты YouTube уже имеют ссылки YouTube, клиенты их понимают. Сервер нужен только **своим
плейлистам**: их нет на YouTube, а собранный из разных видео «альбом» (обход цензуры) — как раз то, чем хотят делиться.

## 2. Что делает сервер (предложение)

**Снимок плейлиста по ссылке.** Снимок не меняется: изменили плейлист — поделились снова, получилась новая ссылка.

```ts
type CreateShareRequest = { kind: string /*playlist*/; name: string /*1..200*/; tracks: TrackInput[] /*1..1000*/ };
type ShareCreated = { shareId: string /*10 знаков base62*/; url: string /*<publicUrl>/s/<shareId>*/; createdAt: Iso };
type ShareDto = { shareId: string; kind: string; name: string; tracks: TrackDto[]; createdAt: Iso };
type ShareList = { shares: ShareDto[] };
```

| Метод    | Путь                | Кто       | Что                                                                                                             |
| -------- | ------------------- | --------- | --------------------------------------------------------------------------------------------------------------- |
| `POST`   | `/shares`           | Bearer    | создать снимок → 201 `ShareCreated`; лимит 200 снимков на пользователя, сверх — `409 share_limit_reached`       |
| `GET`    | `/shares`           | Bearer    | свои снимки, новые первыми                                                                                      |
| `DELETE` | `/shares/{shareId}` | Bearer    | удалить свой → 204 (ссылка перестаёт открываться)                                                               |
| `GET`    | `/shares/{shareId}` | без входа | `ShareDto` для приложения; нет — `404 share_not_found`                                                          |
| `GET`    | `/s/{shareId}`      | без входа | HTML-страница: название, список «исполнитель — трек · 3:45», кнопки «Открыть в Melogold» и «Слушать на YouTube» |

- Страница `/s/{id}`: без JS и внешних ресурсов, `noindex`, тёмная и светлая тема. «Открыть в Melogold» — deep link
  `melogold://share?v=1&url=<publicUrl>&id=<shareId>` (API §7, новая форма). «Слушать на YouTube» —
  `https://www.youtube.com/watch_videos?video_ids=<id1>,<id2>,…` (первые 50), у каждого трека — ссылка на
  `https://music.youtube.com/watch?v=<id>`.
- Лимиты частоты: `POST /shares` 20/час на пользователя; `GET /s/*` и `GET /shares/{id}` 60/мин на IP.
- Кто по ссылке видит: название и треки. Логин автора не показывается.
- `features.share = {version: 1}`, `limits.share = {maxShares: 200, maxTracks: 1000}`.
- DDL: `shares(id, user_id, kind, name, payload JSON, created_at)`, индекс `(user_id, created_at)`; удаление аккаунта
  удаляет снимки; экспорт (§4.5) — `shares`.

**Не на сервере:** ссылки Spotify, Apple Music, Яндекс Музыки, Deezer клиенты переводят в YouTube сами; сервер к ним не
ходит. **Уточнение 2026-09-30:** song.link (Odesli, `https://api.song.link/v1-alpha.1/links?url=…`) без ключа теперь
отвечает `401 PUBLIC_API_ACCESS_DEPRECATED`, поэтому главный путь без ключа — прочитать начало страницы самой ссылки,
взять название и исполнителя из `<title>` / `og:title` / `og:description` и искать на YouTube Music (образцы: Android
`providers/songlink/PageTitles.kt`, Apple `MelogoldInnerTube/ExternalLinks.swift`). song.link — только если в сборке
задан ключ.

## 3. Проверка

Интеграционные тесты: создать, открыть без входа (JSON и HTML), лимиты, удалить, удаление аккаунта, экспорт. HTML-страница
экранирует названия (XSS).
