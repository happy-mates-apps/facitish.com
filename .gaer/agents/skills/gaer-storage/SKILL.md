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
- **Direct upload to the bucket** (`server/app/uploads.py`, client `web/src/upload.ts`): the file tree's uploads in
  /filer, /m/filer and /admin/files go from the browser straight to Object Storage on presigned PUT links (multipart
  in 32 MB+ parts above 64 MB), so Cloudflare's 100 MB request limit does not apply (`MAX_DIRECT_UPLOAD_MB`, default
  5120). Start → PUT → complete; only on complete does the file get its `files` row (`filetree.register`, audited as
  `file.upload` with `via: "direct"`). Rows in `file_uploads`; unfinished ones are aborted by `files.uploads_cleanup`.
  The bucket needs CORS for `ORIGIN` (PUT, `ExposeHeaders: ETag`) — the job `storage.cors` sets it at start-up;
  `S3_PUBLIC_ENDPOINT` when the browser uses another address; `DIRECT_UPLOAD=0` turns it off. If the bucket cannot be
  reached the client falls back to the server upload (≤ `MAX_UPLOAD_MB`).
- **Zip files**: the app asks whether a zip is uploaded as it is or unpacked. Unpacked, the zip lands on a temporary
  key and the job `files.unzip` puts each file into the folder (or a new folder named after the zip), keeping its
  folders, in batches; bad names, `..`, encrypted entries and `__MACOSX`/`.DS_Store` are skipped and listed; limits
  `UNZIP_MAX_FILES` and `UNZIP_MAX_MB`; audited per file (`via: "unzip"`) and as `file.unzip`.
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
- The app: `/filer` and `/m/filer` use `web/src/pages/FileBrowser.tsx` (tabs "Mine filer" / "Fælles", folders, upload,
  preview, move, delete; `?mappe=` in the URL). /admin/files is its own page in `admin-app/`.
- GDPR: the export lists home files (with folder) and `shared_files` (paths only); erasure deletes the home and its
  folders; shared files stay, with `uploaded_by` set to null.
