FROM postgres:17.10-alpine3.23 AS minio-client-amd64
ADD --checksum=sha256:01f866e9c5f9b87c2b09116fa5d7c06695b106242d829a8bb32990c00312e891 https://github.com/minio/mc/releases/download/RELEASE.2025-08-13T08-35-41Z/mc.linux-amd64.RELEASE.2025-08-13T08-35-41Z /usr/local/bin/mc

FROM postgres:17.10-alpine3.23 AS minio-client-arm64
ADD --checksum=sha256:14c8c9616cfce4636add161304353244e8de383b2e2752c0e9dad01d4c27c12c https://github.com/minio/mc/releases/download/RELEASE.2025-08-13T08-35-41Z/mc.linux-arm64.RELEASE.2025-08-13T08-35-41Z /usr/local/bin/mc

ARG TARGETARCH
FROM minio-client-${TARGETARCH}

# The tagged Quay image is no longer anonymously pullable. Use the matching
# official release artifact, pinned to its upstream SHA-256 on each platform.
RUN apk add --no-cache coreutils=9.8-r1 jq=1.8.2-r0
COPY --chmod=0555 scripts/backups/backup.sh /usr/local/bin/signal-audit-backup
COPY --chmod=0555 scripts/backups/restore.sh /usr/local/bin/signal-audit-restore

RUN chmod 0555 /usr/local/bin/mc \
    && mkdir -p /var/lib/signal-audit-backup /work \
    && chown 70:70 /var/lib/signal-audit-backup /work \
    && chmod 0700 /var/lib/signal-audit-backup /work

ENV HOME=/tmp \
    MC_CONFIG_DIR=/tmp/mc \
    MC_NO_COLOR=1 \
    MC_QUIET=1

USER 70:70
ENTRYPOINT ["/usr/local/bin/signal-audit-backup"]
CMD ["loop"]
