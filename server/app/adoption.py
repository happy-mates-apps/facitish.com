"""Adoption analytics: journeys measured by the routes signed-in users visit (ported from surdej-v1 analytics.ts).

The pure functions take route activity grouped per user, path and week, so the rules are testable without a database:

- A step is reached when the user has a visit matching it since the journey start. The funnel is sequential: step N
  only counts users who also reached step N-1.
- The cohort (audience) is every user active in the period, users with a given role (also those with zero visits), or
  a fixed list of users.
- The forecast is linear: the average weekly gain of the last three weeks, towards the goal.
"""

from __future__ import annotations

import statistics
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone

from app import db
from app.adoption_match import StepMatcher, normalize, surface

DAY = timedelta(days=1)
WEEK = timedelta(days=7)

AUDIENCE_KINDS = ("all", "role", "users")
ROLE_LABELS = {"user": "Bruger", "admin": "Admin"}
SURFACE_LABELS = {"app": "Appen", "mobil": "Mobil", "udvidelse": "Udvidelse", "office": "Office"}
DIMS = {"role": "rolle", "surface": "flade", "locale": "sprog"}


def pct(a: float, b: float) -> int:
    return round(a / b * 100) if b > 0 else 0


def round1(v: float) -> float:
    return round(v * 10) / 10


def median(values: list[float]) -> float | None:
    return statistics.median(values) if values else None


def week_start(d: datetime) -> datetime:
    """Monday 00:00 UTC of the date's week."""
    d = d.astimezone(timezone.utc)
    day = datetime(d.year, d.month, d.day, tzinfo=timezone.utc)
    return day - timedelta(days=day.weekday())


def week_label(d: datetime) -> str:
    return f"U{d.isocalendar().week}"


def audience_text(audience: dict, names: dict[int, str] | None = None) -> str:
    kind = audience.get("kind", "all")
    if kind == "role":
        return "Rolle: " + ", ".join(ROLE_LABELS.get(r, r) for r in audience.get("roles", []))
    if kind == "users":
        n = len(audience.get("user_ids", []))
        return f"{n} udvalgte {'bruger' if n == 1 else 'brugere'}"
    return "Alle sporede brugere"


# ── Progress ────────────────────────────────────────────────────────────────

@dataclass
class Progress:
    reached_at: list[datetime | None]
    reached_count: int
    completed_at: datetime | None
    last_progress_at: datetime | None


def progress_by_user(steps: list[dict], rows: list[dict]) -> dict[int, Progress]:
    match = StepMatcher(steps)
    first_hits: dict[int, list[datetime | None]] = {}
    for r in rows:
        hit = match(r["path"])
        if not hit:
            continue
        arr = first_hits.setdefault(r["user_id"], [None] * len(steps))
        for i in hit:
            if arr[i] is None or r["first"] < arr[i]:
                arr[i] = r["first"]
    out = {}
    for key, hits in first_hits.items():
        n = 0
        while n < len(hits) and hits[n] is not None:
            n += 1
        reached_at = [h if i < n else None for i, h in enumerate(hits)]
        times = [h for h in reached_at if h is not None]
        last = max(times) if times else None
        out[key] = Progress(reached_at, n, last if steps and n == len(steps) else None, last)
    return out


def reached_count_as_of(p: Progress, as_of: datetime) -> int:
    n = 0
    while n < p.reached_count and p.reached_at[n] <= as_of:
        n += 1
    return n


def funnel_counts(step_count: int, progress: dict[int, Progress], cohort: set[int], as_of: datetime | None = None) -> list[int]:
    reached = [0] * step_count
    for key in cohort:
        p = progress.get(key)
        if p is None:
            continue
        n = reached_count_as_of(p, as_of) if as_of else p.reached_count
        for i in range(n):
            reached[i] += 1
    return reached


