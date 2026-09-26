#!/bin/sh
# melogold: the host command of a Melogold server installation (DESIGN §7.4–7.6). install.sh writes it to
# <dir>/melogold and links it as /usr/local/bin/melogold (root) or ~/.local/bin/melogold. Managed file: an upgrade
# replaces it. build.sh inlines lib.sh at the marker below.
set -eu

MELOGOLD_CLI_VERSION="@VERSION@"

# @LIB@

# --- the installation -----------------------------------------------------------------------------------------------

self_path() {
	if command -v readlink >/dev/null 2>&1 && readlink -f "$0" >/dev/null 2>&1; then readlink -f "$0"; else printf '%s\n' "$0"; fi
}

DIR=${MELOGOLD_DIR:-$(dirname "$(self_path)")}
ENV_FILE="$DIR/.env"
STATE="$DIR/.state"
BACKUPS="$DIR/backups"

need_installation() {
	[ -f "$ENV_FILE" ] || die "no Melogold installation in $DIR (.env is missing); set MELOGOLD_DIR or run install.sh"
	command -v docker >/dev/null 2>&1 || die "docker is not installed"
}

setting() { env_get "$ENV_FILE" "$1"; }

usage() {
	cat <<'EOF'
Usage: melogold <command>

  status                              containers, version, address, last backup
  logs [app|postgres|caddy] [-f]      the last log lines (-f: follow)
  start | stop | restart              restart re-reads .env
  upgrade [--version X | --image REF] [--yes] [--major]
  rollback                            back to the image and files before the last upgrade
  backup [--tag T] [--keep N] [--with-secrets]
  restore FILE [--yes] [--drop-previous] [--identity AGE_KEY]
  verify-backup FILE [--identity AGE_KEY]
  user add|reset-password|delete|list|devices|revoke-device …
  sync rotate-epoch --all|<login>
  secret rotate                       new master key; every device signs in again
  qr                                  the server address as a QR code for the apps
  config | config set KEY=VALUE
  pull-deps                           fresh postgres and caddy images of the pinned tags
  version
  uninstall [--yes] [--purge [--confirm "DELETE ALL DATA"]]
EOF
}

# --- status, logs, start/stop -------------------------------------------------------------------------------------

cmd_status() {
	need_installation
	say "Melogold $(setting MELOGOLD_MODE) · $(setting PUBLIC_URL)"
	say "image:        $(setting MELOGOLD_IMAGE)"
	say "database:     $(setting MELOGOLD_DB)"
	status_id=$(app_container)
	if [ -n "$status_id" ]; then
		say "app:          $(docker inspect -f '{{.State.Status}}{{if .State.Health}} ({{.State.Health.Status}}){{end}}, restarts {{.RestartCount}}' "$status_id")"
		status_info=$(app_cli info --json 2>/dev/null || true)
		if [ -n "$status_info" ]; then
			say "server:       $(printf '%s' "$status_info" | json_string version), id $(printf '%s' "$status_info" | json_string serverId)"
		fi
	else
		say "app:          not running (melogold start)"
	fi
	if [ -f "$STATE/last-backup" ]; then say "last backup:  $(cat "$STATE/last-backup")"; else say "last backup:  none yet"; fi
	for status_volume in melogold_data melogold_pgdata; do
		status_mount=$(docker volume inspect -f '{{.Mountpoint}}' "$status_volume" 2>/dev/null || true)
		if [ -n "$status_mount" ] && [ -r "$status_mount" ]; then
			say "$status_volume: $(du -sh "$status_mount" 2>/dev/null | cut -f1)"
		fi
	done
	say ""
	compose ps
}

cmd_logs() {
	need_installation
	logs_service=""
	logs_follow=""
	for logs_arg in "$@"; do
		case $logs_arg in
			-f | --follow) logs_follow="-f" ;;
			app | postgres | caddy) logs_service=$logs_arg ;;
			*) die "usage: melogold logs [app|postgres|caddy] [-f]" ;;
		esac
	done
	# shellcheck disable=SC2086
	compose logs --tail 200 $logs_follow $logs_service
}

