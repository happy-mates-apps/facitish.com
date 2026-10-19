"""A minimal MCP client over Streamable HTTP (JSON responses), as Claude Code or VS Code talk to the server."""

import itertools

PROTOCOL = "2025-06-18"


class McpClient:
    def __init__(self, http, path: str, token: str):
        self.http, self.path, self.token = http, path, token
        self.session_id: str | None = None
        self.ids = itertools.count(1)

    def headers(self) -> dict:
        h = {"authorization": f"Bearer {self.token}", "accept": "application/json, text/event-stream",
             "content-type": "application/json"}
        if self.session_id:
            h |= {"mcp-session-id": self.session_id, "mcp-protocol-version": PROTOCOL}
        return h

    async def raw(self, method: str, params: dict | None = None):
        body = {"jsonrpc": "2.0", "id": next(self.ids), "method": method, **({"params": params} if params else {})}
        return await self.http.post(self.path, json=body, headers=self.headers())

    async def initialize(self) -> "McpClient":
        r = await self.raw("initialize", {"protocolVersion": PROTOCOL, "capabilities": {},
                                          "clientInfo": {"name": "pytest", "version": "1"}})
        assert r.status_code == 200, r.text
        self.session_id = r.headers["mcp-session-id"]
        await self.http.post(self.path, json={"jsonrpc": "2.0", "method": "notifications/initialized"}, headers=self.headers())
        return self

    async def list_tools(self) -> list[dict]:
        r = await self.raw("tools/list")
        assert r.status_code == 200, r.text
        return r.json()["result"]["tools"]

    async def call(self, name: str, **arguments) -> tuple[dict, bool]:
        r = await self.raw("tools/call", {"name": name, "arguments": arguments})
        assert r.status_code == 200, r.text
        result = r.json()["result"]
        return result["structuredContent"], result["isError"]
