#!/bin/sh
# Builds the one-file installer and the host command (DESIGN §7.3, PLAN T3.2):
#
#   deploy/installer/build.sh [VERSION] [OUTDIR]     → OUTDIR/install.sh and OUTDIR/melogold (default dist/)
#
# lib.sh replaces the `# @LIB@` line of both, the templates and the host command go into heredocs of install.sh,
# @VERSION@ becomes VERSION (default: the version of package.json). The release workflow publishes install.sh.
set -eu

HERE=$(cd "$(dirname "$0")" && pwd)
ROOT=$(cd "$HERE/../.." && pwd)
VERSION=${1:-$(sed -n 's/^  "version": "\(.*\)",$/\1/p' "$ROOT/package.json")}
OUT=${2:-$ROOT/dist}
mkdir -p "$OUT"

case $VERSION in "" | *[!0-9A-Za-z.+-]*) echo "build.sh: bad version: $VERSION" >&2; exit 1 ;; esac

# A heredoc must not contain its own delimiter as a line.
for pair in "compose.yaml:MELOGOLD_COMPOSE_EOF" "Caddyfile:MELOGOLD_CADDYFILE_EOF"; do
	file=${pair%%:*}
	if grep -qx "${pair#*:}" "$ROOT/deploy/templates/$file"; then echo "build.sh: $file contains ${pair#*:}" >&2; exit 1; fi
done
if grep -qx MELOGOLD_HOST_CLI_EOF "$HERE/melogold.sh" "$HERE/lib.sh"; then echo "build.sh: a delimiter inside the host command" >&2; exit 1; fi

# inline FILE MARKER CONTENT_FILE: prints FILE with the line MARKER replaced by CONTENT_FILE (its first line dropped
# when it is a shellcheck directive).
inline() {
	awk -v marker="$2" -v content="$3" '
		$0 == marker {
			first = 1
			while ((getline line < content) > 0) {
				if (first && line ~ /^# shellcheck shell=/) { first = 0; continue }
				first = 0
				print line
			}
			close(content)
			next
		}
		{ print }
	' "$1"
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

inline "$HERE/melogold.sh" "# @LIB@" "$HERE/lib.sh" | sed "s/@VERSION@/$VERSION/g" >"$tmp/melogold"
inline "$HERE/install.sh.in" "# @LIB@" "$HERE/lib.sh" >"$tmp/1"
inline "$tmp/1" "@COMPOSE@" "$ROOT/deploy/templates/compose.yaml" >"$tmp/2"
inline "$tmp/2" "@CADDYFILE@" "$ROOT/deploy/templates/Caddyfile" >"$tmp/3"
inline "$tmp/3" "@HOSTCLI@" "$tmp/melogold" | sed "s/@VERSION@/$VERSION/g" >"$tmp/install.sh"

chmod 755 "$tmp/install.sh" "$tmp/melogold"
mv -f "$tmp/install.sh" "$OUT/install.sh"
mv -f "$tmp/melogold" "$OUT/melogold"
echo "$OUT/install.sh ($VERSION)"