cmd_start() {
	need_installation
	compose up -d
	wait_healthy 120 || die "the server did not become healthy: melogold logs app"
	say "running: $(setting PUBLIC_URL)"
}

cmd_stop() {
	need_installation
	compose stop
}

cmd_restart() {
	need_installation
	compose up -d --force-recreate
	wait_healthy 120 || die "the server did not become healthy: melogold logs app"
	say "restarted"
}

# --- backup (DESIGN §7.6) -------------------------------------------------------------------------------------------

backup_redacted_env() {
	sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD='(redacted)'/" \
		-e "s|^DATABASE_URL='postgres\\(ql\\)\\{0,1\\}://\\([^:]*\\):[^@]*@|DATABASE_URL='postgres://\\2:(redacted)@|" \
		"$ENV_FILE"
}

# cmd_backup [--tag T] [--keep N] [--with-secrets]; BACKUP_NO_LOCK=1 inside a command that holds the lock.
cmd_backup() {
	need_installation
	backup_tag=manual
	backup_keep=""
	backup_secrets=0
	while [ $# -gt 0 ]; do
		case $1 in
			--tag) backup_tag=${2:?--tag needs a value}; shift 2 ;;
			--keep) backup_keep=${2:?--keep needs a number}; shift 2 ;;
			--with-secrets) backup_secrets=1; shift ;;
			*) die "usage: melogold backup [--tag T] [--keep N] [--with-secrets]" ;;
		esac
	done
	case $backup_tag in *[!a-z0-9-]* | "") die "a tag is lowercase letters, digits and -" ;; esac
	# The nightly backups keep BACKUP_KEEP of their kind (default 14).
	if [ -z "$backup_keep" ] && [ "$backup_tag" = daily ]; then backup_keep=$(setting BACKUP_KEEP); backup_keep=${backup_keep:-14}; fi
	case $backup_keep in *[!0-9]*) die "--keep needs a number" ;; esac
	backup_recipient=$(setting BACKUP_AGE_RECIPIENT)
	if [ "$backup_secrets" = 1 ]; then
		[ -n "$backup_recipient" ] || die "--with-secrets needs BACKUP_AGE_RECIPIENT (melogold config set BACKUP_AGE_RECIPIENT=age1…)"
		command -v age >/dev/null 2>&1 || die "--with-secrets needs age (https://age-encryption.org)"
	fi
	[ "${BACKUP_NO_LOCK:-0}" = 1 ] || lock_take

	backup_db=$(setting MELOGOLD_DB)
	backup_info=$(app_cli info --json) || die "the server is not running: melogold start"
	mkdir -p "$BACKUPS"
	chmod 700 "$BACKUPS"
	backup_work=$(mktemp -d "$BACKUPS/.partial.XXXXXX")
	chmod 700 "$backup_work"
	if [ "$backup_db" = postgres ]; then
		backup_file=db.sql
		compose exec -T postgres pg_dump -U melogold -d melogold --format=plain --no-owner --no-privileges </dev/null |
			{
				cat
				printf "\nINSERT INTO public.server_meta (key, value) VALUES ('restore_pending', '1') ON CONFLICT (key) DO UPDATE SET value = excluded.value;\n"
			} >"$backup_work/$backup_file" || {
			rm -rf "$backup_work"
			die "pg_dump failed"
		}
	else
		backup_file=db.sqlite
		app_cli backup --out - >"$backup_work/$backup_file" || {
			rm -rf "$backup_work"
			die "the backup of the database failed"
		}
	fi
	backup_sha=$(sha256sum "$backup_work/$backup_file" | cut -d' ' -f1)
	backup_redacted_env >"$backup_work/env.redacted"
	cat >"$backup_work/manifest.json" <<EOF
{"format":1,"createdAt":"$(now_utc)","serverVersion":"$(printf '%s' "$backup_info" | json_string version)","serverId":"$(printf '%s' "$backup_info" | json_string serverId)","schemaVersion":$(printf '%s' "$backup_info" | json_number applied),"db":"$backup_db","file":"$backup_file","sha256":"$backup_sha"}
EOF
	backup_names="manifest.json $backup_file env.redacted"
	if [ "$backup_secrets" = 1 ]; then
		compose exec -T app /nodejs/bin/node -e 'process.stdout.write(require("fs").readFileSync("/data/secret.key"))' \
			>"$backup_work/secret.key"
		cp "$ENV_FILE" "$backup_work/env"
		backup_names="$backup_names secret.key env"
	fi
	backup_stamp=$(date -u +%Y%m%dT%H%M%SZ)
	backup_out="$BACKUPS/melogold-backup-$backup_stamp-$backup_tag.tar.gz"
	# shellcheck disable=SC2086
	(cd "$backup_work" && umask 077 && tar -czf "$backup_out.tmp" $backup_names)
	if [ "$backup_secrets" = 1 ]; then
		age -r "$backup_recipient" -o "$backup_out.age" "$backup_out.tmp"
		rm -f "$backup_out.tmp"
		backup_out="$backup_out.age"
	else
		mv "$backup_out.tmp" "$backup_out"
	fi
	chmod 600 "$backup_out"
	rm -rf "$backup_work"
	mkdir -p "$STATE"
	printf '%s %s\n' "$(now_utc)" "$backup_out" >"$STATE/last-backup"
	if [ -n "$backup_keep" ] && [ "$backup_keep" -gt 0 ]; then
		# shellcheck disable=SC2012
		ls -1t "$BACKUPS"/melogold-backup-*-"$backup_tag".tar.gz* 2>/dev/null | tail -n +"$((backup_keep + 1))" |
			while IFS= read -r backup_old; do rm -f "$backup_old"; done
	fi
	backup_hook=$(setting BACKUP_POST_HOOK)
	if [ -n "$backup_hook" ] && [ "$backup_secrets" = 1 ]; then
		BACKUP_FILE=$backup_out sh -c "$backup_hook" || warn "BACKUP_POST_HOOK failed"
	fi
	say "$backup_out"
}