def forecast_completion(step_count: int, progress: dict[int, Progress], cohort: set[int], start_at: datetime,
                        goal_pct: int, now: datetime) -> dict:
    """Weekly completion since start (last 12 weeks) and a linear forecast towards the goal."""
    weeks = []
    w = week_start(start_at)
    while w <= now:
        weeks.append(w)
        w += WEEK
    shown = weeks[-12:]
    values = []
    for w in shown:
        end = min(w + WEEK - timedelta(microseconds=1), now)
        last = funnel_counts(step_count, progress, cohort, end)[-1] if step_count else 0
        values.append((week_label(w), last / max(1, len(cohort)) * 100))
    done = values[-1][1] if values else 0
    deltas = [b[1] - a[1] for a, b in zip(values, values[1:])][-3:]
    rate = max(0.0, sum(deltas) / len(deltas)) if deltas else 0.0
    reached = round(done) >= goal_pct
    weeks_to_goal = 0 if reached else (-(-(goal_pct - done) // rate) if rate > 0.05 else None)
    weeks_to_goal = int(weeks_to_goal) if weeks_to_goal is not None else None
    horizon = max(3, min(weeks_to_goal if weeks_to_goal is not None else 3, 6))
    last_week = shown[-1] if shown else week_start(now)
    forecast = [{"week": week_label(last_week + i * WEEK), "pct": round1(min(100, done + rate * i))} for i in range(horizon + 1)]
    forecast_date = (now + weeks_to_goal * WEEK).isoformat() if weeks_to_goal else None
    track = "reached" if reached else ("on-track" if weeks_to_goal is not None and weeks_to_goal <= 8 else "behind")
    return {"series": [{"week": k, "pct": round1(v)} for k, v in values], "forecast": forecast,
            "rate_per_week": round1(rate), "weeks_to_goal": weeks_to_goal, "forecast_date": forecast_date, "track": track}


def retention_cohorts(steps: list[dict], rows: list[dict], cohort: set[int], now: datetime) -> list[dict]:
    """Share of each first-visit week's users who come back to the journey's routes k weeks later."""
    match = StepMatcher(steps)
    weeks_by_user: dict[int, set[datetime]] = defaultdict(set)
    for r in rows:
        if r["user_id"] in cohort and match(r["path"]):
            weeks_by_user[r["user_id"]].add(week_start(r["week"]))
    current = week_start(now)
    out = []
    for r in range(7):
        row_week = current - (6 - r) * WEEK
        users = [ws for ws in weeks_by_user.values() if min(ws) == row_week]
        cells = []
        for k in range(7):
            w = row_week + k * WEEK
            cells.append(None if w > current else (pct(sum(1 for ws in users if w in ws), len(users)) if users else 0))
        out.append({"week": week_label(row_week), "users": len(users), "cells": cells})
    return out


# ── Dashboard ───────────────────────────────────────────────────────────────

def build_dashboard(*, steps: list[dict], start_at: datetime, goal_pct: int, rows: list[dict], cohort: set[int],
                    users: dict[int, dict], live_hits: list[dict], nudges: dict[int, datetime], dim: str,
                    now: datetime) -> dict:
    n = len(steps)
    progress = progress_by_user(steps, rows)
    counts = funnel_counts(n, progress, cohort)
    last = counts[-1] if n else 0
    done = pct(last, len(cohort))
    fc = forecast_completion(n, progress, cohort, start_at, goal_pct, now)
    match = StepMatcher(steps)

    funnel = []
    for i, s in enumerate(steps):
        has_next = i + 1 < n
        drop = counts[i] - counts[i + 1] if has_next else None
        gaps: list[float] = []
        exits: Counter[str] = Counter()
        if has_next:
            stopped = set()
            for key in cohort:
                p = progress.get(key)
                if p is None:
                    continue
                if p.reached_count > i + 1:
                    gaps.append(max(0.0, (p.reached_at[i + 1] - p.reached_at[i]) / DAY))
                elif p.reached_count == i + 1:
                    stopped.add(key)
            for r in rows:
                if r["user_id"] in stopped and not match(r["path"]):
                    exits[normalize(r["path"])] += r["n"]
        m = median(gaps)
        funnel.append({"step_id": s.get("id"), "label": s["label"], "match_type": s["match_type"], "pattern": s["pattern"],
                       "reached": counts[i], "pct": pct(counts[i], len(cohort)), "drop": drop,
                       "drop_pct": None if drop is None else pct(drop, counts[i]),
                       "median_days_to_next": None if m is None else round1(m),
                       "exits": [r for r, _ in exits.most_common(2)]})

    # Stuck: started, not done, no progress for 7+ days.
    stuck = sorted(((key, progress[key]) for key in cohort if key in progress
                    and 0 < progress[key].reached_count < n and progress[key].last_progress_at
                    and now - progress[key].last_progress_at >= 7 * DAY),
                   key=lambda kp: kp[1].last_progress_at)
    stuck_users = []
    for key, p in stuck[:8]:
        days = (now - p.last_progress_at).days
        stuck_users.append({"user_id": key, "name": users.get(key, {}).get("name") or f"Bruger {key}",
                            "detail": f"Står ved trin {p.reached_count} af {n} · {days} dage uden fremdrift",
                            "nudged_at": nudges[key].isoformat() if key in nudges else None})

    # Breakdown by role, surface or language.
    groups: dict[str, list[int]] = defaultdict(list)
    for key in cohort:
        v = users.get(key, {}).get(dim)
        if v:
            groups[v].append(key)
    breakdown = []
    for key, members in sorted(groups.items(), key=lambda kv: -len(kv[1]))[:6]:
        done_n = sum(1 for m in members if n > 0 and progress.get(m) and progress[m].reached_count == n)
        p = pct(done_n, len(members))
        stop_at = Counter(progress[m].reached_count if m in progress else 0 for m in members)
        stop_at = Counter({k: v for k, v in stop_at.items() if k < n})
        top = stop_at.most_common(1)
        breakdown.append({"key": key, "users": len(members), "pct": p, "delta_pt": p - done,
                          "stuck_at": steps[top[0][0]]["label"] if top else None})
    breakdown.sort(key=lambda r: -r["pct"])

    insights = []
    if len(breakdown) > 1 and breakdown[-1]["delta_pt"] < 0:
        worst, best = breakdown[-1], breakdown[0]
        insights.append({"tone": "bad", "title": f"{worst['key']} halter {abs(worst['delta_pt'])} pt efter",
                         "text": f"Kun {worst['pct']} % har gennemført."
                                 + (f" De fleste stopper ved »{worst['stuck_at']}«." if worst["stuck_at"] else "")
                                 + f" {best['key']} ligger i top med {best['pct']} %."})
    drops = sorted((f for f in funnel if f["drop_pct"] is not None and f["reached"] > 0), key=lambda f: -f["drop_pct"])
    if drops:
        f = drops[0]
        nxt = funnel[funnel.index(f) + 1]
        insights.append({"tone": "warn", "title": f"Største frafald: {f['label']} → {nxt['label']}",
                         "text": f"{f['drop_pct']} % går ikke videre."
                                 + (f" Mange lander på {f['exits'][0]} i stedet — overvej et link derfra." if f["exits"] else "")})
    if n:
        if fc["track"] == "reached":
            insights.append({"tone": "good", "title": "Målet er nået",
                             "text": f"Forløbet ligger {done - goal_pct} pt over målet. Overvej at hæve målet eller udvide målgruppen."})
        elif fc["forecast_date"]:
            rate = str(fc["rate_per_week"]).replace(".", ",")
            insights.append({"tone": "good", "title": "Prognosen holder",
                             "text": f"Med {rate} pt om ugen når forløbet {goal_pct} % om ca. {fc['weeks_to_goal']} uger."})
        else:
            insights.append({"tone": "warn", "title": "Ingen fremdrift i de seneste uger",
                             "text": f"Gennemførelsen står stille på {done} %. Et skub til dem der sidder fast kan sætte gang i den."})

    today = datetime(now.year, now.month, now.day, tzinfo=now.tzinfo)
    to_goal = [(p.completed_at - p.reached_at[0]) / DAY for key in cohort if (p := progress.get(key))
               and p.completed_at and p.reached_at[0]]
    m = median(to_goal)
    recent = now - timedelta(minutes=15)
    return {
        "cohort_size": len(cohort), "reached_last": last, "done_pct": done, "goal_pct": goal_pct, **fc,
        "kpis": {"active_now": len({h["user_id"] for h in live_hits if h["at"] >= recent}),
                 "new_today": sum(1 for key in cohort if (p := progress.get(key)) and p.reached_at and p.reached_at[0]
                                  and p.reached_at[0] >= today),
                 "median_days_to_goal": None if m is None else round1(m),
                 "stuck": len(stuck)},
        "funnel": funnel,
        "cohorts": retention_cohorts(steps, rows, cohort, now),
        "breakdown": {"dim": dim, "available": bool(breakdown), "rows": breakdown},
        "insights": insights,
        "stuck_total": len(stuck),
        "stuck_users": stuck_users,
    }


# ── Loading from Postgres ───────────────────────────────────────────────────

async def load_steps(conn, journey_id: int) -> list[dict]:
    return await db.fetch_all(conn, """select id, label, match_type, pattern from adoption_steps
                                       where journey_id = %s order by position""", (journey_id,))


def _period(journey: dict, now: datetime) -> tuple[datetime, datetime]:
    end = journey["end_at"] if journey["end_at"] and journey["end_at"] < now else now
    return journey["start_at"], end


async def fixed_cohort(conn, audience: dict) -> set[int] | None:
    """The cohort for audiences that do not depend on activity (role, users), else None."""
    kind = audience.get("kind", "all")
    if kind == "role":
        rows = await db.fetch_all(conn, """select id from users where role = any(%s) and blocked_at is null
                                           and not impersonation_only""", (list(audience.get("roles", [])),))
        return {r["id"] for r in rows}
    if kind == "users":
        rows = await db.fetch_all(conn, "select id from users where id = any(%s)", (list(audience.get("user_ids", [])),))
        return {r["id"] for r in rows}
    return None


async def load_activity(conn, journey: dict, now: datetime) -> tuple[list[dict], set[int]]:
    """Route activity since the start (per user, path and week) and the cohort it is measured on."""
    start, end = _period(journey, now)
    cohort = await fixed_cohort(conn, journey["audience"])
    if cohort is not None and not cohort:
        return [], cohort
    rows = await db.fetch_all(conn, f"""
        select user_id, path, date_trunc('week', at at time zone 'UTC') at time zone 'UTC' as week, min(at) as first,
               count(*) as n
        from adoption_visits where at >= %s and at <= %s {"and user_id = any(%s)" if cohort is not None else ""}
        group by 1, 2, 3""", (start, end, list(cohort)) if cohort is not None else (start, end))
    if cohort is None:
        cohort = {r["user_id"] for r in rows}
    return rows, cohort


async def summary(conn, journey: dict, steps: list[dict], now: datetime) -> dict:
    rows, cohort = await load_activity(conn, journey, now)
    progress = progress_by_user(steps, rows)
    reached = funnel_counts(len(steps), progress, cohort)
    return {"cohort_size": len(cohort), "reached": reached,
            "done_pct": pct(reached[-1], len(cohort)) if steps else 0}


async def user_info(conn, ids: set[int], rows: list[dict]) -> dict[int, dict]:
    """Display name and the breakdown fields (role, surface, language) per user."""
    if not ids:
        return {}
    users = await db.fetch_all(conn, "select id, display_name, role, locale from users where id = any(%s)", (list(ids),))
    surfaces: dict[int, Counter] = defaultdict(Counter)
    for r in rows:
        surfaces[r["user_id"]][surface(r["path"])] += r["n"]
    out = {}
    for u in users:
        top = surfaces[u["id"]].most_common(1)
        out[u["id"]] = {"name": u["display_name"], "role": ROLE_LABELS.get(u["role"], u["role"]),
                        "locale": (u["locale"] or "").upper() or None,
                        "surface": SURFACE_LABELS[top[0][0]] if top else None}
    return out


async def names(conn, ids: set[int]) -> dict[int, str]:
    if not ids:
        return {}
    rows = await db.fetch_all(conn, "select id, display_name from users where id = any(%s)", (list(ids),))
    return {r["id"]: r["display_name"] or f"Bruger {r['id']}" for r in rows}


async def recent_visits(conn, *, after_id: int = 0, since: datetime | None = None, limit: int = 100) -> list[dict]:
    return await db.fetch_all(conn, f"""
        select id, user_id, path, surface, at from adoption_visits
        where id > %s {"and at >= %s" if since else ""} order by id desc limit %s""",
        (after_id, since, limit) if since else (after_id, limit))
