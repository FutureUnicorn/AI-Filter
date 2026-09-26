#!/bin/sh

# Real, synthetic PostgreSQL + MinIO backup/restore drill. Requires Docker and
# OpenSSL, never uses hosted credentials or a hosted Docker Compose project.
set -eu
repository_root="$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)"
project="af69-drill-$(date +%s)-$$"
cert_dir="$(mktemp -d "$repository_root/.af69-cert.XXXXXX")"
case "$cert_dir" in "$repository_root"/.af69-cert.*) ;; *) exit 2 ;; esac
cleanup() {
  status=$?
  if [ "$status" -ne 0 ]; then
    docker compose --project-name "$project" \
      -f "$repository_root/infra/compose/restore.yml" \
      -f "$repository_root/tests/fixtures/backups/compose.yml" \
      logs --no-color source-seed source-storage source-storage-seed backup-target backup-init backup-once restore 2>/dev/null || true
  fi
  docker compose --project-name "$project" \
    -f "$repository_root/infra/compose/restore.yml" \
    -f "$repository_root/tests/fixtures/backups/compose.yml" \
    down --volumes --remove-orphans >/dev/null 2>&1 || true
  rm -rf -- "$cert_dir"
}
trap cleanup EXIT HUP INT TERM

if command -v cygpath >/dev/null 2>&1; then
  export AF69_CERT_DIR="$(cygpath -w "$cert_dir")"
  export AF69_CERT_FILE="$(cygpath -w "$cert_dir/public.crt")"
else
  export AF69_CERT_DIR="$cert_dir"
  export AF69_CERT_FILE="$cert_dir/public.crt"
fi
export RESTORE_SOURCE_ENV=staging BACKUP_ENDPOINT=https://backup-target:9000
export BACKUP_REGION=us-east-1 BACKUP_BUCKET=af69-target BACKUP_PATH_STYLE=on
export RESTORE_ACCESS_KEY_ID=af69-target RESTORE_SECRET_ACCESS_KEY=af69-target-storage-only
export RESTORE_POSTGRES_PASSWORD=af69-restore-password-only
export RESTORE_STORAGE_ACCESS_KEY_ID=af69-recovered
export RESTORE_STORAGE_SECRET_ACCESS_KEY=af69-recovered-storage-only
export RESTORE_DATABASE_SCHEMA=public

MSYS2_ARG_CONV_EXCL='/CN=' openssl req -x509 -newkey rsa:2048 -nodes -days 1 \
  -keyout "$cert_dir/private.key" -out "$cert_dir/public.crt" \
  -subj /CN=backup-target -addext 'subjectAltName=DNS:backup-target' >/dev/null 2>&1
chmod 0644 "$cert_dir/public.crt"

compose() {
  MSYS2_ARG_CONV_EXCL='/bin/sh' docker compose --project-name "$project" \
    -f "$repository_root/infra/compose/restore.yml" \
    -f "$repository_root/tests/fixtures/backups/compose.yml" "$@"
}

compose run --build --rm backup-once
# A later overwrite and delete must not contaminate the published set.
compose run --rm --no-deps --entrypoint /bin/sh backup-once -ec '
  mc alias set target https://backup-target:9000 af69-target af69-target-storage-only --path on >/dev/null 2>&1
  printf "later unrelated version\n" >/tmp/later.txt
  mc cp --enc-s3 target/af69-target/staging/storage/current /tmp/later.txt target/af69-target/staging/storage/current/synthetic/af69-document.txt >/dev/null 2>&1
  mc rm target/af69-target/staging/storage/current/synthetic/af69-document.txt >/dev/null 2>&1
