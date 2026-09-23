<p align="center">
  <img src=".github/melogold-icon.png" width="128" height="128" alt="Melogold">
</p>

<h1 align="center">Melogold Server</h1>

<p align="center">Сервер синхронизации <a href="https://github.com/melogold-app/melogoldAndroid">Melogold</a>: общие избранное, библиотека и плейлисты на всех устройствах пользователя.</p>

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

В разработке. Стек: Node.js 24, TypeScript, Fastify 5, Kysely (SQLite по умолчанию или PostgreSQL), OpenAPI 3.0.

Документация:
- [Архитектура](docs/DESIGN.md)
- [Контракт API](docs/API.md) — единый для всех клиентов
- [План реализации](docs/PLAN.md)

## Лицензия

[AGPL-3.0](./LICENSE). Если вы запускаете изменённую версию сервера для других пользователей, вы обязаны опубликовать её исходный код.

## Остальные части Melogold

| Платформа | Репозиторий |
|---|---|
| Android | [melogoldAndroid](https://github.com/melogold-app/melogoldAndroid) |
| Сервер | [melogoldServer](https://github.com/melogold-app/melogoldServer) |
| Windows | [melogoldWindows](https://github.com/melogold-app/melogoldWindows) |
| Linux | [melogoldLinux](https://github.com/melogold-app/melogoldLinux) |
| iOS и macOS | [melogoldiOSmacOS](https://github.com/melogold-app/melogoldiOSmacOS) |
