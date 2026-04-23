import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { registerServer, recordHealthCheck, getAllServers, findDuplicates, exportConfig, recommendConsolidation } from '../storage.js';

describe('mcp-registry-mcp', () => {
  let serverId;

  it('registers a server', () => {
    const result = registerServer({ name: 'test-mcp', url: 'stdio://test', transport: 'stdio', description: 'Test server', org_id: 'throne', tools: ['read', 'write'] });
    assert.ok(result.id);
    assert.equal(result.name, 'test-mcp');
    serverId = result.id;
  });

  it('records a health check', () => {
    const result = recordHealthCheck(serverId, { healthy: true, latency_ms: 42, tool_count: 2 });
    assert.ok(result);
  });

  it('gets all servers', () => {
    const servers = getAllServers();
    assert.ok(Array.isArray(servers));
    assert.ok(servers.length >= 1);
  });

  it('finds duplicates', () => {
    registerServer({ name: 'test-mcp', url: 'stdio://test2', transport: 'stdio', description: 'Duplicate', org_id: 'throne', tools: ['read'] });
    const dupes = findDuplicates();
    assert.ok(dupes);
  });

  it('exports config for registered servers', () => {
    const servers = getAllServers();
    const ids = servers.map(s => s.id);
    const config = exportConfig(ids, 'claude_desktop');
    assert.ok(config);
  });

  it('recommends consolidation', () => {
    const recs = recommendConsolidation();
    assert.ok(recs);
  });
});
