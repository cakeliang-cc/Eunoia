#!/usr/bin/env bash
#
# Back up the local Postgres database to backups/.
#
# The named Docker volume is not a backup: `docker compose down -v` removes it,
# and a volume that only exists on one disk is one disk failure away from being
# the only copy. This writes a custom-format dump and then asks pg_restore to
# read its table of contents, so a truncated dump fails here rather than during
# the restore nobody has tried yet.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

umask 077
mkdir -p backups

STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
FILE="backups/designfree-${STAMP}.dump"

docker compose exec -T db pg_dump -U designfree -Fc designfree > "$FILE"

if [ ! -s "$FILE" ]; then
  printf 'backup failed: %s is empty\n' "$FILE" >&2
  exit 1
fi

# A dump that cannot be listed cannot be restored. This is cheap and catches
# the common failure of a command that wrote an error message into the file.
docker compose exec -T db pg_restore --list < "$FILE" > /dev/null

printf 'backup: %s (%s)\n' "$FILE" "$(du -h "$FILE" | cut -f1)"
