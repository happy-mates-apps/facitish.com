"""SMS text: segment counting (GSM-7 or UCS-2) and the texts the message channels send. After member-sms text.ts."""

import math

# GSM 03.38 basic character set; the extension characters count as two.
GSM7_BASIC = set(
    "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿"
    "abcdefghijklmnopqrstuvwxyzäöñüà")
GSM7_EXTENSION = set("^{}\\[~]|€\f")


def encoding(text: str) -> str:
    return "GSM-7" if all(c in GSM7_BASIC or c in GSM7_EXTENSION for c in text) else "UCS-2"


def segments(text: str) -> tuple[int, str]:
    """How many SMS segments a text takes, and in which encoding (160/153 GSM-7, 70/67 UCS-2)."""
    enc = encoding(text)
    if enc == "GSM-7":
        units = sum(2 if c in GSM7_EXTENSION else 1 for c in text)
        single, multi = 160, 153
    else:
        units = len(text.encode("utf-16-le")) // 2
        single, multi = 70, 67
    if units <= single:
        return 1, enc
    return math.ceil(units / multi), enc


def inbox_link(origin: str, broadcast_id: int | None = None) -> str:
    base = origin.rstrip("/") + "/beskeder"
    return f"{base}/{broadcast_id}" if broadcast_id else base


def broadcast_sms(app_name: str, title: str, body: str, link: str) -> str:
    return f"{app_name}: {title}\n{body}\n\nLæs i appen: {link}"


def reply_sms(app_name: str, title: str, body: str, link: str) -> str:
    return f"{app_name}: Svar på »{title}«\n{body}\n\nSvar i appen: {link}"


def preview_link(origin: str) -> str:
    """The link used for estimates, before a broadcast has an id (same length class as the real one)."""
    return inbox_link(origin, 1000000)
