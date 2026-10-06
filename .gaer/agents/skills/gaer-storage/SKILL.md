---
name: gaer-storage
description: Upload and download to OVHcloud Object Storage via the server and short-lived links. Use when handling files, images or the logo.
---

# Object Storage (gaer-storage)

Code: `server/app/storage.py`, `server/app/routes/files.py`, table `files`.

- OVHcloud Object Storage is S3-compatible (`S3_ENDPOINT`, `S3_BUCKET`, keys). Locally MinIO from docker-compose;
  tests use `STORAGE_BACKEND=memory`.
- **Upload goes through the server**: `save_upload(conn, upload, owner_id=..., actor=..., prefix=...)` checks the
  size (`MAX_UPLOAD_MB`), stores the object under `<prefix>/<uuid>`, inserts a `files` row and audits `file.upload`.
- **Download via short-lived presigned links** (`DOWNLOAD_LINK_SECONDS`, default 300) from
  `GET /api/files/{id}/link`, after an ownership check. Never make the bucket public.
- **Delete** with `delete_file(...)` — removes the object and the row and audits `file.delete`.
- Object keys never contain user input (filenames live only in the `files` row).
- GDPR: files are in the export (metadata) and deleted on erasure. `/admin/files` shows usage per user.
- Public assets (the logo) are streamed by the server (`/api/public/logo`), not linked to the bucket.
