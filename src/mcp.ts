#!/usr/bin/env node
// Stillfield MCP server over stdio (newline delimited JSON-RPC 2.0). One tool: screen_media.
// Written without the SDK to keep the package free of runtime dependencies; tested against the official SDK client.
import { createInterface } from 'node:readline';
import { VERSION } from './core/analyzer.ts';
import { formatText } from './core/format.ts';
import type { AreaRule, Report } from './core/types.ts';
import { screen } from './node/screen.ts';
import { parseDisplay } from './node/sources.ts';

const PROTOCOLS = ['2025-06-18', '2025-03-26', '2024-11-05'];

/** Longest page recording an agent may ask for (each second at 30 fps is 30 screenshots). */
const MAX_DURATION = 120;
const AREAS = ['wcag', 'understanding', 'frame'];

const TOOL = {
  name: 'screen_media',
  title: 'Screen media for seizure risk flashing',
  description:
    'Screens a video file, GIF, folder of PNG frames, local HTML file or http(s) URL for flashing over the WCAG 2.2 ' +
    'SC 2.3.1 general flash and red flash thresholds (more than 3 flashes in any second over more than 25% of a ' +
    '10 degree field). Returns a pass, warn or fail verdict with reasons and the worst time windows. This is a ' +
    'screen, not a certification and not medical advice. Use it to check animations, videos and pages you create.',
  inputSchema: {
    type: 'object',
    properties: {
      path_or_url: { type: 'string', description: 'Absolute or relative file path, folder of .png frames, or http(s) URL' },
      area: { type: 'string', enum: ['wcag', 'understanding', 'frame'], description: 'Area rule (default wcag: 25% of any 341 x 256 CSS px field)' },
      display: { type: 'string', description: 'Size shown at, CSS px, like 1280x720; or native, fullscreen, auto (default)' },
      duration: { type: 'number', exclusiveMinimum: 0, maximum: MAX_DURATION, description: `Seconds to record a web page (default 10, at most ${MAX_DURATION})` },
      fps: { type: 'number', exclusiveMinimum: 0, maximum: 120, description: 'Frame rate for web pages and PNG folders (default 30)' },
    },
    required: ['path_or_url'],
    additionalProperties: false,
  },
  annotations: { readOnlyHint: true, openWorldHint: true },
};

type Json = Record<string, unknown>;

function send(msg: Json): void {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function summary(r: Report): Json {
  const { timeline: _t, ...rest } = r;
  return rest as unknown as Json;
}

async function callTool(params: Json): Promise<Json> {
  if (params.name !== TOOL.name) throw Object.assign(new Error(`Unknown tool: ${String(params.name)}`), { code: -32602 });
  const args = (params.arguments ?? {}) as Json;
  const target = args.path_or_url;
  if (typeof target !== 'string' || !target) {
    return { isError: true, content: [{ type: 'text', text: 'path_or_url is required' }] };
  }
  const bad = (text: string) => ({ isError: true, content: [{ type: 'text', text }] });
  if (args.area !== undefined && !AREAS.includes(String(args.area))) return bad(`area must be one of ${AREAS.join(', ')}`);
  if (args.duration !== undefined && !(typeof args.duration === 'number' && args.duration > 0 && args.duration <= MAX_DURATION)) {
    return bad(`duration must be a number of seconds above 0 and at most ${MAX_DURATION}`);
  }
  if (args.fps !== undefined && !(typeof args.fps === 'number' && args.fps > 0 && args.fps <= 120)) return bad('fps must be a number above 0 and at most 120');
  try {
    const report = await screen(target, {
      areaRule: (args.area as AreaRule | undefined) ?? 'wcag',
      display: parseDisplay(typeof args.display === 'string' ? args.display : undefined),
      duration: typeof args.duration === 'number' ? args.duration : undefined,
      fps: typeof args.fps === 'number' ? args.fps : undefined,
      timeline: false,
    });
    return {
      content: [{ type: 'text', text: formatText(report) }],
      structuredContent: summary(report),
      isError: false,
    };
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Could not screen ${target}: ${e instanceof Error ? e.message : String(e)}` }] };
  }
}

async function handle(msg: Json): Promise<void> {
  const id = msg.id as string | number | undefined;
  const method = msg.method as string | undefined;
  const isRequest = id !== undefined && id !== null;
  if (!method) return; // a response to something we never sent
  try {
    let result: Json;
    switch (method) {
      case 'initialize': {
        const asked = (msg.params as Json | undefined)?.protocolVersion as string | undefined;
        result = {
          protocolVersion: asked && PROTOCOLS.includes(asked) ? asked : PROTOCOLS[0],
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'stillfield', title: 'Stillfield', version: VERSION },
          instructions: 'Call screen_media on any video, GIF or page you generate that animates. It screens; it does not certify.',
        };
        break;
      }
      case 'ping':
        result = {};
        break;
      case 'tools/list':
        result = { tools: [TOOL] };
        break;
      case 'tools/call':
        result = await callTool((msg.params ?? {}) as Json);
        break;
      default:
        if (!isRequest) return; // unknown notification (notifications/initialized, cancelled, ...)
        throw Object.assign(new Error(`Method not found: ${method}`), { code: -32601 });
    }
    if (isRequest) send({ jsonrpc: '2.0', id, result });
  } catch (e) {
    const err = e as Error & { code?: number };
    if (isRequest) send({ jsonrpc: '2.0', id, error: { code: err.code ?? -32603, message: err.message } });
  }
}

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
const pending = new Set<Promise<void>>();
rl.on('line', (line) => {
  if (!line.trim()) return;
  let msg: Json;
  try {
    msg = JSON.parse(line);
  } catch {
    send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return;
  }
  const p = handle(msg).finally(() => pending.delete(p));
  pending.add(p);
});
rl.on('close', async () => {
  await Promise.all(pending);
  process.exit(0);
});
