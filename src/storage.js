// In-memory storage for MCP server registry

/** @type {Map<string, object>} server_id -> server record */
const servers = new Map();

/** @type {Map<string, object[]>} server_id -> health check history */
const healthHistory = new Map();

let idCounter = 0;

function genId() {
  return `srv_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

// ── Registration ──

export function registerServer({ name, url, transport, description, org_id, tools }) {
  const id = genId();
  const record = {
    id,
    name,
    url,
    transport: transport || 'stdio',
    description: description || '',
    org_id: org_id || 'default',
    tools: tools || [],
    registered_at: new Date().toISOString(),
    last_health_check: null,
    health_status: 'unknown',
    total_checks: 0,
    successful_checks: 0,
  };
  servers.set(id, record);
  return record;
}

// ── Health checks ──

export function recordHealthCheck(serverId, result) {
  const srv = servers.get(serverId);
  if (!srv) return null;

  const entry = {
    timestamp: new Date().toISOString(),
    healthy: result.healthy,
    latency_ms: result.latency_ms,
    error: result.error || null,
    tool_count: result.tool_count ?? null,
    tools_discovered: result.tools_discovered || [],
  };

  if (!healthHistory.has(serverId)) healthHistory.set(serverId, []);
  const history = healthHistory.get(serverId);
  history.push(entry);
  if (history.length > 100) history.splice(0, history.length - 100);

  srv.last_health_check = entry.timestamp;
  srv.total_checks++;
  if (result.healthy) srv.successful_checks++;
  srv.health_status = result.healthy ? 'healthy' : 'unhealthy';

  // Merge discovered tools into server record
  if (result.tools_discovered?.length) {
    srv.tools = result.tools_discovered;
  }

  return {
    server_id: serverId,
    ...entry,
    uptime_percent: srv.total_checks > 0
      ? Math.round((srv.successful_checks / srv.total_checks) * 10000) / 100
      : 0,
    total_checks: srv.total_checks,
  };
}

export function getHealthHistory(serverId) {
  return healthHistory.get(serverId) || [];
}

// ── Queries ──

export function getServer(serverId) {
  return servers.get(serverId) || null;
}

export function getServerByUrl(url) {
  for (const srv of servers.values()) {
    if (srv.url === url) return srv;
  }
  return null;
}

export function getServersByOrg(orgId) {
  const result = [];
  for (const srv of servers.values()) {
    if (srv.org_id === (orgId || 'default')) result.push(srv);
  }
  return result;
}

export function getAllServers() {
  return [...servers.values()];
}

// ── Duplicate detection ──

function jaccard(setA, setB) {
  if (setA.size === 0 && setB.size === 0) return 0;
  const intersection = new Set([...setA].filter(x => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return intersection.size / union.size;
}

export function findDuplicates(orgId) {
  const orgServers = getServersByOrg(orgId);
  const pairs = [];

  for (let i = 0; i < orgServers.length; i++) {
    for (let j = i + 1; j < orgServers.length; j++) {
      const a = orgServers[i];
      const b = orgServers[j];
      const toolsA = new Set(a.tools.map(t => typeof t === 'string' ? t : t.name));
      const toolsB = new Set(b.tools.map(t => typeof t === 'string' ? t : t.name));

      if (toolsA.size === 0 || toolsB.size === 0) continue;

      const similarity = jaccard(toolsA, toolsB);
      if (similarity > 0.3) {
        const overlap = [...toolsA].filter(t => toolsB.has(t));
        pairs.push({
          server_a: { id: a.id, name: a.name },
          server_b: { id: b.id, name: b.name },
          jaccard_similarity: Math.round(similarity * 1000) / 1000,
          overlapping_tools: overlap,
          verdict: similarity >= 0.8 ? 'likely_duplicate'
            : similarity >= 0.5 ? 'significant_overlap'
            : 'minor_overlap',
        });
      }
    }
  }

  return pairs.sort((a, b) => b.jaccard_similarity - a.jaccard_similarity);
}

// ── Config export ──

export function exportConfig(serverIds, targetClient) {
  const selected = serverIds.map(id => servers.get(id)).filter(Boolean);

  if (targetClient === 'claude_desktop' || targetClient === 'claude') {
    const mcpServers = {};
    for (const s of selected) {
      const key = s.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      if (s.transport === 'stdio') {
        mcpServers[key] = { command: 'npx', args: [s.name] };
      } else {
        mcpServers[key] = { url: s.url };
      }
    }
    return { format: 'claude_desktop', config: { mcpServers } };
  }

  if (targetClient === 'cursor') {
    const mcpServers = {};
    for (const s of selected) {
      const key = s.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      mcpServers[key] = {
        command: s.transport === 'stdio' ? 'npx' : undefined,
        args: s.transport === 'stdio' ? [s.name] : undefined,
        url: s.transport !== 'stdio' ? s.url : undefined,
      };
    }
    return { format: 'cursor', config: { mcpServers } };
  }

  if (targetClient === 'vscode') {
    const inputs = [];
    const mcpServers = {};
    for (const s of selected) {
      const key = s.name.replace(/[^a-z0-9-]/gi, '-').toLowerCase();
      if (s.transport === 'stdio') {
        mcpServers[key] = { command: 'npx', args: [s.name] };
      } else {
        mcpServers[key] = { type: 'sse', url: s.url };
      }
    }
    return { format: 'vscode', config: { 'mcp.servers': mcpServers } };
  }

  // Generic fallback
  return {
    format: 'generic',
    config: selected.map(s => ({
      name: s.name,
      url: s.url,
      transport: s.transport,
    })),
  };
}

// ── Consolidation recommendations ──

export function recommendConsolidation(orgId) {
  const dupes = findDuplicates(orgId);
  const orgServers = getServersByOrg(orgId);

  const recommendations = [];

  for (const pair of dupes) {
    if (pair.jaccard_similarity < 0.5) continue;

    const a = servers.get(pair.server_a.id);
    const b = servers.get(pair.server_b.id);
    if (!a || !b) continue;

    // Prefer the healthier / more established server
    const aScore = (a.successful_checks / Math.max(a.total_checks, 1));
    const bScore = (b.successful_checks / Math.max(b.total_checks, 1));
    const keep = aScore >= bScore ? a : b;
    const retire = aScore >= bScore ? b : a;

    recommendations.push({
      action: pair.verdict === 'likely_duplicate' ? 'merge' : 'review',
      keep: { id: keep.id, name: keep.name, uptime: Math.round(aScore >= bScore ? aScore * 100 : bScore * 100) + '%' },
      retire: { id: retire.id, name: retire.name, uptime: Math.round(aScore >= bScore ? bScore * 100 : aScore * 100) + '%' },
      overlapping_tools: pair.overlapping_tools,
      similarity: pair.jaccard_similarity,
      reason: pair.verdict === 'likely_duplicate'
        ? `${Math.round(pair.jaccard_similarity * 100)}% tool overlap — these servers are functionally identical`
        : `${Math.round(pair.jaccard_similarity * 100)}% tool overlap — review whether both are needed`,
    });
  }

  return {
    org_id: orgId || 'default',
    total_servers: orgServers.length,
    recommendations,
    potential_savings: recommendations.filter(r => r.action === 'merge').length + ' servers can be retired',
  };
}
