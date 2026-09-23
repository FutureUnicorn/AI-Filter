#!/bin/sh

set -eu

BACKUP_WORK_DIR=/var/lib/signal-audit-backup
dump_file=
manifest_file=
dump_stderr_file=
active_pid=

is_lower_hex_length() {
  value="$1"
  expected_length="$2"
  [ "${#value}" -eq "$expected_length" ] || return 1
  case "$value" in
    *[!0-9a-f]*) return 1 ;;
  esac
}

cleanup_run_files() {
  cleanup_status=0
  for cleanup_path in "${dump_file-}" "${manifest_file-}" "${dump_stderr_file-}"; do
    if [ -n "$cleanup_path" ] && ! rm -f "$cleanup_path"; then
      cleanup_status=1
    fi
  done
  if [ "$cleanup_status" -eq 0 ]; then
    dump_file=
    manifest_file=
    dump_stderr_file=
  fi
  return "$cleanup_status"
}

cleanup_orphaned_dumps() {
  if ! rm -f "$BACKUP_WORK_DIR"/*.dump; then
    log_event error run_failed stale_dump_cleanup
    return 1
  fi
}

run_interruptible() {
  "$@" &
  active_pid=$!
  if wait "$active_pid"; then
    command_status=0
  else
    command_status=$?
  fi
  active_pid=
  return "$command_status"
}

handle_shutdown() {
  trap - INT TERM
  if [ -n "${active_pid-}" ]; then
    kill -TERM "$active_pid" >/dev/null 2>&1 || true
    wait "$active_pid" >/dev/null 2>&1 || true
    active_pid=
  fi
  exit 0
}

install_cleanup_traps() {
  trap 'cleanup_run_files' 0
  trap 'handle_shutdown' INT TERM
}

require_value() {
  variable_name="$1"
  variable_value="$2"
  if [ -z "$variable_value" ]; then
    echo "Backup configuration error: $variable_name is required" >&2
    return 2
  fi
}

validate_positive_integer() {
  variable_name="$1"
  variable_value="$2"
  case "$variable_value" in
    ""|*[!0-9]*|0)
      echo "Backup configuration error: $variable_name must be a positive integer" >&2
      return 2
      ;;
  esac
}

validate_configuration() {
  require_value APP_ENV "${APP_ENV-}"
  require_value DEPLOYMENT_COMMIT_SHA "${DEPLOYMENT_COMMIT_SHA-}"
  require_value PGHOST "${PGHOST-}"
  require_value PGDATABASE "${PGDATABASE-}"
  require_value PGUSER "${PGUSER-}"
  require_value PGPASSWORD "${PGPASSWORD-}"
  require_value STORAGE_BUCKET "${STORAGE_BUCKET-}"
  require_value STORAGE_ACCESS_KEY_ID "${STORAGE_ACCESS_KEY_ID-}"
  require_value STORAGE_SECRET_ACCESS_KEY "${STORAGE_SECRET_ACCESS_KEY-}"
  require_value BACKUP_ENDPOINT "${BACKUP_ENDPOINT-}"
  require_value BACKUP_REGION "${BACKUP_REGION-}"
  require_value BACKUP_BUCKET "${BACKUP_BUCKET-}"
  require_value BACKUP_ACCESS_KEY_ID "${BACKUP_ACCESS_KEY_ID-}"
  require_value BACKUP_SECRET_ACCESS_KEY "${BACKUP_SECRET_ACCESS_KEY-}"
  require_value BACKUP_INTERVAL_SECONDS "${BACKUP_INTERVAL_SECONDS-}"
  require_value BACKUP_RETENTION_DAYS "${BACKUP_RETENTION_DAYS-}"
  require_value BACKUP_PATH_STYLE "${BACKUP_PATH_STYLE-}"
  require_value BACKUP_CONTROL_OWNER "${BACKUP_CONTROL_OWNER-}"
  require_value BACKUP_ENCRYPTION_REFERENCE "${BACKUP_ENCRYPTION_REFERENCE-}"

  case "$APP_ENV" in
    staging|production) ;;
    *)
      echo "Backup configuration error: APP_ENV must be staging or production" >&2
      return 2
      ;;
  esac
  case "$DEPLOYMENT_COMMIT_SHA" in
    *[!a-f0-9]*|"")
      echo "Backup configuration error: DEPLOYMENT_COMMIT_SHA is invalid" >&2
      return 2
      ;;
  esac
  case "$BACKUP_ENDPOINT" in
    https://*) ;;
    *)
      echo "Backup configuration error: BACKUP_ENDPOINT must use https" >&2
      return 2
      ;;
  esac
  case "$BACKUP_BUCKET" in
    *[!a-z0-9.-]*|.*|*.)
      echo "Backup configuration error: BACKUP_BUCKET is not a safe S3 bucket name" >&2
      return 2
      ;;
  esac
  case "$BACKUP_PATH_STYLE" in
    auto|on|off) ;;
    *)
      echo "Backup configuration error: BACKUP_PATH_STYLE must be auto, on, or off" >&2
      return 2
      ;;
  esac
  if [ "${#BACKUP_SECRET_ACCESS_KEY}" -lt 20 ]; then
    echo "Backup configuration error: BACKUP_SECRET_ACCESS_KEY must be at least 20 characters" >&2
    return 2
  fi
  validate_positive_integer BACKUP_INTERVAL_SECONDS "$BACKUP_INTERVAL_SECONDS"
  validate_positive_integer BACKUP_RETENTION_DAYS "$BACKUP_RETENTION_DAYS"
}

log_event() {
  level="$1"
  event="$2"
  stage="$3"
  backup_id="${4-}"
  if [ -n "$backup_id" ]; then
    log_line="$(printf '{"level":"%s","event":"backup.%s","service":"backup","environment":"%s","release":"%s","stage":"%s","backupId":"%s"}' \
      "$level" "$event" "$APP_ENV" "$DEPLOYMENT_COMMIT_SHA" "$stage" "$backup_id")"
  else
    log_line="$(printf '{"level":"%s","event":"backup.%s","service":"backup","environment":"%s","release":"%s","stage":"%s"}' \
      "$level" "$event" "$APP_ENV" "$DEPLOYMENT_COMMIT_SHA" "$stage")"
  fi
  case "$level" in
    error|warn) printf '%s\n' "$log_line" >&2 ;;
    *) printf '%s\n' "$log_line" ;;
  esac
}

configure_aliases() {
  mkdir -p "$MC_CONFIG_DIR"
  if ! mc --quiet alias set source http://storage:9000 \
    "$STORAGE_ACCESS_KEY_ID" "$STORAGE_SECRET_ACCESS_KEY" --api S3v4 --path on >/dev/null 2>&1
  then
    log_event error run_failed source_authentication
    return 1
  fi
  if ! mc --quiet alias set target "$BACKUP_ENDPOINT" \
    "$BACKUP_ACCESS_KEY_ID" "$BACKUP_SECRET_ACCESS_KEY" --api S3v4 --path "$BACKUP_PATH_STYLE" >/dev/null 2>&1
  then
    log_event error run_failed target_authentication
    return 1
  fi
}

write_lifecycle_configuration() {
  lifecycle_file="$1"
  cat >"$lifecycle_file" <<EOF
{
  "Rules": [
    {
      "ID": "af68-database-retention",
      "Status": "Enabled",
      "Filter": { "Prefix": "$APP_ENV/database/" },
      "Expiration": { "Days": $BACKUP_RETENTION_DAYS },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }
    },
    {
      "ID": "af68-manifest-history-retention",
      "Status": "Enabled",
      "Filter": { "Prefix": "$APP_ENV/manifests/history/" },
      "Expiration": { "Days": $BACKUP_RETENTION_DAYS },
      "NoncurrentVersionExpiration": { "NoncurrentDays": 1 }
    },
    {
      "ID": "af68-latest-manifest-history-retention",
      "Status": "Enabled",
      "Filter": { "Prefix": "$APP_ENV/manifests/latest.json" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": $BACKUP_RETENTION_DAYS }
    },
    {
      "ID": "af68-storage-history-retention",
      "Status": "Enabled",
      "Filter": { "Prefix": "$APP_ENV/storage/current/" },
      "NoncurrentVersionExpiration": { "NoncurrentDays": $BACKUP_RETENTION_DAYS }
    },
    {
      "ID": "af68-delete-marker-cleanup",
      "Status": "Enabled",
      "Filter": { "Prefix": "$APP_ENV/" },
      "Expiration": { "ExpiredObjectDeleteMarker": true }
    }
  ]
}
EOF
}

configure_target() {
  validate_configuration || return $?
  configure_aliases || return $?
  lifecycle_file=/tmp/backup-lifecycle.json
  write_lifecycle_configuration "$lifecycle_file"

  if ! mc --quiet mb --ignore-existing --region "$BACKUP_REGION" "target/$BACKUP_BUCKET" >/dev/null 2>&1; then
    log_event error configuration_failed create_bucket
    return 1
  fi
  if ! mc --quiet anonymous set none "target/$BACKUP_BUCKET" >/dev/null 2>&1; then
    log_event error configuration_failed private_bucket
    return 1
  fi
  if ! mc --quiet version enable "target/$BACKUP_BUCKET" >/dev/null 2>&1; then
    log_event error configuration_failed versioning
    return 1
  fi
  if ! mc --quiet ilm rule import "target/$BACKUP_BUCKET" <"$lifecycle_file" >/dev/null 2>&1; then
    log_event error configuration_failed retention
    return 1
  fi
  if ! mc --json version info "target/$BACKUP_BUCKET" 2>/dev/null | grep -q '"status":"Enabled"'; then
    log_event error configuration_failed versioning_verification
    return 1
  fi
  if ! mc --quiet ilm rule export "target/$BACKUP_BUCKET" >/dev/null 2>&1; then
    log_event error configuration_failed retention_verification
    return 1
  fi

  rm -f "$lifecycle_file"
  log_event info configuration_succeeded target_ready
}

mirror_storage() {
  backup_id="$1"
  if ! run_interruptible mc --quiet mirror \
    --overwrite \
    --remove \
    --enc-s3 "target/$BACKUP_BUCKET/$APP_ENV/storage/current" \
    "source/$STORAGE_BUCKET/" \
    "target/$BACKUP_BUCKET/$APP_ENV/storage/current/" >/dev/null 2>&1
  then
    log_event error run_failed storage_mirror "$backup_id"
    return 1
  fi
}

run_once() {
  validate_configuration || return $?
  cleanup_orphaned_dumps || return $?
  configure_aliases || return $?

  if ! timestamp="$(date -u +%Y%m%dT%H%M%SZ)"; then
    log_event error run_failed backup_timestamp
    return 1
  fi
  if ! nonce_words="$(od -An -N4 -tx1 /dev/urandom)"; then
    log_event error run_failed backup_id_nonce
    return 1
  fi
  set -- $nonce_words
  if [ "$#" -ne 4 ]; then
    log_event error run_failed backup_id_nonce
    return 1
  fi
  nonce="$1$2$3$4"
  if ! is_lower_hex_length "$nonce" 8; then
    log_event error run_failed backup_id_nonce
    return 1
  fi
  if ! release_prefix="$(printf '%s' "$DEPLOYMENT_COMMIT_SHA" | cut -c1-12)" || [ -z "$release_prefix" ]; then
    log_event error run_failed backup_id_release
    return 1
  fi
  backup_id="$timestamp-$release_prefix-$nonce"
  if ! started_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
    log_event error run_failed backup_timestamp
    return 1
  fi
  dump_file="$BACKUP_WORK_DIR/$backup_id.dump"
  manifest_file="/tmp/$backup_id.json"
  dump_stderr_file="/tmp/$backup_id-pg-dump.stderr"
  umask 077

  log_event info run_started begin "$backup_id"

  # The first pass captures every object that existed before the database
  # snapshot. The second pass captures immutable uploads committed while
  # pg_dump was running, so database references are not ahead of storage.
  mirror_storage "$backup_id" || return $?

  if ! run_interruptible pg_dump \
    --format=custom \
    --compress=gzip:6 \
    --no-owner \
    --no-acl \
    --file="$dump_file" >/dev/null 2>"$dump_stderr_file"
  then
    log_event error run_failed database_dump "$backup_id"
    cleanup_run_files
    return 1
  fi
  if [ -s "$dump_stderr_file" ]; then
    log_event error run_failed database_dump_warning "$backup_id"
    cleanup_run_files
    return 1
  fi
  if ! rm -f "$dump_stderr_file"; then
    log_event error run_failed local_cleanup "$backup_id"
    cleanup_run_files
    return 1
  fi
  if ! run_interruptible pg_restore --list "$dump_file" >/dev/null 2>&1; then
    log_event error run_failed database_archive_validation "$backup_id"
    cleanup_run_files
    return 1
  fi

  mirror_storage "$backup_id" || {
    cleanup_run_files
    return 1
  }

  if ! checksum_output="$(sha256sum "$dump_file")"; then
    log_event error run_failed database_checksum "$backup_id"
    cleanup_run_files
    return 1
  fi
  database_sha256="${checksum_output%% *}"
  if ! is_lower_hex_length "$database_sha256" 64; then
    log_event error run_failed database_checksum "$backup_id"
    cleanup_run_files
    return 1
  fi
  if ! database_bytes="$(stat -c '%s' "$dump_file")"; then
    log_event error run_failed database_size "$backup_id"
    cleanup_run_files
    return 1
  fi
  if ! completed_at="$(date -u +%Y-%m-%dT%H:%M:%SZ)"; then
    log_event error run_failed backup_timestamp "$backup_id"
    cleanup_run_files
    return 1
  fi
  database_key="$APP_ENV/database/$backup_id.dump"

  if ! cat >"$manifest_file" <<EOF
{"schemaVersion":1,"backupId":"$backup_id","environment":"$APP_ENV","release":"$DEPLOYMENT_COMMIT_SHA","startedAt":"$started_at","completedAt":"$completed_at","retentionDays":$BACKUP_RETENTION_DAYS,"database":{"objectKey":"$database_key","sha256":"$database_sha256","bytes":$database_bytes,"format":"postgres-custom"},"storage":{"prefix":"$APP_ENV/storage/current","versioned":true}}
EOF
  then
    log_event error run_failed manifest_write "$backup_id"
    cleanup_run_files
    return 1
  fi

  if ! run_interruptible mc --quiet cp \
    --enc-s3 "target/$BACKUP_BUCKET/$APP_ENV/database" \
    "$dump_file" "target/$BACKUP_BUCKET/$database_key" >/dev/null 2>&1
  then
    log_event error run_failed database_upload "$backup_id"
    cleanup_run_files
    return 1
  fi
  if ! run_interruptible mc --quiet cp \
    --enc-s3 "target/$BACKUP_BUCKET/$APP_ENV/manifests/history" \
    "$manifest_file" "target/$BACKUP_BUCKET/$APP_ENV/manifests/history/$backup_id.json" >/dev/null 2>&1
  then
    log_event error run_failed manifest_history_upload "$backup_id"
    cleanup_run_files
    return 1
  fi
  if ! run_interruptible mc --quiet cp \
    --enc-s3 "target/$BACKUP_BUCKET/$APP_ENV/manifests/latest.json" \
    "$manifest_file" "target/$BACKUP_BUCKET/$APP_ENV/manifests/latest.json" >/dev/null 2>&1
  then
    log_event error run_failed latest_manifest_upload "$backup_id"
    cleanup_run_files
    return 1
  fi

  if ! cleanup_run_files; then
    log_event error run_failed local_cleanup "$backup_id"
    return 1
  fi
  if ! date -u +%s > /tmp/last-success-epoch; then
    log_event error run_failed success_state_write "$backup_id"
    return 1
  fi
  log_event info run_succeeded complete "$backup_id"
}

run_loop() {
  validate_configuration || return $?
  while :; do
    run_once || true
    run_interruptible sleep "$BACKUP_INTERVAL_SECONDS"
  done
}

health_check() {
  validate_configuration >/dev/null 2>&1 || return 1
  [ -s /tmp/last-success-epoch ] || return 1
  last_success_epoch="$(cat /tmp/last-success-epoch)"
  case "$last_success_epoch" in
    ""|*[!0-9]*) return 1 ;;
  esac
  now_epoch="$(date -u +%s)"
  maximum_age="$((BACKUP_INTERVAL_SECONDS * 2))"
  actual_age="$((now_epoch - last_success_epoch))"
  [ "$actual_age" -ge 0 ] && [ "$actual_age" -le "$maximum_age" ]
}

case "${1-}" in
  configure) configure_target ;;
  once) install_cleanup_traps; run_once ;;
  loop) install_cleanup_traps; run_loop ;;
  health) health_check ;;
  *)
    echo "Expected configure, once, loop, or health" >&2
    exit 2
    ;;
esac
