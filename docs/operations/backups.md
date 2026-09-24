# AF-68 database and object-storage backups

## Outcome and boundary

AF-68 adds an automated, off-host backup path for the hosted PostgreSQL
database and the S3-compatible object store. It does not claim that an archive
has been restored. AF-69 owns the independent restore drill and its evidence.

The primary PostgreSQL and MinIO volumes live on the same Compose host. A copy
on another local volume would share that host's failure domain and is not a
backup. The AF-68 target must therefore be a dedicated bucket on a different
S3-compatible deployment, account, or provider.

## Backup set

When enabled for the first time, the `backup` service runs immediately and
then waits `BACKUP_INTERVAL_SECONDS` before the next run. After a deployment
or restart it first waits any interval still owed since the persisted last
success. One run performs:

1. mirror primary object storage to the encrypted, versioned target prefix;
2. create a consistent PostgreSQL custom-format archive;
3. verify the archive can be parsed with `pg_restore --list`;
4. mirror object storage a second time to cover immutable uploads committed
   while the database snapshot was running;
5. upload the dump to immutable history, then copy it within the destination
   store to the inactive versioned recovery slot (`database/latest-a.dump`
   or `database/latest-b.dump`);
6. record the exact recovery-slot key and version ID, SHA-256, and immutable history key
   in a metadata-only success manifest; and
7. replace `manifests/latest.json` only after every required step succeeds.

The two storage passes make the database snapshot no earlier than the first
copy and no later than the second. This avoids publishing a successful backup
whose database references an immutable upload that was never copied. The set
is still an application-consistent backup interval, not a distributed
point-in-time snapshot.

Object names, filenames, document text, candidate data, database values,
provider errors, and credentials are never written to backup logs or the
success manifest. Tool output is suppressed; failures emit only a closed stage
code such as `database_dump` or `storage_mirror`.

## Retention model

`backup-init` makes the dedicated target bucket private, enables versioning,
and replaces its lifecycle configuration with the AF-68 rules. The bucket must
not be shared with unrelated data because lifecycle import is intentionally
authoritative.

- immutable database history expires after `BACKUP_RETENTION_DAYS`;
- the two recovery-slot keys never expire while current; older exact versions
  age out after the same window while the newest noncurrent version is retained;
- historical manifests expire after the same window;
- overwritten or deleted object-storage versions expire after that window;
- current mirrored objects do not expire while they still exist in primary
  storage; and
- expired delete markers are cleaned up.

The published manifest names one recovery slot. Every run writes only to the
other slot, so repeated failures after the database copy cannot age out the
archive named by the last successful manifest. Each slot may hold one current
full archive; include both in off-host capacity planning. The database history
copy still follows the approved retention window. A bucket from an earlier
AF-68 build may also contain `database/latest.dump`; the first successful
run with this build moves the manifest to a slot, after which operations can
remove the legacy object once recovery is verified.

The backup client requests SSE-S3 on every mirrored or uploaded object.
`BACKUP_ENDPOINT` must be HTTPS. `BACKUP_ENCRYPTION_REFERENCE` records the
provider-side KMS/default-encryption control that operations approved; it is
evidence, not a key and must not contain a secret.

## Required decisions and configuration

Backups default to disabled. Before setting `BACKUP_ENABLED=true`, the team
must approve:

- `BACKUP_INTERVAL_SECONDS`: recovery-point schedule;
- `BACKUP_RETENTION_DAYS`: recovery window;
- `BACKUP_ENDPOINT`, `BACKUP_REGION`, and `BACKUP_BUCKET`: a dedicated,
  off-host target per environment, verified to support versioning, lifecycle
  rules, exact-key listing, and encrypted server-side object copy;
- `BACKUP_CONTROL_OWNER`: accountable person or team; and
- `BACKUP_ENCRYPTION_REFERENCE`: provider encryption/KMS evidence.

Store both credential pairs as environment secrets. Neither is available to
the web or worker containers.

- `BACKUP_ADMIN_ACCESS_KEY_ID` / `BACKUP_ADMIN_SECRET_ACCESS_KEY` are
  supplied only to the one-shot `backup-init` container. Scope them to the
  dedicated environment bucket and allow bucket creation/private policy,
  versioning, lifecycle configuration, and control verification.
- `BACKUP_WRITER_ACCESS_KEY_ID` / `BACKUP_WRITER_SECRET_ACCESS_KEY` are
  supplied to the long-running `backup` container. Allow only encrypted
  object put/get/head, bucket listing, and ordinary object deletion needed to
  create mirror delete markers. Explicitly deny version deletion, lifecycle
  changes, versioning changes, and bucket-policy changes.

Use provider Object Lock in governance mode for database/manifests when the
approved provider supports it. That is defense in depth; the admin/writer
split is required regardless.

`BACKUP_PATH_STYLE` is `auto`, `on`, or `off` according to the selected
provider. No schedule, retention, provider, owner, or notification address is
hardcoded in the repository.

## Deployment behavior

The normal hosted deploy validates backup controls before invoking Docker.
When disabled, it first stops and removes any previously running `backup`
container so changing `BACKUP_ENABLED=false` actually stops off-host data
movement. When enabled:

1. PostgreSQL, primary storage, and migrations start;
2. the one-shot `backup-init` service applies and verifies target controls;
3. deployment stops if target configuration fails; and
4. web, worker, and the long-running backup service start together.

The backup container is non-root, read-only, capability-free, has no published
port, and uses a small in-memory filesystem only for client state, manifests,
and health state. PostgreSQL archives are staged on the dedicated disk-backed
`backup-work` volume so archive growth does not compete directly with the
container memory limit. The volume also keeps the last-success timestamp
across image recreation; a deploy waits out the remainder of the approved
interval instead of starting an extra full backup. It joins the private
network for PostgreSQL/MinIO and the public network only for encrypted egress
to the off-host target.

Before enablement, operations must confirm that the Compose host has enough
free disk for the largest expected compressed database archive plus normal
host headroom. The work volume is temporary staging, not a backup destination:
successful and failed runs remove their archive, graceful shutdown removes an
in-progress archive, and the next run removes any archive left by an abrupt
container termination. The off-host encrypted bucket remains the only backup
copy claimed by AF-68.

## Detection and diagnosis

Successful runs write
`/var/lib/signal-audit-backup/last-success-epoch`. The container health check
is healthy only when a success occurred within twice the configured interval.
Structured events are:

- `backup.configuration_succeeded`;
- `backup.configuration_failed`;
- `backup.run_started`;
- `backup.run_succeeded`; and
- `backup.run_failed`.

If the service is unhealthy, inspect its structured events and the safe stage
code. Do not enable raw `pg_dump` or `mc` output in retained logs: object keys
can contain candidate filenames.

## Recovery and AF-69 handoff

`<environment>/manifests/latest.json` identifies the active versioned
database recovery slot, its exact version ID, the immutable history key, checksum,
release, storage prefix, and retention window. AF-69 must fetch the recorded
object version into isolated infrastructure, validate the checksum, restore
with the matching PostgreSQL major version, reconstruct storage at the
manifest completion time from version history, and prove application-level
records and objects agree.

Do not restore over a live environment. Do not mark AF-69 complete from
`pg_restore --list`; that check proves archive readability, not end-to-end
recovery.
