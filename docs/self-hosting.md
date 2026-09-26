# Свой сервер Melogold

Сервер хранит аккаунты, библиотеку, плейлисты, историю и тексты песен. Аудио на сервере нет: музыку каждый клиент
берёт из YouTube Music сам. Поэтому серверу хватает 1 ГБ памяти и нескольких гигабайт диска.

## Что нужно

- Linux x86_64 или aarch64 (Ubuntu 22.04+, Debian 12+ и подобные); 1 ГБ памяти, 2 ГБ свободного места.
- Docker Engine 24+ с Compose 2.20.2+. Если Docker нет, установщик предложит поставить его через get.docker.com
  (флаг `--install-docker`).
- Для режима «домен»: доменное имя, A-запись которого указывает на сервер, и свободные порты 80 и 443.

## Установка одной командой

```sh
curl -fsSL https://github.com/melogold-app/melogoldServer/releases/latest/download/install.sh | sudo sh
```

Установщик спросит, как клиенты будут подключаться, и логин владельца. То же без вопросов:

```sh
# сервер в интернете с HTTPS
curl -fsSL …/install.sh | sudo sh -s -- --domain music.example.com --admin-login maxim --yes
# только домашняя сеть, http по IP
curl -fsSL …/install.sh | sh -s -- --lan --admin-login maxim --yes
# за вашим обратным прокси на той же машине
curl -fsSL …/install.sh | sh -s -- --proxy --public-url https://m.example.com --port 8080 --yes
```

С `--yes` пароль владельца генерируется и печатается в итоге вместе с **кодом восстановления**. Код показывается
один раз: сохраните его. Им можно сбросить пароль из любого клиента.

В конце установщик показывает QR-код адреса сервера. В приложении: «Настройки → Синхронизация → Свой сервер →
Сканировать QR».

### Режимы

| Режим | Адрес | Что открыто наружу |
|---|---|---|
| `--domain FQDN` | `https://FQDN`, сертификат Let's Encrypt через Caddy | 80/tcp, 443/tcp, 443/udp |
| `--lan` | `http://<IP в сети>:8080` | порт приложения в локальной сети |
| `--proxy` | `--public-url` вашего прокси | ничего: приложение слушает 127.0.0.1 |

`--lan` на машине с публичным IP установщик не делает без `--allow-public-http`: по http пароли идут открыто, а
опубликованный порт Docker обходит ufw.

### База данных

По умолчанию SQLite: файл в томе `melogold_data`, ничего настраивать не нужно. Для больших серверов —
`--db postgres` (PostgreSQL 18 в соседнем контейнере) или `--database-url postgres://…` (внешний; бэкапы
`melogold backup` для него не работают).

### Регистрация

- `first` (по умолчанию): аккаунт создаёт только установщик (владелец), дальше — `melogold user add <логин>`.
- `open`: регистрироваться может любой, с доказательством работы против ботов.
- `closed`: только `melogold user add`.

Владелец создаётся **до** того, как порт открывается в сеть: иначе бот, увидевший новый сертификат в логах
Certificate Transparency, успел бы занять первый аккаунт.

### Все флаги

```
--domain FQDN | --lan | --proxy     --port N     --public-url URL
--db sqlite|postgres     --database-url URL
--registration first|open|closed     --admin-login LOGIN     --name NAME
--version X | --image REF     --dir DIR     --owner USER     --subnet CIDR
--install-docker  --yes  --no-start  --no-backup-timer  --no-qr  --allow-public-http  --lang ru|en
--upgrade | --reconfigure | --repair | --uninstall [--purge] | --restore FILE
```

## Где что лежит

| Что | Где |
|---|---|
| настройки | `/opt/melogold/.env` (права 600; без root — `~/melogold`) |
| compose, Caddyfile, команда `melogold` | `/opt/melogold/` (обновляются при upgrade) |
| ваши дополнения | `compose.override.yaml`, `caddy.d/*.caddy` (не трогаются) |
| бэкапы | `/opt/melogold/backups/` |
| данные | тома Docker `melogold_data` (база SQLite и `secret.key`), `melogold_pgdata` |

## Команда `melogold`

```
melogold status                         контейнеры, версия, адрес, последний бэкап
melogold logs [app|postgres|caddy] [-f]
melogold user add <логин>               новый аккаунт (пароль вводится дважды)
melogold user list [--usage]            аккаунты и что они хранят
melogold user reset-password <логин>    новый пароль и код восстановления
melogold backup | restore FILE | verify-backup FILE
melogold upgrade                        до последнего релиза, с бэкапом и автооткатом
melogold qr                             QR-код адреса для приложений
melogold config set KEY=VALUE           изменить настройку и перезапустить
```

Подробно — [operations.md](operations.md).

## Без установщика: `docker run`

Для тех, кто собирает окружение сам:

```sh
docker run --rm -it -v melogold-data:/data ghcr.io/melogold-app/melogold-server:0.1 user add maxim   # сначала владелец
docker run -d --name melogold --restart unless-stopped -p 8080:8080 -v melogold-data:/data \
  -e PUBLIC_URL=http://192.168.1.50:8080 -e LINK_NETWORK_HINT=false ghcr.io/melogold-app/melogold-server:0.1
docker exec melogold melogold backup --out - > melogold-$(date +%F).sqlite
```

- Бэкапьте весь том: в нём лежит `secret.key`.
- Обновление: `docker pull`, затем `docker rm -f melogold` и тот же `docker run`. Миграции выполняются при старте.
- Обратный прокси на другой машине в этой схеме не поддерживается (лимиты по IP не работают). Если прокси на этой
  же машине: `docker run --network host … -e TRUST_PROXY=127.0.0.1/32`.
