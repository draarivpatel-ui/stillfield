// The MCP server, driven by the official MCP TypeScript SDK client over stdio.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writeClip } from './helpers.ts';

test('screen_media over MCP stdio with the SDK client', async () => {
  const fail = await writeClip('fail-full-4hz', '.mp4');
  const pass = await writeClip('pass-full-2hz', '.mp4');
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [join(import.meta.dirname, '..', 'src', 'mcp.ts')],
    stderr: 'pipe',
  });
  const client = new Client({ name: 'stillfield-test', version: '1.0.0' });
  await client.connect(transport);
  try {
    assert.equal(client.getServerVersion()?.name, 'stillfield');
    const tools = await client.listTools();
    assert.deepEqual(tools.tools.map((t) => t.name), ['screen_media']);
    const r1 = await client.callTool({ name: 'screen_media', arguments: { path_or_url: fail } });
    const s1 = r1.structuredContent as { verdict: string; wcag231: string; timeline?: unknown };
    assert.equal(s1.verdict, 'fail');
    assert.equal(s1.timeline, undefined);
    assert.match((r1.content as { text: string }[])[0].text, /FAIL/);
    const r2 = await client.callTool({ name: 'screen_media', arguments: { path_or_url: pass, area: 'frame' } });
    assert.equal((r2.structuredContent as { verdict: string }).verdict, 'pass');
    const r3 = await client.callTool({ name: 'screen_media', arguments: { path_or_url: '/no/such/file.mp4' } });
    assert.equal(r3.isError, true);
    // a typo in the area rule is refused, not screened under a label it did not use
    const r4 = await client.callTool({ name: 'screen_media', arguments: { path_or_url: pass, area: 'wcga' } });
    assert.equal(r4.isError, true);
    assert.match((r4.content as { text: string }[])[0].text, /area must be/);
    // page recordings are capped
    const r5 = await client.callTool({ name: 'screen_media', arguments: { path_or_url: 'https://example.invalid/', duration: 3600 } });
    assert.equal(r5.isError, true);
    assert.match((r5.content as { text: string }[])[0].text, /at most 120/);
    assert.equal((s1 as { complete?: boolean }).complete, true);
  } finally {
    await client.close();
  }
});
