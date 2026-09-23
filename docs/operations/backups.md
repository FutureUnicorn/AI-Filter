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

When enabled, the `backup` service runs once immediately and then waits
`BACKUP_INTERVAL_SECONDS` before the next run. One run performs:

1. mirror primary object storage to the encrypted, versioned target prefix;
2. create a consistent PostgreSQL custom-format archive;
3. verify the archive can be parsed with `pg_restore --list`;
4. mirror object storage a second time to cover immutable uploads committed
   while the database snapshot was running;
5. upload the dump, its SHA-256 and a metadata-only success manifest; and
6. replace `manifests/latest.json` only after every required step succeeds.

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

- database dumps expire after `BACKUP_RETENTION_DAYS`;
- historical manifests expire after the same window;
- overwritten or deleted object-storage versions expire after that window;
- current mirrored objects do not expire while they still exist in primary
  storage; and
- expired delete markers are cleaned up.

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
  off-host target per environment;
- `BACKUP_CONTROL_OWNER`: accountable person or team; and
- `BACKUP_ENCRYPTION_REFERENCE`: provider encryption/KMS evidence.

Store `BACKUP_ACCESS_KEY_ID` and `BACKUP_SECRET_ACCESS_KEY` as environment
secrets. The identity is available only to `backup-init` and `backup`, never
to the web or worker containers. It needs access only to the dedicated bucket,
including bucket creation/private policy, versioning, lifecycle, encrypted
object read/write/list/delete, and version inspection.

`BACKUP_PATH_STYLE` is `auto`, `on`, or `off` according to the selected
provider. No schedule, retention, provider, owner, or notification address is
hardcoded in the repository.

## Deployment behavior

The normal hosted deploy validates backup controls before invoking Docker.
When disabled, deployment behavior is unchanged. When enabled:

1. PostgreSQL, primary storage, and migrations start;
2. the one-shot `backup-init` service applies and verifies target controls;
3. deployment stops if target configuration fails; and
4. web, worker, and the long-running backup service start together.

The backup container is non-root, read-only, capability-free, has no published
port, and uses a small in-memory filesystem only for client state, manifests,
and health state. PostgreSQL archives are staged on the dedicated disk-backed
`backup-work` volume so archive growth does not compete directly with the
container memory limit. It joins the private network for PostgreSQL/MinIO and
the public network only for encrypted egress to the off-host target.

Before enablement, operations must confirm that the Compose host has enough
free disk for the largest expected compressed database archive plus normal
host headroom. The work volume is temporary staging, not a backup destination:
successful and failed runs remove their archive, graceful shutdown removes an
in-progress archive, and the next run removes any archive left by an abrupt
container termination. The off-host encrypted bucket remains the only backup
copy claimed by AF-68.

## Detection and diagnosis

Successful runs write `/tmp/last-success-epoch`. The container health check is
healthy only when a success occurred within twice the configured interval.
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

`<environment>/manifests/latest.json` identifies the database archive,
checksum, release, backup interval, storage prefix, and retention window. AF-69
must perform a restore into isolated infrastructure, validate the checksum,
restore with the matching PostgreSQL major version, reconstruct storage at the
manifest completion time from version history, and prove application-level
records and objects agree.

Do not restore over a live environment. Do not mark AF-69 complete from
`pg_restore --list`; that check proves archive readability, not end-to-end
recovery.
