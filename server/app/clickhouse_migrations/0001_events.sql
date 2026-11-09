-- Events: short-lived facts the app wants to count (kind + object id + a number). Deleted after 7 days by TTL;
-- one partition per day, so ClickHouse drops whole days instead of rewriting parts.
-- No personal data: ref is an object id (never a user id, e-mail, phone or IP), data is a small JSON of ids/numbers.
CREATE TABLE IF NOT EXISTS events (
    ts     DateTime64(3, 'UTC') DEFAULT now64(3),
    kind   LowCardinality(String),
    ref    String DEFAULT '',
    value  Float64 DEFAULT 0,
    data   String DEFAULT '{}'
)
ENGINE = MergeTree
PARTITION BY toDate(ts)
ORDER BY (kind, ts)
TTL toDateTime(ts) + INTERVAL 7 DAY DELETE
SETTINGS ttl_only_drop_parts = 1;
