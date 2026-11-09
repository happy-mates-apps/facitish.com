"""/api/admin/consumption — AI consumption over time, per model and per user; budgets per user; prices per model.

Reads are logged by require_admin (admin.read). Every change to budgets, prices and defaults is audited in the same
transaction. Budgets of one user may not overlap. See app/consumption.py for what applies to a user.
"""

import csv
import io
from datetime import date, datetime
from decimal import Decimal
from typing import Literal

from fastapi import APIRouter, Depends, HTTPException, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field, field_validator, model_validator

from app import ai, config, consumption, db, settings_store
from app.logs import audit, changed
from app.sessions import Principal, require_admin

router = APIRouter(prefix="/api/admin/consumption", tags=["admin"], dependencies=[Depends(require_admin)])

Range = Literal["day", "week", "month", "year", "custom"]


async def _period(conn, range_: str, start: date | None, end: date | None) -> dict:
    try:
        return await consumption.period(conn, range_, start, end)
    except ValueError as e:
        raise HTTPException(400, str(e))


# ── Overview ────────────────────────────────────────────────────────────────

@router.get("")
async def overview(range_: Range = Query("month", alias="range"), start: date | None = Query(None, alias="from"),
                   end: date | None = Query(None, alias="to")):
    async with db.connection() as conn:
        per = await _period(conn, range_, start, end)
        report = await consumption.report(conn, per)
        defaults = await settings_store.get_all(conn)
    return {"enabled": ai.enabled(), "model": config.settings.ai_model,
            "defaults": {"monthly_tokens": defaults["ai_default_monthly_tokens"], "warn_pct": defaults["ai_default_warn_pct"],
                         "warning_mail": defaults["ai_warning_mail"]},
            **report}


@router.get("/export.csv")
async def export(range_: Range = Query("month", alias="range"), start: date | None = Query(None, alias="from"),
                 end: date | None = Query(None, alias="to"), admin: Principal = Depends(require_admin)):
    """One row per user, day, model and surface in the period. No prompts or answers exist to export."""
    async with db.connection() as conn:
        per = await _period(conn, range_, start, end)
        rows = await db.fetch_all(conn, """
            select date_trunc('day', u.ts)::date as day, u.user_id, us.display_name, us.email, u.model, u.surface,
                   count(*) as requests, sum(u.prompt_tokens) as prompt_tokens, sum(u.completion_tokens) as completion_tokens,
                   coalesce(sum(u.prompt_tokens * coalesce(p.input_per_million, 0)
                                + u.completion_tokens * coalesce(p.output_per_million, 0)) / 1000000, 0) as cost
            from ai_usage u join users us on us.id = u.user_id left join ai_model_prices p on p.model = u.model
            where u.ts >= %s and u.ts < %s
            group by 1, 2, 3, 4, 5, 6 order by 1, 2, 5, 6 limit 200000""", (per["start"], per["end"]))
        await audit(conn, "log.exported", actor_id=admin.user_id, meta=admin.meta, log="ai_usage", rows=len(rows),
                    filters={"range": range_, "from": per["start"], "to": per["end"]})
    buf = io.StringIO()
    writer = csv.writer(buf, delimiter=";")
    writer.writerow(["dag", "bruger-id", "navn", "e-mail", "model", "overflade", "forespørgsler", "input-tokens",
                     "output-tokens", "anslået pris"])
    for r in rows:
        writer.writerow([r["day"].isoformat(), r["user_id"], r["display_name"] or "", r["email"] or "", r["model"],
                         r["surface"], r["requests"], r["prompt_tokens"], r["completion_tokens"],
                         f"{r['cost']:.4f}".replace(".", ",")])
    filename = f"ai-forbrug-{datetime.now():%Y%m%d-%H%M}.csv"
    return StreamingResponse(iter(["﻿" + buf.getvalue()]), media_type="text/csv; charset=utf-8",
                             headers={"Content-Disposition": f'attachment; filename="{filename}"'})


class DefaultsIn(BaseModel):
    monthly_tokens: int = Field(ge=0, le=100_000_000)
    warn_pct: int = Field(ge=0, le=95)
    warning_mail: bool = True

    @field_validator("warn_pct")
    @classmethod
    def _warn(cls, v: int) -> int:
        if v and v not in consumption.WARN_CHOICES:
            raise ValueError(f"Vælg en af {', '.join(map(str, consumption.WARN_CHOICES))} eller 0")
        return v


