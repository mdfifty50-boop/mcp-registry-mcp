#!/usr/bin/env node

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  registerServer,
  recordHealthCheck,
  getHealthHistory,
  getServer,
  getServerByUrl,
  getServersByOrg,
  getAllServers,
  findDuplicates,
  exportConfig,
  recommendConsolidation,
} from './storage.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';


const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf8'));
const startTime = Date.now();
let toolCallCount = 0;

function wrap(fn) {
  return async (...args) => {
    toolCallCount++;
    try { return await fn(...args); }
    catch (e) { return { content: [{ type: 'text', text: JSON.stringify({ error: e.message }) }] }; }
  };
}
const server = new McpServer({
  name: 'mcp-registry-mcp',
  version: pkg.version,
  description: 'MCP server registry — health checks, duplicate detection, and configuration portability',
});

server.tool('health_check', 'Returns server health, uptime, version, and call stats', {},
  wrap(async () => ({
    content: [{ type: 'text', text: JSON.stringify({
      status: 'healthy', server: 'mcp-registry-mcp', version: pkg.version,
      uptime_seconds: Math.floor((Date.now() - startTime) / 1000),
      tool_calls_served: toolCallCount,
    }, null, 2) }],
  }))
);

// ═══════════════════════════════════════════
// REGISTER SERVER
// ═══════════════════════════════════════════

