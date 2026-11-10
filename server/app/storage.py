"""Object Storage. OVHcloud Object Storage is S3-compatible; MinIO stands in locally."""

import asyncio
import hashlib
import uuid
from functools import lru_cache
from urllib.parse import quote, urlsplit

from app import config


class MemoryStorage:
    """For tests. Download and upload links point at the server itself (/api/_memory-storage/…)."""

    def __init__(self):
        self.objects: dict[str, tuple[bytes, str]] = {}
        self.multipart: dict[str, dict] = {}   # upload id → {"key", "content_type", "parts": {n: bytes}}

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = (data, content_type)

    async def put_stream(self, key: str, fileobj, content_type: str) -> None:
        self.objects[key] = (fileobj.read(), content_type)

    async def get(self, key: str) -> tuple[bytes, str]:
        return self.objects[key]

    async def download_to(self, key: str, path: str) -> None:
        with open(path, "wb") as f:
            f.write(self.objects[key][0])

    async def head(self, key: str) -> int | None:
        obj = self.objects.get(key)
        return len(obj[0]) if obj else None

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    async def download_url(self, key: str, filename: str) -> str:
        return f"/api/_memory-storage/{key}"

    # Direct upload (the browser PUTs the bytes). The memory links are only served while this backend is in use.
    async def presign_put(self, key: str, content_type: str) -> str:
        return f"/api/_memory-storage/{key}?content_type={quote(content_type)}"

    async def start_multipart(self, key: str, content_type: str) -> str:
        upload_id = uuid.uuid4().hex
        self.multipart[upload_id] = {"key": key, "content_type": content_type, "parts": {}}
        return upload_id

    async def presign_part(self, key: str, upload_id: str, number: int) -> str:
        return f"/api/_memory-storage/{key}?upload_id={upload_id}&part={number}"

    def put_part(self, key: str, upload_id: str, number: int, data: bytes) -> str:
        up = self.multipart.get(upload_id)
        if up is None or up["key"] != key:
            raise KeyError(upload_id)
        up["parts"][number] = data
        return '"' + hashlib.md5(data).hexdigest() + '"'

    async def complete_multipart(self, key: str, upload_id: str, parts: list[dict]) -> None:
        up = self.multipart.pop(upload_id)
        data = b""
        for p in sorted(parts, key=lambda p: p["PartNumber"]):
            chunk = up["parts"][p["PartNumber"]]
            if '"' + hashlib.md5(chunk).hexdigest() + '"' != p["ETag"]:
                raise ValueError("ETag passer ikke")
            data += chunk
        self.objects[key] = (data, up["content_type"])

    async def abort_multipart(self, key: str, upload_id: str) -> None:
        self.multipart.pop(upload_id, None)

    def ensure_cors(self, origin: str) -> bool:
        return False