@router.put("/defaults")
async def defaults(body: DefaultsIn, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        s = await settings_store.get_all(conn)
        before = {"monthly_tokens": s["ai_default_monthly_tokens"], "warn_pct": s["ai_default_warn_pct"],
                  "warning_mail": s["ai_warning_mail"]}
        after = {"monthly_tokens": body.monthly_tokens, "warn_pct": body.warn_pct, "warning_mail": body.warning_mail}
        await settings_store.set_many(conn, {"ai_default_monthly_tokens": body.monthly_tokens,
                                             "ai_default_warn_pct": body.warn_pct,
                                             "ai_warning_mail": body.warning_mail})
        b, a = changed(before, after)
        if a:
            await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="settings", row_id="ai_consumption",
                        before=b, after=a)
    return {"ok": True}


# ── Budgets ─────────────────────────────────────────────────────────────────

class BudgetIn(BaseModel):
    user_id: int
    monthly_tokens: int = Field(ge=0, le=100_000_000)
    warn_pcts: list[int] = Field(default_factory=lambda: [80], max_length=6)
    hard: bool = True
    total_tokens: int | None = Field(default=None, gt=0, le=10_000_000_000)
    starts_on: date
    ends_on: date | None = None
    note: str = Field(default="", max_length=200)

    @field_validator("warn_pcts")
    @classmethod
    def _warns(cls, v: list[int]) -> list[int]:
        bad = [w for w in v if w not in consumption.WARN_CHOICES]
        if bad:
            raise ValueError(f"Advarsler skal være en af {', '.join(map(str, consumption.WARN_CHOICES))}")
        return sorted(set(v))

    @model_validator(mode="after")
    def _dates(self):
        if self.ends_on is not None and self.ends_on < self.starts_on:
            raise ValueError("Slutdatoen ligger før startdatoen")
        self.note = self.note.strip()
        return self


BUDGET_FIELDS = ("user_id", "monthly_tokens", "warn_pcts", "hard", "total_tokens", "starts_on", "ends_on", "note")


async def _check_budget(conn, body: BudgetIn, budget_id: int | None) -> None:
    user = await db.fetch_one(conn, "select id, impersonation_only from users where id = %s", (body.user_id,))
    if user is None:
        raise HTTPException(404, "Brugeren findes ikke")
    clash = await db.fetch_one(conn, """
        select id, starts_on, ends_on from ai_budgets
        where user_id = %s and id <> coalesce(%s, 0)
          and starts_on <= coalesce(%s::date, 'infinity'::date) and coalesce(ends_on, 'infinity'::date) >= %s::date
        limit 1""", (body.user_id, budget_id, body.ends_on, body.starts_on))
    if clash:
        end = clash["ends_on"].isoformat() if clash["ends_on"] else "uden slutdato"
        raise HTTPException(409, f"Brugeren har allerede et budget i perioden ({clash['starts_on'].isoformat()} – {end})")


def _row(b: dict) -> dict:
    return {k: b[k] for k in BUDGET_FIELDS}


