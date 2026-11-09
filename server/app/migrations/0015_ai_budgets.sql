-- AI consumption: budgets per user, warnings when a budget is nearly used, and prices per model (only used to
-- estimate cost in /admin/consumption). Usage itself stays in ai_usage (0003).
--
-- A budget belongs to one user and runs from starts_on to ends_on (null: no end date). It sets a cap per calendar
-- month, the percentages at which the user is warned, whether reaching the cap blocks AI (hard) or only warns,
-- and optionally a total for the whole period. Outside a budget the user's own limit (users.ai_monthly_tokens) or
-- the instance default applies. Budgets of one user may not overlap; app/consumption.py checks that.

create table ai_budgets (
    id              bigserial primary key,
    user_id         bigint not null references users (id) on delete cascade,
    monthly_tokens  integer not null check (monthly_tokens >= 0),
    warn_pcts       smallint[] not null default '{80}'
                    check (warn_pcts <@ array[10,20,25,30,40,50,60,70,75,80,85,90,95]::smallint[]),
    hard            boolean not null default true,       -- true: AI stops at the cap; false: only a warning
    total_tokens    bigint check (total_tokens is null or total_tokens > 0),
    starts_on       date not null default current_date,
    ends_on         date check (ends_on is null or ends_on >= starts_on),
    note            text not null default '' check (length(note) <= 200),
    created_by      bigint references users (id) on delete set null,
    created_at      timestamptz not null default now(),
    updated_at      timestamptz not null default now()
);
create index ai_budgets_user_idx on ai_budgets (user_id, starts_on desc);

-- One row each time a user passes a warning, reaches the cap or uses up the period total, once per month and level.
-- Used for the webhooks (sent once), the warning count in /admin/consumption and the user's own page.
create table ai_budget_alerts (
    id          bigserial primary key,
    user_id     bigint not null references users (id) on delete cascade,
    budget_id   bigint references ai_budgets (id) on delete set null,
    month       date not null,                           -- first day of the month
    kind        text not null check (kind in ('warning', 'cap', 'total')),
    pct         smallint not null,                       -- the warning level; 100 for cap and total
    used        bigint not null,
    limit_tokens bigint not null,
    created_at  timestamptz not null default now(),
    unique (user_id, month, kind, pct)
);
create index ai_budget_alerts_created_idx on ai_budget_alerts (created_at);

create table ai_model_prices (
    model               text primary key check (length(model) between 1 and 200),
    input_per_million   numeric(12, 4) not null default 0 check (input_per_million >= 0),
    output_per_million  numeric(12, 4) not null default 0 check (output_per_million >= 0),
    updated_by          bigint references users (id) on delete set null,
    updated_at          timestamptz not null default now()
);

-- Reports group usage by time and model.
create index ai_usage_ts_idx on ai_usage (ts);

insert into retention_policies (key, title, description, days, min_days) values
    ('ai_budget_alerts', 'AI-budgetadvarsler', 'Advarsler om AI-budgetter (hvornår en bruger nåede en grænse)', 730, 31);
