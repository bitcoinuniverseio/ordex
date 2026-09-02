import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  MCP_TOOLS,
  MCP_PROTOCOL_VERSION,
  executeMcpTool,
  handleMcpProtocolRequest
} from '../../site/src/lib/mcp/server.js';

test('mcp server: exports all 10 authoritative read-only tools', () => {
  assert.equal(MCP_TOOLS.length, 10);
  const toolNames = MCP_TOOLS.map(t => t.name);

  const expectedTools = [
    'ordex.search_docs',
    'ordex.read_source',
    'ordex.list_capabilities',
    'ordex.get_openapi_operation',
    'ordex.get_asyncapi_channel',
    'ordex.run_verifier',
    'ordex.explain_refusal',
    'ordex.get_conformance_vector',
    'ordex.create_deterministic_example',
    'ordex.get_mission'
  ];

  for (const exp of expectedTools) {
    assert.ok(toolNames.includes(exp), `Expected tool ${exp} must be in MCP registry`);
  }
});

test('mcp server: enforces protocol version header validation', () => {
  const badVersion = handleMcpProtocolRequest('tools/list', {}, { 'mcp-protocol-version': '1999-01-01' });
  assert.ok(badVersion.error);
  assert.equal(badVersion.error.code, -32602);

  const goodVersion = handleMcpProtocolRequest('tools/list', {}, { 'mcp-protocol-version': MCP_PROTOCOL_VERSION });
  assert.ok(!goodVersion.error);
  assert.ok(goodVersion.result);
});

test('mcp server: executes ordex.explain_refusal with deterministic diagnostic rule', async () => {
  const result = await executeMcpTool('ordex.explain_refusal', { code: 'ACCOUNT_INVALID' });
  assert.equal(result.protocolVersion, '1.2');
  assert.equal(result.evidenceClass, 'Protocol verification');
  assert.ok(result.structuredContent);
  assert.ok(result.structuredContent.rule);
});

test('mcp server: executes ordex.get_mission with typed mission stage roadmap', async () => {
  const result = await executeMcpTool('ordex.get_mission', { missionId: 'integrate-public-asks' });
  assert.equal(result.protocolVersion, '1.2');
  assert.ok(result.structuredContent.mission);
  assert.equal(result.structuredContent.mission.stages.length, 8);
});