# backup_unpack FILE IDENTITY → the directory with the checked contents in $unpack_dir.
backup_unpack() {
	[ -f "$1" ] || die "no such file: $1"
	unpack_dir=$(mktemp -d "${TMPDIR:-/tmp}/melogold-restore.XXXXXX")
	chmod 700 "$unpack_dir"
	unpack_archive=$1
	case $1 in
		*.age)
			[ -n "$2" ] || die "an encrypted backup needs --identity <age key file>"
			command -v age >/dev/null 2>&1 || die "decrypting needs age (https://age-encryption.org)"
			age -d -i "$2" -o "$unpack_dir/backup.tar.gz" "$1"
			unpack_archive="$unpack_dir/backup.tar.gz"
			;;
	esac
	tar -xzf "$unpack_archive" -C "$unpack_dir" --no-same-owner manifest.json 2>/dev/null ||
		die "$1 is not a Melogold backup (no manifest.json)"
	unpack_file=$(json_string file <"$unpack_dir/manifest.json")
	case $unpack_file in db.sqlite | db.sql) ;; *) die "the manifest names no database" ;; esac
	tar -xzf "$unpack_archive" -C "$unpack_dir" --no-same-owner "$unpack_file" env.redacted
	tar -xzf "$unpack_archive" -C "$unpack_dir" --no-same-owner secret.key 2>/dev/null || true
	unpack_sha=$(sha256sum "$unpack_dir/$unpack_file" | cut -d' ' -f1)
	[ "$unpack_sha" = "$(json_string sha256 <"$unpack_dir/manifest.json")" ] ||
		die "the database in $1 does not match its manifest (damaged backup)"
}

psql_admin() { compose exec -T postgres psql -U melogold -d postgres -v ON_ERROR_STOP=1 -qtA "$@"; }