'
# Prove the producer catalog names the original synthetic bytes even after a
# later overwrite/delete. This check uses only fictional test data.
compose run --rm --no-deps --entrypoint /bin/sh backup-once -ec '
  mc alias set target https://backup-target:9000 af69-target af69-target-storage-only --path on >/dev/null 2>&1
  manifest="$(mc cat target/af69-target/staging/manifests/latest.json)"
  catalog_key="$(printf "%s" "$manifest" | jq -r .storage.catalog.objectKey)"
  catalog_version="$(printf "%s" "$manifest" | jq -r .storage.catalog.versionId)"
  mc cp --version-id "$catalog_version" "target/af69-target/$catalog_key" /tmp/catalog.jsonl >/dev/null 2>&1
  pinned_version="$(jq -r "select(.key == \"synthetic/af69-document.txt\") | .versionId" /tmp/catalog.jsonl)"
  [ -n "$pinned_version" ] && [ "$pinned_version" != null ]
  mc cp --version-id "$pinned_version" target/af69-target/staging/storage/current/synthetic/af69-document.txt /tmp/pinned.txt >/dev/null 2>&1
  if ! grep -q "fictional test data" /tmp/pinned.txt; then
    echo "Published synthetic object version did not recover original content" >&2
    mc --json ls --recursive --versions target/af69-target/staging/storage/current/ | jq -c "{type,key,versionOrdinal,versionId}" >&2
    sha256sum /tmp/pinned.txt >&2
    exit 1
  fi
'
compose run --build --rm restore

# The recovered DB and object must be the synthetic source values, not merely
# a successful pg_restore exit status or an empty mirrored bucket.
row_count="$(compose exec -T restore-postgres psql -U af69_restore -d af69_restore \
  -X -A -t -c "SELECT count(*) FROM file_intakes WHERE storage_key='synthetic/af69-document.txt' AND status='validated'")"
[ "$row_count" = 1 ]
compose run --rm --no-deps --entrypoint /bin/sh restore -ec \
  'mc alias set recovered http://restore-storage:9000 af69-recovered af69-recovered-storage-only >/dev/null 2>&1; mc cat recovered/af69-recovered/synthetic/af69-document.txt 2>/dev/null | grep -q "fictional test data"'

# A catalog that claims more pinned objects than it contains is incomplete,
# even if its database dump and currently visible storage objects exist.
compose run --rm --no-deps --entrypoint /bin/sh backup-once -ec '
  mc alias set target https://backup-target:9000 af69-target af69-target-storage-only --path on >/dev/null 2>&1
  mc cat target/af69-target/staging/manifests/latest.json >/tmp/original.json
  jq ".storage.catalog.count += 1" /tmp/original.json >/tmp/incomplete.json
  mc cp --enc-s3 target/af69-target/staging/manifests/latest.json /tmp/incomplete.json target/af69-target/staging/manifests/latest.json >/dev/null 2>&1
'
if compose run --rm --no-deps restore >"$cert_dir/incomplete.out" 2>&1; then
  echo 'Incomplete storage catalog unexpectedly restored' >&2
  exit 1
fi
grep -q '"stage":"catalog_integrity"' "$cert_dir/incomplete.out"
compose run --rm --no-deps --entrypoint /bin/sh backup-once -ec '
  mc alias set target https://backup-target:9000 af69-target af69-target-storage-only --path on >/dev/null 2>&1
  backup_id="$(mc cat target/af69-target/staging/manifests/latest.json | jq -r .backupId)"
  mc cp --enc-s3 target/af69-target/staging/manifests/latest.json \
    "target/af69-target/staging/manifests/history/$backup_id.json" \
    target/af69-target/staging/manifests/latest.json >/dev/null 2>&1
'

# A valid-looking but wrong published checksum must fail before DB or object
# restore. The original archive/version is immutable and remains untouched.
compose run --rm --no-deps --entrypoint /bin/sh backup-once -ec '
  mc alias set target https://backup-target:9000 af69-target af69-target-storage-only --path on >/dev/null 2>&1
  mc cat target/af69-target/staging/manifests/latest.json >/tmp/original.json
  jq ".database.sha256 = (\"0\" * 64)" /tmp/original.json >/tmp/corrupt.json
  mc cp --enc-s3 target/af69-target/staging/manifests/latest.json /tmp/corrupt.json target/af69-target/staging/manifests/latest.json >/dev/null 2>&1
