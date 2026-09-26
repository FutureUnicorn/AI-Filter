#!/bin/sh

# AF-69: read a published backup set into the fixed, isolated restore services.
# This command deliberately has no configurable PostgreSQL host or destination
# bucket: it must never be usable as a general-purpose production restore tool.
set -eu
umask 077

work_dir=
stage=configuration
log_failure() {
  printf '{"level":"error","event":"restore.failed","stage":"%s"}\n' "$stage" >&2
}
cleanup() {
  if [ -n "$work_dir" ] && [ -d "$work_dir" ]; then
    rm -rf -- "$work_dir"
  fi
}
trap 'log_failure; cleanup' 0
trap 'exit 1' HUP INT TERM

required() {
  eval 'value=${'"$1"'-}'
  if [ -z "$value" ]; then
    printf 'Restore configuration error: %s is required\n' "$1" >&2
    exit 2
  fi
}

for name in RESTORE_SOURCE_ENV BACKUP_ENDPOINT BACKUP_REGION BACKUP_BUCKET \
  RESTORE_ACCESS_KEY_ID RESTORE_SECRET_ACCESS_KEY RESTORE_POSTGRES_PASSWORD \
  RESTORE_STORAGE_ACCESS_KEY_ID RESTORE_STORAGE_SECRET_ACCESS_KEY RESTORE_DATABASE_SCHEMA; do
  required "$name"
done
case "$RESTORE_SOURCE_ENV" in staging|production) ;; *) echo 'Restore configuration error: invalid source environment' >&2; exit 2 ;; esac
case "$BACKUP_ENDPOINT" in https://*) ;; *) echo 'Restore configuration error: HTTPS source required' >&2; exit 2 ;; esac
endpoint_authority="${BACKUP_ENDPOINT#https://}"
case "$endpoint_authority" in ''|*[@/?#]*) echo 'Restore configuration error: HTTPS origin required' >&2; exit 2 ;; esac
case "$BACKUP_BUCKET" in *[!a-z0-9.-]*|.*|*.|*..*) echo 'Restore configuration error: invalid bucket' >&2; exit 2 ;; esac
case "$RESTORE_DATABASE_SCHEMA" in *[!a-z0-9_]*|'') echo 'Restore configuration error: invalid schema' >&2; exit 2 ;; esac
case "${BACKUP_PATH_STYLE:-auto}" in auto|on|off) ;; *) echo 'Restore configuration error: invalid path style' >&2; exit 2 ;; esac

# The only writable destinations are names in the dedicated AF-69 Compose
# project. Ignore ambient PGHOST/PGDATABASE and never take destination URLs.
export PGHOST=restore-postgres PGDATABASE=af69_restore PGUSER=af69_restore
export PGPASSWORD="$RESTORE_POSTGRES_PASSWORD"
export MC_CONFIG_DIR=/tmp/restore-mc MC_NO_COLOR=1 MC_QUIET=1
work_dir="$(mktemp -d /work/af69-restore.XXXXXX)"
manifest_file="$work_dir/manifest.json"
dump_file="$work_dir/database.dump"
catalog_file="$work_dir/storage-catalog.jsonl"
validated_catalog_file="$work_dir/validated-storage-catalog.jsonl"

stage=source_authentication
mkdir -p "$MC_CONFIG_DIR"
mc --quiet alias set source "$BACKUP_ENDPOINT" "$RESTORE_ACCESS_KEY_ID" \
  "$RESTORE_SECRET_ACCESS_KEY" --api S3v4 --path "${BACKUP_PATH_STYLE:-auto}" >/dev/null 2>&1
stage=destination_authentication
mc --quiet alias set recovered http://restore-storage:9000 \
  "$RESTORE_STORAGE_ACCESS_KEY_ID" "$RESTORE_STORAGE_SECRET_ACCESS_KEY" \
  --api S3v4 --path on >/dev/null 2>&1

stage=manifest_fetch
mc --quiet cp "source/$BACKUP_BUCKET/$RESTORE_SOURCE_ENV/manifests/latest.json" \
  "$manifest_file" >/dev/null 2>&1
