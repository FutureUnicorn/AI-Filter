FROM quay.io/minio/mc:RELEASE.2025-08-13T08-35-41Z AS minio-client

FROM postgres:17.10-alpine3.23

COPY --from=minio-client /usr/bin/mc /usr/local/bin/mc
COPY --chmod=0555 scripts/backups/backup.sh /usr/local/bin/signal-audit-backup

ENV HOME=/tmp \
    MC_CONFIG_DIR=/tmp/mc \
    MC_NO_COLOR=1 \
    MC_QUIET=1

USER 70:70
ENTRYPOINT ["/usr/local/bin/signal-audit-backup"]
CMD ["loop"]
