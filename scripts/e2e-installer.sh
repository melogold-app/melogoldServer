#!/bin/sh
# The installer end to end on a clean Linux host (PLAN T3.3): install.sh --lan with the image under test, then the
# host command: status → user add → backup → verify → writes → restore → the old cursor is 410 → install again
# without changes → upgrade → rollback → uninstall --purge.
#
#   sudo scripts/e2e-installer.sh <image> <path to built install.sh> <sqlite|postgres>
#
# Needs curl and jq. The upgrade goes to the same image under a second tag (the previous release is used once there is
# one); what it checks is the upgrade path itself: backup, migrate, restart, health checks, history, rollback.
set -eu

IMAGE=${1:?image}
INSTALLER=${2:?install.sh}
DB=${3:?sqlite or postgres}
DIR=/opt/melogold-e2e
M="$DIR/melogold"
LOG=$(mktemp)

step() { printf '\n=== %s\n' "$*"; }
fail() {
	printf 'E2E FAILED: %s\n' "$*" >&2
	docker compose --project-directory "$DIR" -f "$DIR/compose.yaml" --env-file "$DIR/.env" logs --tail 80 >&2 || true
	exit 1
}
setting() { sed -n "s/^$1='\\(.*\\)'\$/\\1/p" "$DIR/.env"; }

api() {
	# api METHOD PATH JSON [TOKEN] → body on stdout, status in $API_STATUS
	api_out=$(mktemp)
	API_STATUS=$(curl -s -o "$api_out" -w '%{http_code}' -X "$1" "$URL$2" -H 'content-type: application/json' \
		-H 'x-sync-protocol: 1' ${4:+-H "authorization: Bearer $4"} --data "$3")
	cat "$api_out"
	rm -f "$api_out"
}

LIKES=0
like() {
	# like TOKEN CURSOR → the new cursor
	LIKES=$((LIKES + 1))
	like_body=$(api POST /sync "{\"cursor\":\"$2\",\"ops\":[{\"opId\":\"$(cat /proc/sys/kernel/random/uuid)\",\"kind\":\"like.set\",\"at\":\"$(date -u +%Y-%m-%dT%H:%M:%S.000Z)\",\"videoId\":\"e2e$(printf '%08d' "$LIKES")\",\"liked\":true}]}" "$1")
	[ "$API_STATUS" = 200 ] || fail "sync answered $API_STATUS: $like_body"
	printf '%s' "$like_body" | jq -r .cursor
}

login() {
	login_body=$(api POST /auth/login "{\"login\":\"owner1\",\"password\":\"$PASSWORD\",\"device\":{\"hwid\":\"$(printf '%064d' 7)\",\"name\":\"e2e\",\"platform\":\"linux\"}}")
	[ "$API_STATUS" = 200 ] || fail "login answered $API_STATUS: $login_body"
	printf '%s' "$login_body" | jq -r .tokens.accessToken
}

step "install ($DB)"
sh "$INSTALLER" --lan --dir "$DIR" --db "$DB" --image "$IMAGE" --admin-login owner1 --yes \
	--no-backup-timer --no-qr --lang en | tee "$LOG" || fail "install.sh"
PASSWORD=$(sed -n 's/^Password: *//p' "$LOG")
[ -n "$PASSWORD" ] || fail "no generated password in the summary"
URL="http://127.0.0.1:$(setting APP_PORT)"
[ "$(stat -c %a "$DIR/.env")" = 600 ] || fail ".env is not 600"
grep -q "^REGISTRATION='first'" "$DIR/.env" || fail "registration is not first"

step "status"
"$M" status | tee "$LOG"
grep -q 'healthy' "$LOG" || fail "status does not say healthy"

step "registration is closed after the owner"
api POST /auth/register '{"login":"intruder","password":"две собаки и кот","device":{"hwid":"'"$(printf '%064d' 9)"'","name":"x","platform":"android"}}' >/dev/null
[ "$API_STATUS" = 403 ] || fail "register answered $API_STATUS, expected 403"

step "user add, user list"
"$M" user add second --generate-password | grep -q '^password: ' || fail "user add"
"$M" user list | grep -q '^owner1 ' || fail "user list"

step "writes, backup, verify"
TOKEN=$(login)
CURSOR=$(like "$TOKEN" "")
BACKUP=$("$M" backup --tag e2e | tail -n 1)
[ -f "$BACKUP" ] || fail "no backup file"
[ "$(stat -c %a "$BACKUP")" = 600 ] || fail "the backup is not 600"
"$M" verify-backup "$BACKUP" || fail "verify-backup"
for _ in 1 2 3; do CURSOR=$(like "$TOKEN" "$CURSOR"); done
OLD_CURSOR=$CURSOR

step "restore"
"$M" restore "$BACKUP" --yes || fail "restore"
TOKEN=$(login)
FRESH=$(like "$TOKEN" "")
while [ "$(printf '%s' "$FRESH" | cut -d. -f2)" -le "$(printf '%s' "$OLD_CURSOR" | cut -d. -f2)" ]; do
	FRESH=$(like "$TOKEN" "$FRESH")
done
api POST /sync "{\"cursor\":\"$OLD_CURSOR\"}" "$TOKEN" >/dev/null
[ "$API_STATUS" = 410 ] || fail "the old cursor answered $API_STATUS after the restore, expected 410"

step "install again without changes (--repair)"
cp "$DIR/.env" "$LOG.env"
sh "$INSTALLER" --repair --dir "$DIR" --yes --lang en || fail "--repair"
cmp -s "$DIR/.env" "$LOG.env" || fail "--repair changed .env"

step "upgrade and rollback"
docker tag "$IMAGE" "$IMAGE-next"
"$M" upgrade --image "$IMAGE-next" --yes || fail "upgrade"
grep -q "^MELOGOLD_IMAGE='$IMAGE-next'" "$DIR/.env" || fail "upgrade did not switch the image"
grep -q ' upgrade ' "$DIR/.state/upgrade-history.log" || fail "no upgrade history"
ls "$DIR"/backups/melogold-backup-*-pre-upgrade.tar.gz >/dev/null 2>&1 || fail "no pre-upgrade backup"
"$M" rollback || fail "rollback"
grep -q "^MELOGOLD_IMAGE='$IMAGE'" "$DIR/.env" || fail "rollback did not switch back"
api POST /sync "{\"cursor\":\"$FRESH\"}" "$(login)" >/dev/null
[ "$API_STATUS" = 200 ] || fail "sync after the rollback answered $API_STATUS"

step "uninstall --purge"
"$M" uninstall --purge --confirm "DELETE ALL DATA" || fail "uninstall"
[ ! -d "$DIR" ] || fail "$DIR is still there"
if docker volume inspect melogold_data >/dev/null 2>&1; then fail "the data volume is still there"; fi

printf '\nE2E OK (%s)\n' "$DB"
