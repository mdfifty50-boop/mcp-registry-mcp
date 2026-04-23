// SQLite-backed storage for MCP server registry
// All public function signatures are identical to the original in-memory implementation.

import { getDb } from './db.js';

let idCounter = 0;

function genId() {
  return `srv_${Date.now().toString(36)}_${(++idCounter).toString(36)}`;
}

// ── helpers ──

function rowToServer(row) {
  if (!row) return null;
  return {
    id: row.server_id,
    name: row.name,
    url: row.url,
    transport: row.transport,
    description: row.description,
    org_id: row.org_id,
    version: row.version,
    tools: JSON.parse(row.tags_json || '[]'),
    registered_at: row.registered_at,
    last_health_check: row.last_check || null,
    health_status: row.status,
    ...JSON.parse(row.health_json || '{}'),
  };
}

// ── Registration ──

export function registerServer({ name, url, transport, description, org_id, tools }) {
  const db = getDb();
  const id = genId();
  const now = new Date().toISOString();

  const health_json = JSON.stringify({ total_checks: 0, successful_checks: 0 });
  const tags_json = JSON.stringify(tools || []);

  db.prepare(`
    INSERT INTO servers
      (server_id, name, url, transport, description, org_id, version, status,
       last_check, health_json, registered_at, tags_json)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    name,
    url,
    transport || 'stdio',
    description || '',
    org_id || 'default',
    '',
    'unknown',
    null,
    health_json,
    now,
    tags_json,
  );

  return {
    id,
    name,
    url,
    transport: transport || 'stdio',
    description: description || '',
    org_id: org_id || 'default',
    tools: tools || [],
    registered_at: now,
    last_health_check: null,
    health_status: 'unknown',
    total_checks: 0,
    successful_checks: 0,
  };
}

// ── Health checks ──

export function recordHealthCheck(serverId, result) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM servers WHERE server_id = ?').get(serverId);
  if (!row) return null;

  const now = new Date().toISOString();
  const health = JSON.parse(row.health_json || '{}');

  health.total_checks = (health.total_checks || 0) + 1;
  if (result.healthy) health.successful_checks = (health.successful_checks || 0) + 1;

  const status = result.healthy ? 'healthy' : 'unhealthy';

  // Merge discovered tools
  let tags_json = row.tags_json;
  if (result.tools_discovered?.length) {
    tags_json = JSON.stringify(result.tools_discovered);
  }

  db.prepare(`
    UPDATE servers
    SET status = ?, last_check = ?, health_json = ?, tags_json = ?
    WHERE server_id = ?
  `).run(status, now, JSON.stringify(health), tags_json, serverId);

  // Insert health_checks row
  db.prepare(`
    INSERT INTO health_checks (server_id, status, latency_ms, checked_at, error)
    VALUES (?, ?, ?, ?, ?)
  `).run(
    serverId,
    status,
    result.latency_ms ?? null,
    now,
    result.error || null,
  );

  // Keep only last 100 health check rows per server
  db.prepare(`
    DELETE FROM health_checks
    WHERE server_id = ?
      AND id NOT IN (
        SELECT id FROM health_checks
        WHERE server_id = ?
        ORDER BY id DESC
        LIMIT 100
      )
  `).run(serverId, serverId);

  const entry = {
    timestamp: now,
    healthy: result.healthy,
    latency_ms: result.latency_ms,
    error: result.error || null,
    tool_count: result.tool_count ?? null,
    tools_discovered: result.tools_discovered || [],
  };

  return {
    server_id: serverId,
    ...entry,
    uptime_percent: health.total_checks > 0
      ? Math.round((health.successful_checks / health.total_checks) * 10000) / 100
      : 0,
    total_checks: health.total_checks,
  };
}

export function getHealthHistory(serverId) {
  const db = getDb();
  const rows = db.prepare(`
    SELECT status, latency_ms, checked_at, error
    FROM health_checks
    WHERE server_id = ?
    ORDER BY id ASC
  `).all(serverId);

  return rows.map(r => ({
    timestamp: r.checked_at,
    healthy: r.status === 'healthy',
    latency_ms: r.latency_ms,
    error: r.error || null,
  }));
}

// ── Queries ──

export function getServer(serverId) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM servers WHERE server_id = ?').get(serverId);
  return rowToServer(row);
}

export function getServerByUrl(url) {
  const db = getDb();
  const row = db.prepare('SELECT * FROM servers WHERE url = ? LIMIT 1').get(url);
  return rowToServer(row);
}

export function getServersByOrg(orgId) {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM servers WHERE org_id = ?').all(orgId || 'default');
  return rows.map(rowToServer);
}

export function getAllServers() {
  const db = getDb();
  const rows = db.prepare('SELECT * FROM servers').all();
  return rows.map(rowToServer);
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

        // Persist detected duplicate pair
        try {
          const db = getDb();
          db.prepare(`
            INSERT INTO duplicates (server_a, server_b, similarity_score, detected_at)
            VALUES (?, ?, ?, ?)
          `).run(a.id, b.id, similarity, new Date().toISOString());
        } catch (_) { /* ignore duplicate insert errors */ }

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
  const db = getDb();
  const selected = serverIds
    .map(id => db.prepare('SELECT * FROM servers WHERE server_id = ?').get(id))
    .filter(Boolean)
    .map(rowToServer);

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

    const a = getServer(pair.server_a.id);
    const b = getServer(pair.server_b.id);
    if (!a || !b) continue;

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