cmd_verify_backup() {
	need_installation
	verify_identity=""
	verify_file=""
	while [ $# -gt 0 ]; do
		case $1 in
			--identity) verify_identity=${2:?}; shift 2 ;;
			*) verify_file=$1; shift ;;
		esac
	done
	[ -n "$verify_file" ] || die "usage: melogold verify-backup FILE [--identity AGE_KEY]"
	backup_unpack "$verify_file" "$verify_identity"
	say "manifest: $(cat "$unpack_dir/manifest.json")"
	if [ "$unpack_file" = db.sqlite ]; then
		app_run verify-backup --from - <"$unpack_dir/db.sqlite" || {
			rm -rf "$unpack_dir"
			exit 1
		}
	else
		psql_admin -c "DROP DATABASE IF EXISTS melogold_verify" -c "CREATE DATABASE melogold_verify"
		if compose exec -T postgres psql -U melogold -d melogold_verify -v ON_ERROR_STOP=1 -q --single-transaction \
			<"$unpack_dir/db.sql" >/dev/null; then
			say "rows: $(compose exec -T postgres psql -U melogold -d melogold_verify -qtA -c \
				"SELECT (SELECT count(*) FROM users) || ' accounts, ' || (SELECT count(*) FROM devices) || ' devices, ' || (SELECT count(*) FROM play_events) || ' plays'")"
			psql_admin -c "DROP DATABASE melogold_verify"
		else
			psql_admin -c "DROP DATABASE IF EXISTS melogold_verify"
			rm -rf "$unpack_dir"
			die "the dump does not load"
		fi
	fi
	rm -rf "$unpack_dir"
	say "the backup is usable"
}

cmd_restore() {
	need_installation
	restore_yes=0
	restore_drop=0
	restore_identity=""
	restore_file=""
	while [ $# -gt 0 ]; do
		case $1 in
			--yes) restore_yes=1; shift ;;
			--drop-previous) restore_drop=1; shift ;;
			--identity) restore_identity=${2:?}; shift 2 ;;
			*) restore_file=$1; shift ;;
		esac
	done
	[ -n "$restore_file" ] || die "usage: melogold restore FILE [--yes] [--drop-previous] [--identity AGE_KEY]"
	lock_take
	backup_unpack "$restore_file" "$restore_identity"
	restore_db=$(json_string db <"$unpack_dir/manifest.json")
	[ "$restore_db" = "$(setting MELOGOLD_DB)" ] ||
		die "the backup is $restore_db, this server is $(setting MELOGOLD_DB): converting is not supported yet"
	restore_server=$(json_string serverId <"$unpack_dir/manifest.json")
	say "backup of server $restore_server, $(json_string createdAt <"$unpack_dir/manifest.json"), version $(json_string serverVersion <"$unpack_dir/manifest.json")"
	if [ "$restore_yes" != 1 ]; then
		interactive || die "add --yes to restore without a terminal"
		printf 'This replaces the database of this server; every device merges silently afterwards. Type restore: '
		read -r restore_answer
		[ "$restore_answer" = restore ] || die "cancelled"
	fi
	if [ -n "$(app_container)" ] && app_cli info --json >/dev/null 2>&1; then
		say "saving the current state first…"
		BACKUP_NO_LOCK=1 cmd_backup --tag pre-restore --keep 5 >/dev/null
	fi
	compose stop app
	if [ "$restore_db" = sqlite ]; then
		app_run restore --from - --yes <"$unpack_dir/db.sqlite" || die "restore failed; the previous database is untouched or kept in /data/.pre-restore"
	else
		restore_stamp=$(date -u +%Y%m%d%H%M%S)
		psql_admin -c "DROP DATABASE IF EXISTS melogold_restoring" -c "CREATE DATABASE melogold_restoring"
		compose exec -T postgres psql -U melogold -d melogold_restoring -v ON_ERROR_STOP=1 -q --single-transaction \
			<"$unpack_dir/db.sql" >/dev/null || die "the dump does not load; the current database is untouched"
		psql_admin \
			-c "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname = 'melogold' AND pid <> pg_backend_pid()" \
			-c "ALTER DATABASE melogold RENAME TO melogold_pre_restore_$restore_stamp" \
			-c "ALTER DATABASE melogold_restoring RENAME TO melogold" >/dev/null
		app_run sync rotate-epoch --all
		if [ "$restore_drop" = 1 ]; then psql_admin -c "DROP DATABASE melogold_pre_restore_$restore_stamp"; fi
	fi
	if [ -f "$unpack_dir/secret.key" ]; then
		compose run --rm --no-deps -T --entrypoint /nodejs/bin/node app -e \
			'const fs=require("fs");const b=fs.readFileSync(0);fs.writeFileSync("/data/secret.key.tmp",b,{mode:0o600});fs.renameSync("/data/secret.key.tmp","/data/secret.key")' \
			<"$unpack_dir/secret.key"
		say "restored the master key from the backup"
	fi
	rm -rf "$unpack_dir"
	compose up -d app
	wait_healthy 120 || die "the server did not become healthy after the restore: melogold logs app"
	restore_now=$(app_cli info --json | json_string serverId)
	[ "$restore_now" = "$restore_server" ] || warn "the server id is $restore_now, the backup says $restore_server"
	say "restored; devices get 410 on their next sync and merge silently"
}

