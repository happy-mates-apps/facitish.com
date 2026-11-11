"""Sends one-time codes. SMS_PROVIDER=console in development, ovh in production."""

import hashlib
import json
import logging
import time

import httpx

from app import config, integrations

log = logging.getLogger("gaer.sms")


class SmsError(RuntimeError):
    pass


def otp_message(code: str, app_name: str, minutes: int) -> str:
    return f"{code} er din engangskode til {app_name}. Den udløber om {minutes} minutter. Del den ikke med andre."


async def send_sms(phone: str, message: str, sender: str) -> None:
    if config.settings.demo_mode:
        log.warning("DEMO_MODE SMS to %s: %s", phone, message)
        return
    provider = config.settings.sms_provider
    if provider == "console":
        if config.settings.is_production:
            raise SmsError("SMS_PROVIDER=console is not allowed in production")
        log.warning("SMS to %s from %s: %s", phone, sender, message)
        print(f"[sms] to={phone} from={sender}: {message}", flush=True)
        return
    if provider == "ovh":
        await _send_ovh(phone, message, sender)
        return
    raise SmsError(f"unknown SMS_PROVIDER {provider!r}")


async def _send_ovh(phone: str, message: str, sender: str) -> None:
    """OVHcloud SMS API: POST /sms/{serviceName}/jobs, signed with the application secret.
    https://help.ovhcloud.com/csm/en-sms-sending-via-api"""
    s = config.settings
    if not all((s.ovh_application_key, s.ovh_application_secret, s.ovh_consumer_key, s.ovh_sms_service)):
        raise SmsError("OVH SMS is not configured (OVH_APPLICATION_KEY/SECRET, OVH_CONSUMER_KEY, OVH_SMS_SERVICE)")
    url = f"{s.ovh_endpoint}/sms/{s.ovh_sms_service}/jobs"
    body = json.dumps({
        "message": message,
        "receivers": [phone],
        "sender": sender,
        "noStopClause": True,
        "priority": "high",
        "charset": "UTF-8",
        "coding": "8bit",
    }, separators=(",", ":"))
    async with httpx.AsyncClient(timeout=10, event_hooks=integrations.hooks("ovh_sms")) as client:
        server_time = (await client.get(f"{s.ovh_endpoint}/auth/time")).text.strip()
        timestamp = server_time if server_time.isdigit() else str(int(time.time()))
        to_sign = "+".join([s.ovh_application_secret, s.ovh_consumer_key, "POST", url, body, timestamp])
        signature = "$1$" + hashlib.sha1(to_sign.encode()).hexdigest()
        response = await client.post(url, content=body, headers={
            "Content-Type": "application/json",
            "X-Ovh-Application": s.ovh_application_key,
            "X-Ovh-Consumer": s.ovh_consumer_key,
            "X-Ovh-Timestamp": timestamp,
            "X-Ovh-Signature": signature,
        })
    if response.status_code >= 300:
        raise SmsError(f"OVH SMS failed: {response.status_code} {response.text[:200]}")
    result = response.json()
    if result.get("invalidReceivers"):
        raise SmsError("OVH SMS rejected the receiver")