class S3Storage:
    def __init__(self):
        import boto3
        from botocore.config import Config

        s = config.settings
        self.bucket = s.s3_bucket
        self.client = boto3.client(
            "s3",
            endpoint_url=s.s3_endpoint,
            region_name=s.s3_region,
            aws_access_key_id=s.s3_access_key,
            aws_secret_access_key=s.s3_secret_key,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )
        # Upload links are signed for the address the browser uses (S3_PUBLIC_ENDPOINT, else S3_ENDPOINT).
        self.public = self.client if not s.s3_public_endpoint else boto3.client(
            "s3",
            endpoint_url=s.s3_public_endpoint,
            region_name=s.s3_region,
            aws_access_key_id=s.s3_access_key,
            aws_secret_access_key=s.s3_secret_key,
            config=Config(signature_version="s3v4", s3={"addressing_style": "path"}),
        )

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(self.client.put_object, Bucket=self.bucket, Key=key, Body=data,
                                ContentType=content_type)

    async def get(self, key: str) -> tuple[bytes, str]:
        obj = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=key)
        return await asyncio.to_thread(obj["Body"].read), obj.get("ContentType", "application/octet-stream")

    async def put_stream(self, key: str, fileobj, content_type: str) -> None:
        """Streams a file object to the bucket (multipart for big ones), without holding it in memory."""
        await asyncio.to_thread(self.client.upload_fileobj, fileobj, self.bucket, key,
                                ExtraArgs={"ContentType": content_type})

    async def download_to(self, key: str, path: str) -> None:
        await asyncio.to_thread(self.client.download_file, self.bucket, key, path)

    async def head(self, key: str) -> int | None:
        from botocore.exceptions import ClientError
        try:
            obj = await asyncio.to_thread(self.client.head_object, Bucket=self.bucket, Key=key)
        except ClientError as e:
            if e.response.get("Error", {}).get("Code") in ("404", "NoSuchKey", "NotFound"):
                return None
            raise
        return int(obj["ContentLength"])

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self.client.delete_object, Bucket=self.bucket, Key=key)

    # Direct upload: the browser PUTs to these links; the bucket needs CORS for ORIGIN (ensure_cors, job storage.cors).
    async def presign_put(self, key: str, content_type: str) -> str:
        return await asyncio.to_thread(
            self.public.generate_presigned_url, "put_object",
            Params={"Bucket": self.bucket, "Key": key, "ContentType": content_type},
            ExpiresIn=config.settings.upload_link_seconds,
        )

    async def start_multipart(self, key: str, content_type: str) -> str:
        r = await asyncio.to_thread(self.client.create_multipart_upload, Bucket=self.bucket, Key=key,
                                    ContentType=content_type)
        return r["UploadId"]

    async def presign_part(self, key: str, upload_id: str, number: int) -> str:
        return await asyncio.to_thread(
            self.public.generate_presigned_url, "upload_part",
            Params={"Bucket": self.bucket, "Key": key, "UploadId": upload_id, "PartNumber": number},
            ExpiresIn=config.settings.upload_link_seconds,
        )

    async def complete_multipart(self, key: str, upload_id: str, parts: list[dict]) -> None:
        await asyncio.to_thread(self.client.complete_multipart_upload, Bucket=self.bucket, Key=key,
                                UploadId=upload_id, MultipartUpload={"Parts": parts})

    async def abort_multipart(self, key: str, upload_id: str) -> None:
        await asyncio.to_thread(self.client.abort_multipart_upload, Bucket=self.bucket, Key=key, UploadId=upload_id)

    def ensure_cors(self, origin: str) -> bool:
        """Lets the app's origin PUT to upload links and read the ETag (multipart). Keeps other rules on the bucket.
        Returns whether anything changed."""
        from botocore.exceptions import ClientError
        try:
            rules = self.client.get_bucket_cors(Bucket=self.bucket).get("CORSRules", [])
        except ClientError:
            rules = []
        for r in rules:
            if origin in r.get("AllowedOrigins", []) and "PUT" in r.get("AllowedMethods", []) \
                    and "ETag" in r.get("ExposeHeaders", []):
                return False
        rules = [r for r in rules if origin not in r.get("AllowedOrigins", [])] + [{
            "AllowedOrigins": [origin], "AllowedMethods": ["PUT", "GET", "HEAD"], "AllowedHeaders": ["*"],
            "ExposeHeaders": ["ETag"], "MaxAgeSeconds": 3600}]
        self.client.put_bucket_cors(Bucket=self.bucket, CORSConfiguration={"CORSRules": rules})
        return True

    async def download_url(self, key: str, filename: str) -> str:
        safe = filename.replace('"', "")
        return await asyncio.to_thread(
            self.client.generate_presigned_url, "get_object",
            Params={"Bucket": self.bucket, "Key": key,
                    "ResponseContentDisposition": f'attachment; filename="{safe}"'},
            ExpiresIn=config.settings.download_link_seconds,
        )

    def ensure_bucket(self) -> None:
        try:
            self.client.head_bucket(Bucket=self.bucket)
        except Exception:
            self.client.create_bucket(Bucket=self.bucket)


def public_origin() -> str | None:
    """The origin the browser uploads to (for the CSP's connect-src), or None when it is the app itself."""
    s = config.settings
    if s.storage_backend == "memory" or not s.direct_upload:
        return None
    url = urlsplit(s.s3_public_endpoint or s.s3_endpoint or "")
    return f"{url.scheme}://{url.netloc}" if url.scheme in ("http", "https") and url.netloc else None


@lru_cache
def get_storage():
    if config.settings.storage_backend == "memory":
        return MemoryStorage()
    return S3Storage()
