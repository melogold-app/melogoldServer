<p align="center">
  <img src=".github/melogold-icon.png" width="128" height="128" alt="Melogold">
</p>

<h1 align="center">Melogold Server</h1>

<p align="center">Сервер синхронизации <a href="https://github.com/MaximCemencov/melogoldAndroid">Melogold</a>: общие избранное, библиотека и плейлисты на всех устройствах пользователя.</p>

## Что хранит сервер

- аккаунты (регистрация по логину и паролю);
- треки как ссылки на YouTube Music (`videoId` и отображаемые данные);
- избранное, библиотеку и плейлисты пользователя;
- список подключённых устройств с возможностью отключить любое.

**Аудио на сервере нет.** Музыку каждый клиент получает из YouTube Music сам.

## Официальный сервер и свой сервер

Можно пользоваться официальным сервером Melogold или развернуть свой: клиенты позволяют указать адрес
сервера. Для self-hosting будет готовый `docker compose`.

## Статус

В разработке. Планируемый стек: Node.js 22, TypeScript, Fastify, PostgreSQL 16, описание API в OpenAPI.

## Остальные части Melogold

| Платформа | Репозиторий |
|---|---|
| Android | [melogoldAndroid](https://github.com/MaximCemencov/melogoldAndroid) |
| Сервер | melogoldServer |
| Windows | melogoldWindows |
| Linux | melogoldLinux |
| iOS и macOS | melogoldiOSmacOS |
