"""db_query and db_schema for /mcp/admin.

db_query takes exactly one SELECT / WITH / EXPLAIN statement. The statement is tokenized (strings, quoted
identifiers, dollar quotes and comments are understood), not matched with a regex. It then runs on the
separate <db>_mcp_ro user (SELECT only; no sessions, codes, tokens or auth log) in a READ ONLY transaction with
a 5 s statement timeout, returns at most 500 rows, and masks phone numbers, hashes, tokens and keys.
"""

import re

import psycopg
from psycopg.rows import dict_row

from app import config, db
from app.mcp.registry import ToolError

MAX_ROWS = 500
ALLOWED_FIRST = {"select", "with", "explain", "values", "table"}
FORBIDDEN = {"insert", "update", "delete", "merge", "truncate", "drop", "alter", "create", "grant", "revoke", "copy",
             "call", "do", "vacuum", "analyze", "cluster", "reindex", "refresh", "lock", "listen", "notify", "set",
             "reset", "begin", "commit", "rollback", "savepoint", "prepare", "execute", "discard", "comment", "security"}
SECRET_COLUMN = re.compile(r"^(phone(_\w+)?|\w*_?hash|code_hash|token_hash|public_key|credential_id|secret\w*|token\w*|password\w*)$",
                           re.I)
PHONE_VALUE = re.compile(r"^\+?\d[\d \-]{7,}\d$")


def tokenize(sql: str) -> list[str]:
    """Lower-cased words and the punctuation that matters (';'), skipping literals and comments."""
    tokens, i, n = [], 0, len(sql)
    while i < n:
        c = sql[i]
        if c.isspace():
            i += 1
        elif sql.startswith("--", i):
            i = sql.find("\n", i)
            i = n if i < 0 else i
        elif sql.startswith("/*", i):
            end = sql.find("*/", i + 2)
            if end < 0:
                raise ToolError("Uafsluttet kommentar")
            i = end + 2
        elif c in "'\"":
            j = i + 1
            while True:
                j = sql.find(c, j)
                if j < 0:
                    raise ToolError("Uafsluttet streng")
                if j + 1 < n and sql[j + 1] == c:  # doubled quote inside the literal
                    j += 2
                    continue
                break
            tokens.append("'lit'" if c == "'" else "\"ident\"")
            i = j + 1
        elif c == "$" and (m := re.match(r"\$(\w*)\$", sql[i:])):
            tag = m.group(0)
            end = sql.find(tag, i + len(tag))
            if end < 0:
                raise ToolError("Uafsluttet $-streng")
            tokens.append("'lit'")
            i = end + len(tag)
        elif c.isalpha() or c == "_":
            m = re.match(r"[A-Za-z_][A-Za-z0-9_$]*", sql[i:])
            tokens.append(m.group(0).lower())
            i += len(m.group(0))
        else:
            tokens.append(c)
            i += 1
    return tokens


def check_query(sql: str) -> str:
    tokens = tokenize(sql)
    while tokens and tokens[-1] == ";":
        tokens.pop()
        sql = sql.rstrip().rstrip(";")
    if not tokens:
        raise ToolError("Tom forespørgsel")
    if ";" in tokens:
        raise ToolError("Kun én sætning ad gangen")
    if tokens[0] not in ALLOWED_FIRST:
        raise ToolError("Kun SELECT, WITH og EXPLAIN er tilladt")
    bad = FORBIDDEN.intersection(t for t in tokens if t.isidentifier())
    # "set" and "analyze" are only harmless as parts of a SELECT (e.g. a column called set is not allowed either).
    if bad:
        raise ToolError(f"Ikke tilladt i en læseforespørgsel: {', '.join(sorted(bad)).upper()}")
    if "into" in tokens and tokens[0] in ("select", "with"):
        raise ToolError("SELECT … INTO er ikke tilladt")
    return sql


def mask(rows: list[dict]) -> list[dict]:
    out = []
    for r in rows:
        clean = {}
        for k, v in r.items():
            if v is None:
                clean[k] = None
            elif SECRET_COLUMN.match(k):
                clean[k] = "•••"
            elif isinstance(v, str) and PHONE_VALUE.match(v.strip()):
                clean[k] = v[:3] + " •••• ••" + v[-2:]
            elif isinstance(v, (bytes, memoryview)):
                clean[k] = "<binary>"
            else:
                clean[k] = v
        out.append(clean)
    return out


async def run_query(sql: str) -> dict:
    url = config.settings.mcp_db_query_url
    if not url:
        raise ToolError("db_query er ikke tilgængelig: MCP_DB_QUERY_URL er ikke sat på instansen")
    sql = check_query(sql)
    async with await psycopg.AsyncConnection.connect(url, row_factory=dict_row) as conn:
        await conn.set_read_only(True)
        try:
            async with conn.transaction():
                await conn.execute("set local statement_timeout = '5s'")
                cur = await conn.execute(sql)
                rows = await cur.fetchmany(MAX_ROWS + 1) if cur.description else []
                columns = [d.name for d in cur.description] if cur.description else []
                raise _Rollback(rows, columns)
        except _Rollback as r:
            rows, columns = r.rows, r.columns
        except psycopg.errors.QueryCanceled:
            raise ToolError("Forespørgslen tog mere end 5 sekunder og blev stoppet")
        except psycopg.errors.InsufficientPrivilege as e:
            raise ToolError(f"Ingen adgang for den læsende bruger: {e.diag.message_primary}")
        except psycopg.Error as e:
            raise ToolError(f"SQL-fejl: {e.diag.message_primary or e}")
    return {"columns": columns, "rows": mask(rows[:MAX_ROWS]), "truncated": len(rows) > MAX_ROWS}


class _Rollback(Exception):
    """Leaves the read-only transaction with a rollback, carrying the result out."""

    def __init__(self, rows, columns):
        self.rows, self.columns = rows, columns


async def schema() -> dict:
    async with db.connection() as conn:
        columns = await db.fetch_all(conn, """
            select c.table_name, c.column_name, c.data_type, c.is_nullable = 'YES' as nullable
            from information_schema.columns c join pg_tables t on t.tablename = c.table_name and t.schemaname = 'public'
            where c.table_schema = 'public' and c.table_name not like 'analytics_events_%%'
            order by c.table_name, c.ordinal_position""")
        counts = await db.fetch_all(conn, """
            select relname as table_name, greatest(reltuples, 0)::bigint as approx_rows from pg_class
            where relkind in ('r', 'p') and relnamespace = 'public'::regnamespace""")
        migrations = await db.fetch_all(conn, "select name, applied_at from schema_migrations order by name")
    tables: dict[str, dict] = {}
    for c in columns:
        t = tables.setdefault(c["table_name"], {"columns": []})
        t["columns"].append({"name": c["column_name"], "type": c["data_type"], "nullable": c["nullable"]})
    for r in counts:
        if r["table_name"] in tables:
            tables[r["table_name"]]["approx_rows"] = r["approx_rows"]
    return {"tables": tables, "migrations": migrations,
            "read_only_role": bool(config.settings.mcp_db_query_url),
            "hidden_from_db_query": ["otp_codes", "webauthn_challenges", "sessions", "mcp_tokens", "auth_log"]}