server.tool(
  'register_server',
  'Register an MCP server with metadata. Tracks health, tools, and org membership.',
  {
    name: z.string().describe('Server name (e.g. "filesystem-mcp")'),
    url: z.string().describe('Server URL or package name'),
    transport: z.enum(['stdio', 'sse', 'streamable-http']).default('stdio').describe('Transport type'),
    description: z.string().default('').describe('What this server does'),
    org_id: z.string().default('default').describe('Organization identifier for multi-tenant grouping'),
    tools: z.array(z.string()).default([]).describe('List of tool names this server provides (if known)'),
  },
  async (params) => {
    const record = registerServer(params);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          registered: true,
          server_id: record.id,
          name: record.name,
          url: record.url,
          transport: record.transport,
          org_id: record.org_id,
          registered_at: record.registered_at,
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════

async function probeServer(srv) {
  const start = Date.now();

  // For HTTP-based transports, attempt a real connection
  if (srv.transport === 'sse' || srv.transport === 'streamable-http') {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const res = await fetch(srv.url, {
        method: srv.transport === 'sse' ? 'GET' : 'POST',
        signal: controller.signal,
        headers: srv.transport === 'streamable-http'
          ? { 'Content-Type': 'application/json', 'Accept': 'application/json' }
          : {},
        body: srv.transport === 'streamable-http'
          ? JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-registry-probe', version: '0.1.0' } } })
          : undefined,
      });
      clearTimeout(timeout);
      const latency = Date.now() - start;

      if (!res.ok && res.status !== 405) {
        return { healthy: false, latency_ms: latency, error: `HTTP ${res.status}`, tool_count: 0, tools_discovered: [] };
      }

      // Try to parse tool list from initialize response
      let tools = [];
      if (srv.transport === 'streamable-http') {
        try {
          const body = await res.json();
          if (body?.result?.capabilities?.tools) {
            tools = Object.keys(body.result.capabilities.tools);
          }
        } catch { /* ignore parse errors */ }
      }

      return { healthy: true, latency_ms: latency, error: null, tool_count: tools.length || srv.tools?.length || 0, tools_discovered: tools.length ? tools : srv.tools || [] };
    } catch (err) {
      return { healthy: false, latency_ms: Date.now() - start, error: err.message, tool_count: 0, tools_discovered: [] };
    }
  }

  // For stdio, we can't probe directly — mark as presumed healthy with tool count from registration
  return {
    healthy: true,
    latency_ms: 0,
    error: null,
    tool_count: srv.tools?.length || 0,
    tools_discovered: srv.tools || [],
    note: 'stdio transport — health inferred from registration, not probed',
  };
}

server.tool(
  'health_check',
  'Check server health. Attempts connection, measures latency, tracks uptime history.',
  {
    server_id: z.string().describe('Server ID returned from register_server'),
  },
  async ({ server_id }) => {
    const srv = getServer(server_id);
    if (!srv) {
      return { content: [{ type: 'text', text: JSON.stringify({ error: 'Server not found', server_id }, null, 2) }] };
    }

    const probeResult = await probeServer(srv);
    const recorded = recordHealthCheck(server_id, probeResult);
    const history = getHealthHistory(server_id);
    const last5 = history.slice(-5);

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          server_id,
          name: srv.name,
          ...recorded,
          recent_checks: last5.map(h => ({ time: h.timestamp, ok: h.healthy, ms: h.latency_ms })),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// FIND DUPLICATES
// ═══════════════════════════════════════════

server.tool(
  'find_duplicates',
  'Find servers with overlapping tool definitions. Uses Jaccard similarity on tool name sets.',
  {
    org_id: z.string().default('default').describe('Organization to scan'),
  },
  async ({ org_id }) => {
    const pairs = findDuplicates(org_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          org_id,
          duplicate_pairs: pairs.length,
          pairs,
          scanned_at: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// EXPORT CONFIG
// ═══════════════════════════════════════════

server.tool(
  'export_config',
  'Export portable MCP config for Claude Desktop, Cursor, or VS Code.',
  {
    server_ids: z.array(z.string()).describe('Server IDs to include in the config'),
    target_client: z.enum(['claude', 'claude_desktop', 'cursor', 'vscode', 'generic']).default('claude_desktop').describe('Target client format'),
  },
  async ({ server_ids, target_client }) => {
    const result = exportConfig(server_ids, target_client);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          exported: true,
          format: result.format,
          server_count: server_ids.length,
          config: result.config,
          instructions: target_client === 'claude_desktop' || target_client === 'claude'
            ? 'Paste into ~/Library/Application Support/Claude/claude_desktop_config.json (macOS) or %APPDATA%\\Claude\\claude_desktop_config.json (Windows)'
            : target_client === 'cursor'
            ? 'Paste into .cursor/mcp.json in your project root'
            : target_client === 'vscode'
            ? 'Add to .vscode/settings.json'
            : 'Generic format — adapt to your client',
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// GET INVENTORY
// ═══════════════════════════════════════════

server.tool(
  'get_inventory',
  'List all registered servers with health and usage stats.',
  {
    org_id: z.string().default('default').describe('Organization to list (default: all)'),
  },
  async ({ org_id }) => {
    const srvs = org_id === 'all' ? getAllServers() : getServersByOrg(org_id);

    const inventory = srvs.map(s => ({
      id: s.id,
      name: s.name,
      url: s.url,
      transport: s.transport,
      health_status: s.health_status,
      uptime_percent: s.total_checks > 0
        ? Math.round((s.successful_checks / s.total_checks) * 10000) / 100
        : null,
      total_checks: s.total_checks,
      tool_count: s.tools?.length || 0,
      last_check: s.last_health_check,
      registered_at: s.registered_at,
    }));

    const healthy = inventory.filter(s => s.health_status === 'healthy').length;
    const unhealthy = inventory.filter(s => s.health_status === 'unhealthy').length;
    const unknown = inventory.filter(s => s.health_status === 'unknown').length;

    return {
      content: [{
        type: 'text',
        text: JSON.stringify({
          org_id,
          total: inventory.length,
          healthy,
          unhealthy,
          unknown,
          health_rate: inventory.length > 0 ? Math.round((healthy / inventory.length) * 100) + '%' : 'N/A',
          servers: inventory,
          generated_at: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// RECOMMEND CONSOLIDATION
// ═══════════════════════════════════════════

server.tool(
  'recommend_consolidation',
  'Suggest merging duplicate or overlapping servers to reduce sprawl.',
  {
    org_id: z.string().default('default').describe('Organization to analyze'),
  },
  async ({ org_id }) => {
    const result = recommendConsolidation(org_id);
    return {
      content: [{
        type: 'text',
        text: JSON.stringify(result, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// CHECK BEFORE INSTALL
// ═══════════════════════════════════════════

server.tool(
  'check_before_install',
  'Pre-install report: health probe, security flags, estimated token cost, and duplicate check against your registry.',
  {
    server_url: z.string().describe('URL or npm package name to check'),
    transport: z.enum(['stdio', 'sse', 'streamable-http']).default('streamable-http').describe('Transport to probe with'),
    org_id: z.string().default('default').describe('Check for duplicates against this org'),
  },
  async ({ server_url, transport, org_id }) => {
    const report = { url: server_url, transport, checked_at: new Date().toISOString() };

    // 1. Check if already registered
    const existing = getServerByUrl(server_url);
    if (existing) {
      report.already_registered = { id: existing.id, name: existing.name };
    }

    // 2. Health probe
    const start = Date.now();
    if (transport === 'sse' || transport === 'streamable-http') {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 10000);
        const res = await fetch(server_url, {
          method: transport === 'sse' ? 'GET' : 'POST',
          signal: controller.signal,
          headers: transport === 'streamable-http'
            ? { 'Content-Type': 'application/json', 'Accept': 'application/json' }
            : {},
          body: transport === 'streamable-http'
            ? JSON.stringify({ jsonrpc: '2.0', method: 'initialize', id: 1, params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'mcp-registry-probe', version: '0.1.0' } } })
            : undefined,
        });
        clearTimeout(timeout);
        report.health = {
          reachable: true,
          status_code: res.status,
          latency_ms: Date.now() - start,
          tls: server_url.startsWith('https'),
        };

        // Security flags
        report.security = {
          uses_https: server_url.startsWith('https'),
          cors_header: res.headers.get('access-control-allow-origin') || 'not set',
        };
      } catch (err) {
        report.health = { reachable: false, error: err.message, latency_ms: Date.now() - start };
        report.security = { uses_https: server_url.startsWith('https') };
      }
    } else {
      report.health = { note: 'stdio transport — cannot probe remotely, will verify on first local run' };
      report.security = { note: 'stdio runs locally — no network exposure' };
    }

    // 3. Estimated token cost (heuristic)
    report.estimated_token_cost = {
      per_tool_call: '~200-500 tokens (typical)',
      note: 'Actual cost depends on tool response size. Register the server and health_check to get tool count.',
    };

    // 4. Duplicate risk
    const orgServers = getServersByOrg(org_id);
    report.duplicate_risk = orgServers.length === 0
      ? 'No servers in registry to compare against'
      : 'Register this server with its tool list, then run find_duplicates to check overlap';

    report.recommendation = report.health?.reachable === false
      ? 'DO NOT INSTALL — server is unreachable'
      : report.already_registered
      ? 'ALREADY REGISTERED — check existing entry instead'
      : report.security?.uses_https === false
      ? 'CAUTION — no TLS, data sent in plaintext'
      : 'OK TO INSTALL';

    return {
      content: [{
        type: 'text',
        text: JSON.stringify(report, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// RESOURCES
// ═══════════════════════════════════════════

server.resource(
  'servers',
  'mcp-registry://servers',
  async () => {
    const all = getAllServers();
    const healthy = all.filter(s => s.health_status === 'healthy').length;

    return {
      contents: [{
        uri: 'mcp-registry://servers',
        mimeType: 'application/json',
        text: JSON.stringify({
          total: all.length,
          healthy,
          unhealthy: all.filter(s => s.health_status === 'unhealthy').length,
          unknown: all.filter(s => s.health_status === 'unknown').length,
          servers: all.map(s => ({
            id: s.id,
            name: s.name,
            url: s.url,
            health: s.health_status,
            tools: s.tools?.length || 0,
          })),
          generated_at: new Date().toISOString(),
        }, null, 2),
      }],
    };
  }
);

// ═══════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error('MCP Registry Server running on stdio');
}

main().catch(console.error);
