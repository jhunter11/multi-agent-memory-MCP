import assert from 'node:assert/strict';
import test from 'node:test';

import {
  DATABASE_ENV_VAR,
  EXPORT_DIR_ENV_VAR,
  ORIGIN_ENV_VAR,
  PACKAGE_NAME,
  SERVER_NAME
} from '../src/public-identity.js';

test('uses only public neutral identifiers', () => {
  assert.equal(PACKAGE_NAME, 'multi-agent-memory-mcp');
  assert.equal(SERVER_NAME, 'multi-agent-memory-mcp-server');
  assert.equal(DATABASE_ENV_VAR, 'MULTI_AGENT_MEMORY_DB');
  assert.equal(EXPORT_DIR_ENV_VAR, 'MULTI_AGENT_MEMORY_EXPORT_DIR');
  assert.equal(ORIGIN_ENV_VAR, 'MULTI_AGENT_MEMORY_ORIGIN');
});
