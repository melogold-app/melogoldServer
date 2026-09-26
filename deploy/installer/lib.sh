# shellcheck shell=sh
# Shared functions of install.sh and the host command `melogold` (DESIGN §7.3, §7.4). build.sh inlines this file
# into both, so each stays one POSIX sh file. No `local`: helper variables carry the function's prefix.

# shellcheck disable=SC2034 # used by the host command, not by install.sh
MELOGOLD_REPO="melogold-app/melogoldServer"
MELOGOLD_IMAGE_REPO="ghcr.io/melogold-app/melogold-server"

# --- output --------------------------------------------------------------------------------------------------------

say() { printf '%s\n' "$*"; }
warn() { printf '! %s\n' "$*" >&2; }
die() {
	printf 'melogold: %s\n' "$*" >&2
	exit 1
}

# Whether stdin and stdout are a terminal (questions, colors, `docker compose exec` with a TTY).
interactive() { [ -t 0 ] && [ -t 1 ]; }

# ask "Question" default(y|n): yes → 0. Without a terminal the default answers.
ask() {
	ask_default=$2
	if ! interactive; then
		[ "$ask_default" = y ]
		return
	fi
	if [ "$ask_default" = y ]; then ask_hint="[Y/n]"; else ask_hint="[y/N]"; fi
	printf '%s %s ' "$1" "$ask_hint"
	read -r ask_answer || ask_answer=""
	case $ask_answer in
		[yYдД]*) return 0 ;;
		[nNнН]*) return 1 ;;
		*) [ "$ask_default" = y ] ;;
	esac
}

# --- .env: KEY='value' lines, values without ' and line breaks (m24) --------------------------------------------------

# env_get FILE KEY → the value, or nothing.
env_get() {
	[ -f "$1" ] || return 0
	sed -n "s/^$2='\\(.*\\)'\$/\\1/p" "$1" | tail -n 1
}

# env_valid_value VALUE: no single quote, no line break, no NUL.
env_valid_value() {
	case $1 in
		*"'"* | *"
"*) return 1 ;;
	esac
	return 0
}

# env_set FILE KEY VALUE: replaces or appends the line, atomically, mode 600.
env_set() {
	env_set_file=$1
	env_set_key=$2
	env_set_value=$3
	env_valid_value "$env_set_value" || die "the value of $env_set_key may not contain ' or a line break"
	case $env_set_key in
		*[!A-Z0-9_]* | "") die "not a setting name: $env_set_key" ;;
	esac
	env_set_tmp="$env_set_file.tmp.$$"
	(
		umask 077
		if [ -f "$env_set_file" ]; then
			grep -v "^$env_set_key=" "$env_set_file" >"$env_set_tmp" || true
		else
			: >"$env_set_tmp"
		fi
		printf "%s='%s'\n" "$env_set_key" "$env_set_value" >>"$env_set_tmp"
	)
	mv -f "$env_set_tmp" "$env_set_file"
	chmod 600 "$env_set_file"
}

# env_add_missing FILE KEY VALUE: only when the key is absent (upgrades add new settings, keep the chosen ones).
env_add_missing() {
	if ! grep -q "^$2=" "$1" 2>/dev/null; then env_set "$1" "$2" "$3"; fi
}

# --- JSON of our own commands (one line, flat fields) -----------------------------------------------------------------

json_string() { sed -n "s/.*\"$1\":\"\\([^\"]*\\)\".*/\\1/p"; }
json_number() { sed -n "s/.*\"$1\":\\([0-9][0-9]*\\).*/\\1/p"; }

# --- docker compose -----------------------------------------------------------------------------------------------

# compose ARGS…: docker compose on the installation in $DIR, with compose.override.yaml when there is one.
compose() {
	if [ -f "$DIR/compose.override.yaml" ]; then
		docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" -f "$DIR/compose.override.yaml" \
			--env-file "$DIR/.env" "$@"
	else
		docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" --env-file "$DIR/.env" "$@"
	fi
}

# The container id of the app service, or nothing.
app_container() { compose ps -q app 2>/dev/null | head -n 1; }

# wait_healthy SECONDS: the image's HEALTHCHECK (GET /health) of the app says healthy.
wait_healthy() {
	wait_healthy_left=$1
	while [ "$wait_healthy_left" -gt 0 ]; do
		wait_healthy_id=$(app_container)
		if [ -n "$wait_healthy_id" ]; then
			wait_healthy_state=$(docker inspect -f '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' "$wait_healthy_id" 2>/dev/null || true)
			case $wait_healthy_state in
				healthy) return 0 ;;
				exited | dead) return 1 ;;
			esac
		fi
		sleep 2
		wait_healthy_left=$((wait_healthy_left - 2))
	done
	return 1
}

# app_cli ARGS…: `melogold ARGS` inside the running app container, without a terminal.
app_cli() { compose exec -T app melogold "$@"; }

# app_cli_tty ARGS…: the same with a terminal when there is one (passwords are typed there).
app_cli_tty() {
	if interactive; then compose exec app melogold "$@"; else compose exec -T app melogold "$@"; fi
}

# app_run ARGS…: `melogold ARGS` in a one-off container of the app image (server stopped: migrate, restore).
app_run() { compose run --rm --no-deps -T app "$@"; }

# --- misc ---------------------------------------------------------------------------------------------------------

# A random [A-Za-z0-9] string of $1 characters from /dev/urandom.
random_token() {
	LC_ALL=C tr -dc 'A-Za-z0-9' </dev/urandom 2>/dev/null | dd bs=1 count="$1" 2>/dev/null
}

now_utc() { date -u +%Y-%m-%dT%H:%M:%SZ; }

# The lock of an installation: one install, upgrade, backup or restore at a time.
lock_take() {
	mkdir -p "$DIR/.state"
	if ! mkdir "$DIR/.state/lock" 2>/dev/null; then
		die "another melogold command is running on $DIR (remove $DIR/.state/lock if it is not)"
	fi
	LOCK_HELD=1
	trap 'lock_release' EXIT
	trap 'lock_release; exit 130' INT TERM
}

lock_release() {
	if [ "${LOCK_HELD:-0}" = 1 ]; then
		rmdir "$DIR/.state/lock" 2>/dev/null || true
		LOCK_HELD=0
	fi
}