stage=manifest_validation
jq -e --arg env "$RESTORE_SOURCE_ENV" '
  .schemaVersion == 3 and .environment == $env and
  (.backupId | type == "string" and test("^[0-9]{8}T[0-9]{6}Z-[a-f0-9]{1,12}-[a-f0-9]{8}$")) and
  (.completedAt | type == "string" and test("^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}Z$")) and
  (.database.objectKey | . == ($env + "/database/latest-a.dump") or . == ($env + "/database/latest-b.dump")) and
  (.database.versionId | type == "string" and test("^[A-Za-z0-9._~+/=-]{1,200}$")) and
  (.database.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
  (.database.bytes | type == "number" and . > 0 and . == floor) and
  .database.format == "postgres-custom" and
  .storage.prefix == ($env + "/storage/current") and .storage.versioned == true and
  .storage.catalog.objectKey == ($env + "/storage/catalogs/" + .backupId + ".jsonl") and
  (.storage.catalog.versionId | type == "string" and test("^[A-Za-z0-9._~+/=-]{1,200}$")) and
  (.storage.catalog.sha256 | type == "string" and test("^[a-f0-9]{64}$")) and
  (.storage.catalog.bytes | type == "number" and . >= 0 and . == floor) and
  (.storage.catalog.count | type == "number" and . >= 0 and . == floor)
' "$manifest_file" >/dev/null 2>&1
object_key="$(jq -er '.database.objectKey' "$manifest_file")"
version_id="$(jq -er '.database.versionId' "$manifest_file")"
expected_sha="$(jq -er '.database.sha256' "$manifest_file")"
expected_bytes="$(jq -er '.database.bytes' "$manifest_file")"
backup_id="$(jq -er '.backupId' "$manifest_file")"
catalog_key="$(jq -er '.storage.catalog.objectKey' "$manifest_file")"
catalog_version_id="$(jq -er '.storage.catalog.versionId' "$manifest_file")"
catalog_sha256="$(jq -er '.storage.catalog.sha256' "$manifest_file")"
catalog_bytes="$(jq -er '.storage.catalog.bytes' "$manifest_file")"
catalog_count="$(jq -er '.storage.catalog.count' "$manifest_file")"

stage=archive_fetch
mc --quiet cp --version-id "$version_id" "source/$BACKUP_BUCKET/$object_key" \
  "$dump_file" >/dev/null 2>&1
stage=archive_integrity
[ "$(stat -c '%s' "$dump_file")" = "$expected_bytes" ]
[ "$(sha256sum "$dump_file" | cut -d ' ' -f 1)" = "$expected_sha" ]
pg_restore --list "$dump_file" >/dev/null 2>&1

stage=catalog_fetch
mc --quiet cp --version-id "$catalog_version_id" "source/$BACKUP_BUCKET/$catalog_key" \
  "$catalog_file" >/dev/null 2>&1
stage=catalog_integrity
[ "$(stat -c '%s' "$catalog_file")" = "$catalog_bytes" ]
[ "$(sha256sum "$catalog_file" | cut -d ' ' -f 1)" = "$catalog_sha256" ]
jq -c '
  if type == "object" and
     (.key | type == "string" and length > 0 and length <= 1024 and
       (startswith("/") | not) and (test("(^|/)\\.\\.(/|$)|[[:cntrl:]]") | not)) and
     (.versionId | type == "string" and test("^[A-Za-z0-9._~+/=-]{1,200}$"))
  then {key, versionId} else error("invalid storage catalog") end
' "$catalog_file" >"$validated_catalog_file" 2>/dev/null
[ "$(wc -l <"$validated_catalog_file" | tr -d ' ')" = "$catalog_count" ]

stage=destination_preflight
pg_isready -q
[ "$(psql -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM information_schema.tables WHERE table_schema NOT IN ('pg_catalog','information_schema')")" = 0 ]
mc --quiet mb --ignore-existing recovered/af69-recovered >/dev/null 2>&1
if ! destination_objects="$(mc --json ls --recursive recovered/af69-recovered/ 2>/dev/null)"; then
  exit 1
fi
if [ -n "$destination_objects" ]; then
  exit 1
fi

stage=database_restore
pg_restore --exit-on-error --single-transaction --no-owner --no-acl \
  --dbname=af69_restore "$dump_file" >/dev/null 2>&1
stage=database_validation
[ "$(psql -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT count(*) FROM pg_tables WHERE schemaname='$RESTORE_DATABASE_SCHEMA' AND tablename IN ('af11_synthetic_environment_fixture','file_intakes')")" = 2 ]

stage=storage_restore
# Every copied object comes from the exact version published in the catalog.
# A current-view listing or time rewind can select a later overwrite.
while IFS= read -r entry; do
  encoded_key="$(printf '%s' "$entry" | jq -er '.key | @base64')"
  object_name="$(printf '%s' "$encoded_key" | base64 -d)"
  object_version_id="$(printf '%s' "$entry" | jq -er '.versionId')"
  stage=storage_object_fetch
  mc --quiet cp --version-id "$object_version_id" \
    "source/$BACKUP_BUCKET/$RESTORE_SOURCE_ENV/storage/current/$object_name" \
    "recovered/af69-recovered/$object_name" >/dev/null 2>&1
done <"$validated_catalog_file"

stage=application_records
# The SQL result contains only base64-encoded keys and code-like state/hash.
# Neither keys nor tool diagnostics are logged. Uploaded rows require presence;
# validated rows must also match the content digest used by application reads.
psql -X -A -t -v ON_ERROR_STOP=1 -c \
  "SELECT replace(encode(convert_to(storage_key,'UTF8'),'base64'), E'\\n', '') || ' ' || status || ' ' || coalesce(sha256_hash, '-') FROM \"$RESTORE_DATABASE_SCHEMA\".file_intakes WHERE status IN ('uploaded','validated')" \
  >"$work_dir/storage-records" 2>/dev/null
verified_objects=0
while IFS=' ' read -r encoded_key intake_status expected_object_sha; do
  [ -n "$encoded_key" ] || continue
  stage=application_key_decode
  object_name="$(printf '%s' "$encoded_key" | base64 -d)"
  stage=application_object_presence
  mc --quiet stat "recovered/af69-recovered/$object_name" >/dev/null 2>&1
  if [ "$intake_status" = validated ]; then
    stage=application_object_digest
    printf '%s' "$expected_object_sha" | grep -Eq '^[a-f0-9]{64}$'
    mc --quiet cp "recovered/af69-recovered/$object_name" "$work_dir/validated-object" >/dev/null 2>&1
    [ "$(sha256sum "$work_dir/validated-object" | cut -d ' ' -f 1)" = "$expected_object_sha" ]
    rm -f "$work_dir/validated-object"
  fi
  verified_objects=$((verified_objects + 1))
done <"$work_dir/storage-records"

stage=complete
printf '{"level":"info","event":"restore.verified","backupId":"%s","sourceEnvironment":"%s","referencedObjects":%s}\n' \
  "$backup_id" "$RESTORE_SOURCE_ENV" "$verified_objects"
trap - 0
cleanup
