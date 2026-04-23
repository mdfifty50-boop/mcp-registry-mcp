# mcp-registry-mcp

MCP server for managing MCP server registries — health checks, duplicate detection, and configuration portability.

52% of remote MCP servers are dead. Only 9% are fully healthy. This server gives you a central registry to track what you have, what works, and what overlaps — before MCP sprawl becomes the microservices sprawl of 2018.

## Install

```bash
npx mcp-registry-mcp
```

### Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "mcp-registry": {
      "command": "npx",
      "args": ["mcp-registry-mcp"]
    }
  }
}
```

### From source

```bash
git clone https://github.com/mdfifty50-boop/mcp-registry-mcp.git
cd mcp-registry-mcp
npm install
node src/index.js
```

## Tools

### register_server

Register an MCP server with metadata.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `name` | string | required | Server name (e.g. "filesystem-mcp") |
| `url` | string | required | Server URL or package name |
| `transport` | string | `"stdio"` | `"stdio"`, `"sse"`, or `"streamable-http"` |
| `description` | string | `""` | What this server does |
| `org_id` | string | `"default"` | Organization for multi-tenant grouping |
| `tools` | string[] | `[]` | Tool names this server provides |

### health_check

Check server health. Probes HTTP endpoints, measures latency, tracks uptime over time.

| Param | Type | Description |
|-------|------|-------------|
| `server_id` | string | Server ID from register_server |

Returns: health status, latency, uptime percentage, last 5 check results.

### find_duplicates

Find servers with overlapping tool definitions using Jaccard similarity on tool name sets.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `org_id` | string | `"default"` | Organization to scan |

Returns pairs of overlapping servers with similarity scores and verdicts: `likely_duplicate` (>80%), `significant_overlap` (>50%), or `minor_overlap` (>30%).

### export_config

Export portable MCP configuration for different clients.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `server_ids` | string[] | required | Server IDs to include |
| `target_client` | string | `"claude_desktop"` | `"claude_desktop"`, `"cursor"`, `"vscode"`, or `"generic"` |

Returns a ready-to-paste JSON config block with client-specific instructions.

### get_inventory

List all registered servers with health and usage stats.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `org_id` | string | `"default"` | Organization to list (`"all"` for everything) |

Returns: server list with health status, uptime percentage, tool count, and summary stats.

### recommend_consolidation

Suggest merging duplicate or overlapping servers to reduce sprawl.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `org_id` | string | `"default"` | Organization to analyze |

Returns: recommendations to keep/retire specific servers with similarity scores and reasoning.

### check_before_install

Pre-install health, security, and duplicate check for a server you are considering adding.

| Param | Type | Default | Description |
|-------|------|---------|-------------|
| `server_url` | string | required | URL or package name to check |
| `transport` | string | `"streamable-http"` | Transport to probe with |
| `org_id` | string | `"default"` | Check duplicates against this org |

Returns: reachability, latency, TLS status, CORS headers, duplicate risk, and install recommendation (OK / CAUTION / DO NOT INSTALL).

## Resources

| URI | Description |
|-----|-------------|
| `mcp-registry://servers` | All registered servers with current health status |

## Usage Pattern

```
1. register_server — add each MCP server you use
2. health_check — verify each server is alive
3. find_duplicates — spot overlapping tools
4. recommend_consolidation — get merge suggestions
5. export_config — generate config for your client
6. check_before_install — vet new servers before adding
```

## Tests

```bash
npm test
```

## License

MIT