# --- upgrade and rollback (DESIGN §7.5) ------------------------------------------------------------------------------

latest_version() {
	curl -fsSLI -o /dev/null -w '%{url_effective}' "https://github.com/$MELOGOLD_REPO/releases/latest" |
		sed -n 's|.*/tag/v\([0-9][0-9.]*[0-9A-Za-z.-]*\)$|\1|p'
}

# The version of an image reference (repo:1.2.3@sha256:… → 1.2.3).
image_version() { printf '%s\n' "$1" | sed -n 's|^[^:]*:\([^@]*\).*|\1|p'; }

# Whether going from $1 to $2 changes the major version (the minor one while 0.x).
major_change() {
	major_from=$(printf '%s' "$1" | cut -d. -f1)
	major_to=$(printf '%s' "$2" | cut -d. -f1)
	if [ "$major_from" = 0 ] && [ "$major_to" = 0 ]; then
		major_from=$(printf '%s' "$1" | cut -d. -f2)
		major_to=$(printf '%s' "$2" | cut -d. -f2)
	fi
	[ "$major_from" != "$major_to" ]
}

save_managed_files() {
	mkdir -p "$STATE/prev"
	for managed in compose.yaml Caddyfile melogold; do
		if [ -f "$DIR/$managed" ]; then cp -p "$DIR/$managed" "$STATE/prev/$managed"; fi
	done
	setting MELOGOLD_IMAGE >"$STATE/prev-image"
}

# health_checks: /health, an invalid token answers 401, and in mode domain the public address answers.
health_checks() {
	wait_healthy 120 || return 1
	health_port=$(setting APP_PORT)
	health_code=$(curl -s -o /dev/null -w '%{http_code}' -H 'Authorization: Bearer invalid' \
		"http://127.0.0.1:${health_port:-8080}/auth/me" || true)
	[ "$health_code" = 401 ] || return 1
	if [ "$(setting MELOGOLD_MODE)" = domain ]; then
		health_public=$(setting PUBLIC_URL)
		health_left=180
		until curl -fsS -o /dev/null "$health_public/health"; do
			health_left=$((health_left - 5))
			[ "$health_left" -gt 0 ] || return 1
			sleep 5
		done
	fi
	return 0
}

