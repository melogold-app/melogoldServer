# Эксплуатация сервера Melogold

Команды — для установки через `install.sh` (`melogold …` на хосте). Внутри образа те же операции делает
`docker compose exec app melogold …` (CLI образа, `melogold help`).

## Бэкапы

Установщик ставит ежедневный бэкап: таймер systemd `melogold-backup` (03:30 UTC ± 30 мин) или cron без root.
Хранятся `BACKUP_KEEP` последних (по умолчанию 14) в `/opt/melogold/backups/`.

```sh
melogold backup                          # вручную, тег manual
melogold backup --tag before-move --keep 3
melogold verify-backup backups/melogold-backup-…tar.gz
```

Архив `melogold-backup-<время>-<тег>.tar.gz` (права 600):

- `manifest.json` — версия сервера, его id, число миграций, тип базы, sha256 базы;
- `db.sqlite` (копия через `VACUUM INTO`) или `db.sql` (plain-дамп PostgreSQL);
- `env.redacted` — настройки без паролей.

В каждой копии базы стоит флаг `restore_pending`: восстановленная база, даже руками, при старте выдаст всем
аккаунтам новый epoch синхронизации. Устройства получат `410 cursor_invalid` и тихо сольют свои данные с сервером,
поэтому записанное после бэкапа вернётся с устройств. Удаления, сделанные после бэкапа, при этом воскреснут.

### Бэкап с секретами (вне сервера)

`secret.key` (мастер-ключ токенов) в обычный бэкап не входит. Для копий на другую машину:

```sh
melogold config set BACKUP_AGE_RECIPIENT=age1…   # публичный ключ age
melogold backup --with-secrets                   # → …tar.gz.age, внутри ещё secret.key и полный .env
melogold config set BACKUP_POST_HOOK='rclone copyto "$BACKUP_FILE" remote:melogold/'
```

Хук запускается только для зашифрованных бэкапов. Без `secret.key` восстановленный сервер работает, но все
устройства войдут заново.

## Восстановление

```sh
melogold restore backups/melogold-backup-…tar.gz            # спросит подтверждение
melogold restore …tar.gz.age --identity ~/age-key.txt --yes
```

Порядок: проверка архива и sha256 → бэкап текущего состояния (`pre-restore`) → остановка приложения →
SQLite: копия ставится на место, прежняя база сохраняется в `/data/.pre-restore/<время>/`; PostgreSQL: дамп
грузится в `melogold_restoring`, затем имена баз меняются местами, прежняя остаётся как
`melogold_pre_restore_<время>` (`--drop-previous` удаляет её) → смена epoch → запуск и сверка id сервера.

Тип базы бэкапа и сервера должен совпадать: перенос SQLite ↔ PostgreSQL пока не поддерживается.

### Перенос на новый сервер

```sh
curl -fsSL …/install.sh | sudo sh -s -- --domain music.example.com --restore ./melogold-backup-….tar.gz --yes
```

После переноса обновите A-запись домена. Для режима `lan` адрес меняется: отсканируйте QR заново на устройствах.

### Откат снапшота ВМ или тома

Такой откат сервер обнаружить не может. После него обязательно:

```sh
melogold sync rotate-epoch --all     # ставит флаг и перезапускает сервер
```

## Обновление

```sh
melogold upgrade                  # до последнего релиза
melogold upgrade --version 0.2.1  # до конкретного
melogold upgrade --major          # смена мажорной версии (при 0.x — минорной): сначала прочитайте заметки к релизу
melogold rollback                 # вернуть образ и файлы до последнего обновления
```

Что делает `upgrade`:
1. Скачивает `install.sh`, `SHA256SUMS` и `SHA256SUMS.minisig` релиза. Подпись проверяет **уже работающий** образ
   (публичный ключ вшит в него), затем хеш `install.sh`.
2. Обновляет управляемые файлы (`compose.yaml`, `Caddyfile`, `melogold`; прежние — в `.state/prev/`) и дописывает
   в `.env` новые настройки, не трогая ваши.
3. Делает бэкап `pre-upgrade`, выполняет миграции одной транзакцией (упала — сервер остаётся на прежней версии).
4. Перезапускает и проверяет `/health`, ответ `401` на неверный токен и публичный адрес. Провал — автооткат.

История — `/opt/melogold/.state/upgrade-history.log`. Автообновление не предлагается: обновляйте, когда можете
посмотреть на результат.

## Аккаунты

```sh
melogold user add anna                  # пароль вводится дважды; --generate-password — сгенерировать
melogold user list --usage
melogold user devices anna
melogold user revoke-device anna <id>   # устройство попросит войти заново
melogold user reset-password anna       # новый пароль и код восстановления, все устройства выходят
melogold user delete anna               # данные удаляются в течение 15 минут
```

## Секрет сервера

```sh
melogold secret rotate      # новый secret.key и перезапуск: все устройства войдут заново
```

Данные и коды восстановления не затрагиваются.

## Сброс пароля PostgreSQL

Пароль встроенного PostgreSQL лежит в `.env` (`POSTGRES_PASSWORD`, он же в `DATABASE_URL`). Если его нужно
сменить:

```sh
cd /opt/melogold
docker compose exec postgres psql -U melogold -d postgres -c "ALTER USER melogold PASSWORD 'новый'"
melogold config set POSTGRES_PASSWORD=новый
melogold config set DATABASE_URL=postgres://melogold:новый@postgres:5432/melogold
```

## Диагностика

```sh
melogold status
melogold logs app -f
docker compose -f /opt/melogold/compose.yaml exec app melogold check-config
docker compose -f /opt/melogold/compose.yaml exec app melogold info
```

- Сервер отвечает `503 storage_full`, если на диске меньше `DISK_MIN_FREE_PERCENT` (10 %) свободного места.
- Режим domain: сертификат не выпускается, если домен не указывает на сервер или порт 80 закрыт снаружи
  (`melogold logs caddy`).

## Удаление

```sh
melogold uninstall            # контейнеры; данные, .env и бэкапы остаются
melogold uninstall --purge    # всё, включая данные: попросит набрать DELETE ALL DATA
```