'
if compose run --rm --no-deps restore >"$cert_dir/corrupt.out" 2>&1; then
  echo 'Corrupt manifest unexpectedly restored' >&2
  exit 1
fi
grep -q '"stage":"archive_integrity"' "$cert_dir/corrupt.out"

# Restore the immutable history manifest, then remove only the pinned catalog
# version. A live-looking catalog is not a substitute for the published one.
compose run --rm --no-deps --entrypoint /bin/sh backup-once -ec '
  mc alias set target https://backup-target:9000 af69-target af69-target-storage-only --path on >/dev/null 2>&1
  manifest="$(mc cat target/af69-target/staging/manifests/latest.json)"
  backup_id="$(printf "%s" "$manifest" | jq -r .backupId)"
  mc cp --enc-s3 target/af69-target/staging/manifests/latest.json \
    "target/af69-target/staging/manifests/history/$backup_id.json" \
    target/af69-target/staging/manifests/latest.json >/dev/null 2>&1
  manifest="$(mc cat target/af69-target/staging/manifests/latest.json)"
  key="$(printf "%s" "$manifest" | jq -r .storage.catalog.objectKey)"
  version="$(printf "%s" "$manifest" | jq -r .storage.catalog.versionId)"
  mc rm --version-id "$version" "target/af69-target/$key" >/dev/null 2>&1
'
if compose run --rm --no-deps restore >"$cert_dir/catalog.out" 2>&1; then
  echo 'Missing pinned catalog version unexpectedly restored' >&2
  exit 1
fi
grep -q '"stage":"catalog_fetch"' "$cert_dir/catalog.out"

# Remove only the pinned archive version in this disposable target. A
# live-looking slot is not a substitute for the published archive.
compose run --rm --no-deps --entrypoint /bin/sh backup-once -ec '
  mc alias set target https://backup-target:9000 af69-target af69-target-storage-only --path on >/dev/null 2>&1
  manifest="$(mc cat target/af69-target/staging/manifests/latest.json)"
  backup_id="$(printf "%s" "$manifest" | jq -r .backupId)"
  mc cp --enc-s3 target/af69-target/staging/manifests/latest.json \
    "target/af69-target/staging/manifests/history/$backup_id.json" \
    target/af69-target/staging/manifests/latest.json >/dev/null 2>&1
  manifest="$(mc cat target/af69-target/staging/manifests/latest.json)"
  key="$(printf "%s" "$manifest" | jq -r .database.objectKey)"
  version="$(printf "%s" "$manifest" | jq -r .database.versionId)"
  mc rm --version-id "$version" "target/af69-target/$key" >/dev/null 2>&1
'
if compose run --rm --no-deps restore >"$cert_dir/archive.out" 2>&1; then
  echo 'Missing pinned archive version unexpectedly restored' >&2
  exit 1
fi
grep -q '"stage":"archive_fetch"' "$cert_dir/archive.out"

compose run --rm --no-deps --entrypoint /bin/sh backup-once -ec '
  mc alias set target https://backup-target:9000 af69-target af69-target-storage-only --path on >/dev/null 2>&1
  mc rm target/af69-target/staging/manifests/latest.json >/dev/null 2>&1
'
if compose run --rm --no-deps restore >"$cert_dir/missing.out" 2>&1; then
  echo 'Missing published manifest unexpectedly restored' >&2
  exit 1
fi
grep -q '"stage":"manifest_fetch"' "$cert_dir/missing.out"

if compose run --rm --no-deps -e RESTORE_SOURCE_ENV=development \
  -e PGHOST=source-postgres restore >"$cert_dir/unsafe.out" 2>&1; then
  echo 'Unsafe source environment unexpectedly accepted' >&2
  exit 1
fi
grep -q 'invalid source environment' "$cert_dir/unsafe.out"

printf 'AF-69 synthetic backup/restore and negative controls passed\n'