cmd_rollback() {
	need_installation
	[ "${ROLLBACK_NO_LOCK:-0}" = 1 ] || lock_take
	[ -s "$STATE/prev-image" ] || die "nothing to roll back to"
	rollback_image=$(cat "$STATE/prev-image")
	for managed in compose.yaml Caddyfile melogold; do
		if [ -f "$STATE/prev/$managed" ]; then cp -p "$STATE/prev/$managed" "$DIR/$managed"; fi
	done
	env_set "$ENV_FILE" MELOGOLD_IMAGE "$rollback_image"
	compose up -d --remove-orphans
	wait_healthy 120 || die "the previous version did not become healthy either: melogold logs app"
	printf '%s rollback %s\n' "$(now_utc)" "$rollback_image" >>"$STATE/upgrade-history.log"
	say "rolled back to $rollback_image"
}

cmd_upgrade() {
	need_installation
	upgrade_version=""
	upgrade_image=""
	upgrade_yes=0
	upgrade_major=0
	while [ $# -gt 0 ]; do
		case $1 in
			--version) upgrade_version=${2:?}; shift 2 ;;
			--image) upgrade_image=${2:?}; shift 2 ;;
			--yes) upgrade_yes=1; shift ;;
			--major) upgrade_major=1; shift ;;
			*) die "usage: melogold upgrade [--version X | --image REF] [--yes] [--major]" ;;
		esac
	done
	command -v curl >/dev/null 2>&1 || die "upgrade needs curl"
	lock_take
	upgrade_current=$(setting MELOGOLD_IMAGE)
	upgrade_from=$(image_version "$upgrade_current")
	save_managed_files

	if [ -n "$upgrade_image" ]; then
		upgrade_ref=$upgrade_image
		upgrade_to=$(image_version "$upgrade_image")
	else
		[ -n "$upgrade_version" ] || upgrade_version=$(latest_version)
		[ -n "$upgrade_version" ] || die "cannot find the latest release of $MELOGOLD_REPO"
		upgrade_to=$upgrade_version
		if [ "$upgrade_to" = "$upgrade_from" ]; then
			say "already at $upgrade_to"
			return 0
		fi
		if major_change "$upgrade_from" "$upgrade_to" && [ "$upgrade_major" != 1 ]; then
			die "$upgrade_from → $upgrade_to is a major upgrade: read the release notes, then add --major"
		fi
		upgrade_tmp=$(mktemp -d "${TMPDIR:-/tmp}/melogold-upgrade.XXXXXX")
		for upgrade_asset in install.sh SHA256SUMS; do
			curl -fsSL -o "$upgrade_tmp/$upgrade_asset" \
				"https://github.com/$MELOGOLD_REPO/releases/download/v$upgrade_to/$upgrade_asset" ||
				die "cannot download $upgrade_asset of v$upgrade_to"
		done
		curl -fsSL -o "$upgrade_tmp/SHA256SUMS.minisig" \
			"https://github.com/$MELOGOLD_REPO/releases/download/v$upgrade_to/SHA256SUMS.minisig" 2>/dev/null ||
			printf 'untrusted comment: this release is not signed\n' >"$upgrade_tmp/SHA256SUMS.minisig"
		chmod 755 "$upgrade_tmp"
		chmod 644 "$upgrade_tmp"/*
		# The signature is checked by the image already running here (m25), not by the download itself.
		if ! docker run --rm --network none -v "$upgrade_tmp:/release:ro" "$upgrade_current" \
			verify-release /release/SHA256SUMS /release/SHA256SUMS.minisig /release/install.sh; then
			upgrade_why=$(docker run --rm --network none -v "$upgrade_tmp:/release:ro" "$upgrade_current" \
				verify-release /release/SHA256SUMS /release/SHA256SUMS.minisig 2>&1 || true)
			if printf '%s' "$upgrade_why" | grep -q 'no release key' ||
				grep -q 'this release is not signed' "$upgrade_tmp/SHA256SUMS.minisig"; then
				warn "no release signature to check (unsigned release or no key in this version): only the checksum of install.sh"
				(cd "$upgrade_tmp" && grep ' install.sh$' SHA256SUMS | sha256sum -c -) || die "install.sh does not match SHA256SUMS"
			else
				rm -rf "$upgrade_tmp"
				die "the release signature does not verify: not upgrading"
			fi
		fi
		sh "$upgrade_tmp/install.sh" --managed-files --dir "$DIR" --yes || die "updating the managed files failed"
		rm -rf "$upgrade_tmp"
		upgrade_ref="$MELOGOLD_IMAGE_REPO:$upgrade_to"
	fi
	compose config -q || die "the new compose.yaml does not validate with your .env (melogold rollback)"

	if ! docker pull "$upgrade_ref"; then
		docker image inspect "$upgrade_ref" >/dev/null 2>&1 || die "cannot pull $upgrade_ref"
		warn "using the local image $upgrade_ref"
	fi
	upgrade_digest=$(docker image inspect -f '{{index .RepoDigests 0}}' "$upgrade_ref" 2>/dev/null | sed -n 's/.*@//p')
	upgrade_pinned=$upgrade_ref
	case $upgrade_ref in *@*) ;; *) [ -z "$upgrade_digest" ] || upgrade_pinned="$upgrade_ref@$upgrade_digest" ;; esac
	upgrade_schema=$(docker image inspect -f '{{index .Config.Labels "app.melogold.compose-schema"}}' "$upgrade_ref")
	[ "$upgrade_schema" = 1 ] || die "$upgrade_ref needs compose schema $upgrade_schema; this installation has 1"

	if [ "$upgrade_yes" != 1 ] && interactive; then
		ask "Upgrade $upgrade_from → $upgrade_to?" y || die "cancelled"
	fi
	say "saving a backup first…"
	BACKUP_NO_LOCK=1 cmd_backup --tag pre-upgrade --keep 5 >/dev/null
	say "migrating the database…"
	MELOGOLD_IMAGE=$upgrade_pinned compose run --rm --no-deps -T app migrate </dev/null ||
		die "the migration failed; the server still runs $upgrade_from (the database is unchanged: migrations run in one transaction)"
	env_set "$ENV_FILE" MELOGOLD_IMAGE "$upgrade_pinned"
	compose up -d --remove-orphans
	if ! health_checks; then
		warn "the new version failed its checks; rolling back"
		compose logs --tail 50 app >&2 || true
		ROLLBACK_NO_LOCK=1 cmd_rollback
		exit 1
	fi
	printf '%s upgrade %s -> %s\n' "$(now_utc)" "$upgrade_current" "$upgrade_pinned" >>"$STATE/upgrade-history.log"
	say "upgraded to $upgrade_to"
}

# --- commands of the image ------------------------------------------------------------------------------------------

cmd_user() {
	need_installation
	case ${1:-} in
		add | reset-password | delete) app_cli_tty user "$@" ;;
		list | devices | revoke-device) app_cli user "$@" ;;
		*) die "usage: melogold user add|reset-password|delete|list|devices|revoke-device …" ;;
	esac
}

cmd_sync() {
	need_installation
	[ "${1:-}" = rotate-epoch ] || die "usage: melogold sync rotate-epoch --all|<login>"
	shift
	app_cli sync rotate-epoch "$@"
	if [ "${1:-}" = --all ]; then cmd_restart; fi
}

cmd_secret() {
	need_installation
	[ "${1:-}" = rotate ] || die "usage: melogold secret rotate"
	ask "Every device will have to sign in again. Rotate the master key?" n || die "cancelled"
	app_cli secret rotate
	cmd_restart
}

cmd_qr() {
	need_installation
	app_cli qr --color "$@"
	say "Melogold → Настройки → Синхронизация → Свой сервер → Сканировать QR"
}

cmd_config() {
	need_installation
	case ${1:-} in
		"")
			backup_redacted_env
			;;
		set)
			config_pair=${2:-}
			case $config_pair in *=*) ;; *) die "usage: melogold config set KEY=VALUE" ;; esac
			config_key=${config_pair%%=*}
			config_value=${config_pair#*=}
			case $config_key in
				MELOGOLD_IMAGE) die "use melogold upgrade to change the image" ;;
			esac
			env_set "$ENV_FILE" "$config_key" "$config_value"
			compose config -q || die "compose does not accept the new value; fix it with melogold config set"
			compose up -d
			say "$config_key set; changed containers were recreated"
			;;
		*) die "usage: melogold config | melogold config set KEY=VALUE" ;;
	esac
}

cmd_pull_deps() {
	need_installation
	compose pull postgres caddy 2>/dev/null || compose pull
	compose up -d
}

cmd_version() {
	say "melogold host command $MELOGOLD_CLI_VERSION"
	if [ -f "$ENV_FILE" ]; then say "image $(setting MELOGOLD_IMAGE)"; fi
}

# uninstall [--yes] [--purge [--confirm "DELETE ALL DATA"]]: --confirm is for scripts, a terminal asks instead.
cmd_uninstall() {
	need_installation
	uninstall_purge=0
	uninstall_yes=0
	uninstall_confirm=""
	while [ $# -gt 0 ]; do
		case $1 in
			--purge) uninstall_purge=1; shift ;;
			--yes) uninstall_yes=1; shift ;;
			--confirm) uninstall_confirm=${2:-}; shift 2 ;;
			*) die "usage: melogold uninstall [--yes] [--purge [--confirm \"DELETE ALL DATA\"]]" ;;
		esac
	done
	if [ "$uninstall_purge" = 1 ]; then
		if [ -z "$uninstall_confirm" ]; then
			interactive || die "--purge needs a terminal, or --confirm \"DELETE ALL DATA\""
			printf 'This deletes the database, the master key and the backups in %s. Type DELETE ALL DATA: ' "$DIR"
			read -r uninstall_confirm
		fi
		[ "$uninstall_confirm" = "DELETE ALL DATA" ] || die "cancelled"
		compose down --volumes --remove-orphans
	else
		[ "$uninstall_yes" = 1 ] || ask "Stop and remove the Melogold containers (data and backups stay)?" n || die "cancelled"
		compose down --remove-orphans
	fi
	if [ -f /etc/systemd/system/melogold-backup.timer ] && [ "$(id -u)" = 0 ]; then
		systemctl disable --now melogold-backup.timer >/dev/null 2>&1 || true
		rm -f /etc/systemd/system/melogold-backup.timer /etc/systemd/system/melogold-backup.service
		systemctl daemon-reload || true
	elif command -v crontab >/dev/null 2>&1; then
		(crontab -l 2>/dev/null | grep -v "$DIR/melogold backup") | crontab - 2>/dev/null || true
	fi
	for uninstall_link in /usr/local/bin/melogold "${HOME:-/root}/.local/bin/melogold"; do
		if [ -L "$uninstall_link" ]; then rm -f "$uninstall_link"; fi
	done
	if [ "$uninstall_purge" = 1 ]; then
		rm -rf "$DIR"
		say "Melogold and all its data are removed"
	else
		say "containers removed; data volumes, $DIR/.env and backups stay (melogold uninstall --purge removes them)"
	fi
}

main() {
	melogold_command=${1:-help}
	[ $# -gt 0 ] && shift
	case $melogold_command in
		status) cmd_status "$@" ;;
		logs) cmd_logs "$@" ;;
		start) cmd_start "$@" ;;
		stop) cmd_stop "$@" ;;
		restart) cmd_restart "$@" ;;
		upgrade) cmd_upgrade "$@" ;;
		rollback) cmd_rollback "$@" ;;
		backup) cmd_backup "$@" ;;
		restore) cmd_restore "$@" ;;
		verify-backup) cmd_verify_backup "$@" ;;
		user) cmd_user "$@" ;;
		sync) cmd_sync "$@" ;;
		secret) cmd_secret "$@" ;;
		qr) cmd_qr "$@" ;;
		config) cmd_config "$@" ;;
		pull-deps) cmd_pull_deps "$@" ;;
		version | --version) cmd_version ;;
		uninstall) cmd_uninstall "$@" ;;
		help | --help | -h) usage ;;
		*)
			usage >&2
			exit 64
			;;
	esac
}

main "$@"
