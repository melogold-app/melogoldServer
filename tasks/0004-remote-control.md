# Управление музыкой на другом устройстве и его громкостью (как AirPlay, но через сервер)

Статус: открыто — **предложение, ждёт утверждения пользователем**; после утверждения первым шагом внести контракт в
`docs/API.md`, затем код

Клиентские задания: `melogoldAndroid/tasks/0018-remote-control.md`, `melogoldWindows/tasks/0017-remote-control.md`,
`melogoldiOSmacOS/tasks/0020-remote-control.md`, `melogoldLinux/tasks/0011-remote-control.md`.
Из бэклога: «Melogold Connect» (`melogoldAndroid/docs/BACKLOG.md`, P3 «Кастинг»).

## 1. Что нужно пользователю

Музыка играет на компьютере, а управлять хочется с телефона, не вставая: пауза, следующий трек, перемотка, громкость,
включить другой альбом. Или наоборот, с компьютера — телефоном, подключённым к колонке. Как Spotify Connect или AirPlay,
только между своими устройствами Melogold и через свой сервер, без общей сети: работает и из другой комнаты, и через
мобильный интернет.

## 2. Что уже есть

- `PUT/GET/DELETE /playback/state` и SSE `playback.updated` (API §4.9, §6, DESIGN §3.12): устройство сообщает, что
  играет, остальные видят; «Слушать здесь» (`handoffFrom`) забирает воспроизведение себе.
- Сервер знает открытые SSE-потоки каждого устройства (`ctx.live`).
- **Android сейчас `/playback/state` не использует вообще** — это часть клиентского задания.

## 3. Что добавляет сервер (предложение)

```ts
type RemoteDevice = {
  deviceId: Uuid;
  name: string;
  platform: string;
  online: boolean; // есть открытый SSE-поток прямо сейчас
  controllable: boolean; // устройство разрешило управление (объявило при подключении SSE)
  playing: PlaybackSummary | null; // что играет, если это устройство — автор текущего playback_state
  volume: number | null; // 0..100, последнее, что устройство сообщило
};
type RemoteDeviceList = { devices: RemoteDevice[] }; // свои устройства, кроме вызывающего

type RemoteCommand = {
  commandId: Uuid; // клиент делает сам; повтор того же id — тот же ответ
  targetDeviceId: Uuid;
  action: string; // play|pause|toggle|next|previous|seek|volume|play_queue|stop
  positionMs?: number; // seek
  volume?: number; // volume: 0..100
  queue?: TrackInput[];
  index?: number; // play_queue: 1..200 и начальный индекс
};
type RemoteCommandResult = { delivered: boolean }; // false — поток цели закрылся в эту секунду
```

| Метод  | Путь                 | Что                                                                                                                                                                                                   |
| ------ | -------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GET`  | `/playback/devices`  | `RemoteDeviceList`                                                                                                                                                                                    |
| `POST` | `/playback/commands` | отправить команду → 202 `RemoteCommandResult`; цель не в сети — `409 device_offline`; запретила управление — `409 remote_control_disabled`; чужое или неизвестное устройство — `404 device_not_found` |

- **SSE `playback.command`** (API §6) — только в потоки устройства-цели: `{commandId, fromDeviceId, fromDeviceName,
action, positionMs?, volume?, queue?, index?}`. Сервер команды не хранит и не повторяет.
- **Цель** выполняет команду и, как обычно, сообщает итог `PUT /playback/state` — остальные видят `playback.updated`.
  Поэтому ответа на команду нет: пульт показывает то, что пришло в `playback.updated`.
- **Громкость:** `PlaybackPut` и `PlaybackState` получают необязательное `volume: number | null` (0..100, громкость
  плеера устройства); значимым изменением считается шаг от 5.
- **Разрешение:** устройство объявляет `controllable` параметром при открытии SSE (`GET /auth/me/events?remote=1`);
  по умолчанию в клиентах включено, выключается в Настройках устройства.
- **Лимит:** 10 команд в секунду на устройство-отправителя (`429`).
- `features.remote = {version: 1}`.
- **Не меняется:** «Слушать здесь», правила `PUT /playback/state`. Звук между устройствами не передаётся — каждое
  играет само.

## 4. Проверка

Интеграционные тесты: список устройств с `online` и `controllable`; команда доходит только в SSE цели; `device_offline`,
`remote_control_disabled`, чужое устройство — 404; повтор `commandId`; лимит; `volume` в `PUT`/`GET /playback/state`.
