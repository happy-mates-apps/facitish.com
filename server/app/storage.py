"""Object Storage. OVHcloud Object Storage is S3-compatible; MinIO stands in locally."""

import asyncio
from functools import lru_cache

from app import config


class MemoryStorage:
    """For tests. Download links point at the server itself."""

    def __init__(self):
        self.objects: dict[str, tuple[bytes, str]] = {}

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        self.objects[key] = (data, content_type)

    async def get(self, key: str) -> tuple[bytes, str]:
        return self.objects[key]

    async def delete(self, key: str) -> None:
        self.objects.pop(key, None)

    async def download_url(self, key: str, filename: str) -> str:
        return f"/api/_memory-storage/{key}"


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

    async def put(self, key: str, data: bytes, content_type: str) -> None:
        await asyncio.to_thread(self.client.put_object, Bucket=self.bucket, Key=key, Body=data,
                                ContentType=content_type)

    async def get(self, key: str) -> tuple[bytes, str]:
        obj = await asyncio.to_thread(self.client.get_object, Bucket=self.bucket, Key=key)
        return await asyncio.to_thread(obj["Body"].read), obj.get("ContentType", "application/octet-stream")

    async def delete(self, key: str) -> None:
        await asyncio.to_thread(self.client.delete_object, Bucket=self.bucket, Key=key)

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


@lru_cache
def get_storage():
    if config.settings.storage_backend == "memory":
        return MemoryStorage()
    return S3Storage()
