---
name: gaer-storage
description: Upload and download to OVHcloud Object Storage via the server and short-lived links. Use when handling files, images or the logo.
---

# Object Storage (gaer-storage)

Code: `server/app/storage.py`, `server/app/routes/files.py`, `server/app/filetree.py`, `server/app/routes/admin_files.py`, tables `files` and `file_folders`.

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

## The file tree (`server/app/filetree.py`, migration `0015_file_tree.sql`)
- Paths: `/users/<id>/…` is each user's **home** (`files.space = 'user'`, `user_id` = owner), `/shared/…` holds
  **common project files** (`space = 'shared'`, `user_id` null, `uploaded_by` = who put it there). `~/` = your own home.
  Folders are `files.folder` (`/` or `/a/b/`) plus rows in `file_folders` (so empty folders exist).
  Avatars, review files and system files (logo) are `files` rows outside the tree (`kind <> 'file'` or no owner).
- Always go through `filetree` (`parse`, `list_dir`, `write`, `upload`, `move`, `delete`, `make_folder`,
  `delete_folder`, `get_file`, `read_text`) — never raw SQL on the tree — so the rules are the same in
  `/api/files` (user), `/api/admin/files` (admin=True), the AI chat (`list_files`/`read_file`/`save_file`, run by the
  browser against `/api/files`) and the MCP tools (`files_browse`, `file_read`, `file_write`, … on both servers).
- Rules: a user reads/writes their own home and `/shared` (overwriting a shared file is allowed, the uploader stays);
  moving/deleting a shared file only by its uploader or an admin; a user can only delete an empty `/shared` folder.
  Admin: everything. Audit actions: `file.upload`, `file.write`, `file.move`, `file.delete`, `file.folder_create`,
  `file.folder_delete`.
- Preview: `GET …/{id}/raw` serves images and PDFs inline and text as `text/plain`, under a sandbox CSP — never
  serve an uploaded file with its own HTML/SVG type on our origin without it.
- GDPR: the export lists home files (with folder) and `shared_files` (paths only); erasure deletes the home and its
  folders; shared files stay, with `uploaded_by` set to null.