@router.get("/budgets")
async def budgets():
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            select b.*, u.display_name, u.email, u.phone, c.display_name as created_by_name, current_date as today
            from ai_budgets b join users u on u.id = b.user_id left join users c on c.id = b.created_by
            order by (b.ends_on is not null and b.ends_on < current_date), b.starts_on desc, b.id desc""")
        pol = await consumption.policies(conn, sorted({r["user_id"] for r in rows}))
    for r in rows:
        r["status"] = consumption.budget_status(r, r.pop("today"))
        p = pol[r["user_id"]]
        r["current"] = r["status"] == "active" and p["budget"] is not None and p["budget"]["id"] == r["id"]
        r["month_used"] = p["used"]
        r["total_used"] = p["budget"]["total_used"] if r["current"] else None
        r["user_status"] = p["status"] if r["current"] else None
    return {"items": rows, "warn_choices": consumption.WARN_CHOICES}


@router.post("/budgets")
async def create_budget(body: BudgetIn, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        await _check_budget(conn, body, None)
        row = await db.fetch_one(conn, """
            insert into ai_budgets (user_id, monthly_tokens, warn_pcts, hard, total_tokens, starts_on, ends_on, note,
                                    created_by)
            values (%s, %s, %s::smallint[], %s, %s, %s, %s, %s, %s) returning *""",
            (body.user_id, body.monthly_tokens, body.warn_pcts, body.hard, body.total_tokens, body.starts_on,
             body.ends_on, body.note, admin.user_id))
        await audit(conn, "create", actor_id=admin.user_id, meta=admin.meta, table="ai_budgets", row_id=row["id"],
                    after=_row(row))
    return {"id": row["id"]}


@router.put("/budgets/{budget_id}")
async def update_budget(budget_id: int, body: BudgetIn, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        before = await db.fetch_one(conn, "select * from ai_budgets where id = %s for update", (budget_id,))
        if before is None:
            raise HTTPException(404, "Budgettet findes ikke")
        if body.user_id != before["user_id"]:
            raise HTTPException(400, "Et budget kan ikke flyttes til en anden bruger")
        await _check_budget(conn, body, budget_id)
        after = await db.fetch_one(conn, """
            update ai_budgets set monthly_tokens = %s, warn_pcts = %s::smallint[], hard = %s, total_tokens = %s,
                   starts_on = %s, ends_on = %s, note = %s, updated_at = now()
            where id = %s returning *""",
            (body.monthly_tokens, body.warn_pcts, body.hard, body.total_tokens, body.starts_on, body.ends_on, body.note,
             budget_id))
        b, a = changed(_row(before), _row(after))
        if a:
            await audit(conn, "update", actor_id=admin.user_id, meta=admin.meta, table="ai_budgets", row_id=budget_id,
                        before=b, after=a)
    return {"ok": True}


@router.delete("/budgets/{budget_id}")
async def delete_budget(budget_id: int, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        row = await db.fetch_one(conn, "delete from ai_budgets where id = %s returning *", (budget_id,))
        if row is None:
            raise HTTPException(404, "Budgettet findes ikke")
        await audit(conn, "delete", actor_id=admin.user_id, meta=admin.meta, table="ai_budgets", row_id=budget_id,
                    before=_row(row))
    return {"ok": True}


# ── Prices per model ────────────────────────────────────────────────────────

class PriceIn(BaseModel):
    model: str = Field(min_length=1, max_length=200)
    input_per_million: Decimal = Field(ge=0, le=1_000_000, decimal_places=4)
    output_per_million: Decimal = Field(ge=0, le=1_000_000, decimal_places=4)


class PricesIn(BaseModel):
    items: list[PriceIn] = Field(max_length=200)


@router.get("/prices")
async def prices():
    """Every model with a price or any use, and the one configured now."""
    async with db.connection() as conn:
        rows = await db.fetch_all(conn, """
            with used as (select model, max(ts) as last_used, count(*) as requests from ai_usage group by model)
            select coalesce(p.model, u.model) as model, coalesce(p.input_per_million, 0) as input_per_million,
                   coalesce(p.output_per_million, 0) as output_per_million, (p.model is not null) as priced,
                   p.updated_at, u.last_used, coalesce(u.requests, 0) as requests
            from ai_model_prices p full join used u on u.model = p.model
            order by u.last_used desc nulls last, 1""")
    if not any(r["model"] == config.settings.ai_model for r in rows):
        rows.insert(0, {"model": config.settings.ai_model, "input_per_million": 0, "output_per_million": 0, "priced": False,
                        "updated_at": None, "last_used": None, "requests": 0})
    return {"items": rows, "current_model": config.settings.ai_model}


@router.put("/prices")
async def set_prices(body: PricesIn, admin: Principal = Depends(require_admin)):
    async with db.connection() as conn:
        for item in body.items:
            before = await db.fetch_one(conn, "select input_per_million, output_per_million from ai_model_prices "
                                              "where model = %s for update", (item.model,))
            after = {"input_per_million": item.input_per_million, "output_per_million": item.output_per_million}
            if before is not None and not changed(before, after)[1]:
                continue
            await conn.execute("""
                insert into ai_model_prices (model, input_per_million, output_per_million, updated_by, updated_at)
                values (%s, %s, %s, %s, now())
                on conflict (model) do update set input_per_million = excluded.input_per_million,
                    output_per_million = excluded.output_per_million, updated_by = excluded.updated_by, updated_at = now()""",
                (item.model, item.input_per_million, item.output_per_million, admin.user_id))
            await audit(conn, "create" if before is None else "update", actor_id=admin.user_id, meta=admin.meta,
                        table="ai_model_prices", row_id=item.model, before=before, after=after)
    return {"ok": True}
