// Basic integration tests for SQLite-backed storage layer
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { rmSync, existsSync } from 'node:fs';

// Use a temp DB for tests so they never touch the real ~/.mcp-registry-mcp/registry.db
const TEST_DB = join(tmpdir(), `mcp-registry-test-${Date.now()}.db`);

// Import db helpers and override path BEFORE importing storage functions
import { setDbPath, closeDb } from './db.js';
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

before(() => {
  setDbPath(TEST_DB);
});

after(() => {
  closeDb();
  if (existsSync(TEST_DB)) rmSync(TEST_DB);
});

// ─────────────────────────────────────────────
// Test 1: registerServer persists and returns correct record
// ─────────────────────────────────────────────

test('registerServer persists a server and returns a valid record', () => {
  const rec = registerServer({
    name: 'filesystem-mcp',
    url: 'npx:filesystem-mcp',
    transport: 'stdio',
    description: 'File system access',
    org_id: 'test-org',
    tools: ['read_file', 'write_file', 'list_dir'],
  });

  assert.ok(rec.id.startsWith('srv_'), 'id should start with srv_');
  assert.equal(rec.name, 'filesystem-mcp');
  assert.equal(rec.url, 'npx:filesystem-mcp');
  assert.equal(rec.transport, 'stdio');
  assert.equal(rec.org_id, 'test-org');
  assert.deepEqual(rec.tools, ['read_file', 'write_file', 'list_dir']);
  assert.equal(rec.health_status, 'unknown');
  assert.ok(rec.registered_at, 'registered_at should be set');

  // Verify it is retrievable from the DB
  const fetched = getServer(rec.id);
  assert.ok(fetched, 'should be fetchable by ID');
  assert.equal(fetched.name, 'filesystem-mcp');
  assert.deepEqual(fetched.tools, ['read_file', 'write_file', 'list_dir']);
});

// ─────────────────────────────────────────────
// Test 2: recordHealthCheck updates status and health_checks table
// ─────────────────────────────────────────────

test('recordHealthCheck updates server status and stores health history', () => {
  const rec = registerServer({
    name: 'search-mcp',
    url: 'https://search.example.com/mcp',
    transport: 'streamable-http',
    description: 'Web search',
    org_id: 'test-org',
    tools: ['web_search'],
  });

  const result1 = recordHealthCheck(rec.id, {
    healthy: true,
    latency_ms: 42,
    error: null,
    tool_count: 1,
    tools_discovered: ['web_search'],
  });

  assert.equal(result1.healthy, true);
  assert.equal(result1.latency_ms, 42);
  assert.equal(result1.total_checks, 1);
  assert.equal(result1.uptime_percent, 100);

  const result2 = recordHealthCheck(rec.id, {
    healthy: false,
    latency_ms: 5000,
    error: 'Connection timeout',
    tool_count: 0,
    tools_discovered: [],
  });

  assert.equal(result2.healthy, false);
  assert.equal(result2.total_checks, 2);
  assert.equal(result2.uptime_percent, 50);

  // Verify server record is updated
  const srv = getServer(rec.id);
  assert.equal(srv.health_status, 'unhealthy');

  // Verify history
  const history = getHealthHistory(rec.id);
  assert.equal(history.length, 2);
  assert.equal(history[0].healthy, true);
  assert.equal(history[1].healthy, false);
  assert.equal(history[1].error, 'Connection timeout');
});

// ─────────────────────────────────────────────
// Test 3: findDuplicates detects overlapping tool sets
// ─────────────────────────────────────────────

test('findDuplicates detects servers with overlapping tool sets', () => {
  const orgId = 'dup-test-org';

  registerServer({
    name: 'server-alpha',
    url: 'npx:server-alpha',
    transport: 'stdio',
    description: 'Alpha',
    org_id: orgId,
    tools: ['tool_a', 'tool_b', 'tool_c', 'tool_d'],
  });

  registerServer({
    name: 'server-beta',
    url: 'npx:server-beta',
    transport: 'stdio',
    description: 'Beta — nearly identical',
    org_id: orgId,
    tools: ['tool_a', 'tool_b', 'tool_c', 'tool_e'],
  });

  registerServer({
    name: 'server-gamma',
    url: 'npx:server-gamma',
    transport: 'stdio',
    description: 'Gamma — totally different',
    org_id: orgId,
    tools: ['tool_x', 'tool_y', 'tool_z'],
  });

  const pairs = findDuplicates(orgId);

  // alpha vs beta share 3/5 unique tools → jaccard = 3/5 = 0.6 → should be detected
  assert.ok(pairs.length >= 1, 'should detect at least one duplicate pair');
  const pair = pairs[0];
  assert.ok(
    (pair.server_a.name === 'server-alpha' && pair.server_b.name === 'server-beta') ||
    (pair.server_a.name === 'server-beta'  && pair.server_b.name === 'server-alpha'),
    'should match alpha-beta pair',
  );
  assert.ok(pair.jaccard_similarity >= 0.5, 'similarity should be >= 0.5');
  assert.equal(pair.verdict, 'significant_overlap');
});
