import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import {
  registerAppResource,
  registerAppTool,
  RESOURCE_MIME_TYPE,
} from '@modelcontextprotocol/ext-apps/server';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';

const widgetHtml = readFileSync('public/status-widget.html', 'utf8');
const WIDGET_URI = 'ui://widget/status.html';

// Services we can check. All use the same status page format.
const SERVICES = {
  github: { name: 'GitHub', url: 'https://www.githubstatus.com/api/v2/summary.json' },
  cloudflare: { name: 'Cloudflare', url: 'https://www.cloudflarestatus.com/api/v2/summary.json' },
  discord: { name: 'Discord', url: 'https://discordstatus.com/api/v2/summary.json' },
};

// Describes the shape of the data we send back.
const outputSchema = {
  services: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      indicator: z.string(),
      description: z.string(),
      incidents: z.array(
        z.object({ name: z.string(), impact: z.string(), status: z.string() })
      ),
      updatedAt: z.string(),
    })
  ),
};

// Fetch one service. If it fails, return an 'unknown' card instead of crashing.
async function fetchOne(id) {
  const svc = SERVICES[id];
  try {
    const res = await fetch(svc.url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    return {
      id,
      name: svc.name,
      indicator: String(data.status.indicator),
      description: String(data.status.description),
      incidents: (data.incidents ?? []).slice(0, 3).map((i) => ({
        name: String(i.name),
        impact: String(i.impact ?? 'none'),
        status: String(i.status),
      })),
      updatedAt: String(data.page?.updated_at ?? new Date().toISOString()),
    };
  } catch (err) {
    return {
      id,
      name: svc.name,
      indicator: 'unknown',
      description: `Could not load: ${err.message}`,
      incidents: [],
      updatedAt: new Date().toISOString(),
    };
  }
}

function createStatusServer() {
  const server = new McpServer({ name: 'statuspulse', version: '0.1.0' });

  // 1) The widget (the HTML file ChatGPT will show)
  registerAppResource(server, 'status-widget', WIDGET_URI, {}, async () => ({
    contents: [{ 
        uri: WIDGET_URI,
        mimeType: RESOURCE_MIME_TYPE, 
        text: widgetHtml ,
        _meta: { 
            ui: 
            { 
                preferBorder: true,
            } 
        },
    }],
  }));

  // 2) The tool (what ChatGPT can call)
  registerAppTool(
    server,
    'get_status',
    {
      title: 'Get service status',
      description:
        'Shows the live status of popular online services: github, cloudflare, discord. Use this when the user asks if a service is down, slow, or healthy. Pass a list of service ids, or leave empty to check all.',
      inputSchema: { services: z.array(z.string()).optional() },
      outputSchema,
      _meta: { ui: { resourceUri: WIDGET_URI } },
    },
    async ({ services }) => {
      const ids = services?.length
        ? services.filter((id) => id in SERVICES)
        : Object.keys(SERVICES);
      const results = await Promise.all(ids.map(fetchOne));
      const bad = results.filter((r) => r.indicator !== 'none');
      const text = bad.length
        ? `Issues found: ${bad.map((r) => `${r.name} (${r.description})`).join('; ')}`
        : 'All checked services are operational.';
      return {
        content: [{ type: 'text', text }],
        structuredContent: { services: results },
      };
    }
  );

  return server;
}

// ---- Plain HTTP server that speaks MCP at /mcp ----
const port = Number(process.env.PORT ?? 8787);
const MCP_PATH = '/mcp';

const httpServer = createServer(async (req, res) => {
  if (!req.url) {
    res.writeHead(400).end('Missing URL');
    return;
  }
  const url = new URL(req.url, `http://${req.headers.host ?? 'localhost'}`);

  // Browser safety check (CORS) before the real request
  if (req.method === 'OPTIONS' && url.pathname === MCP_PATH) {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, mcp-session-id',
      'Access-Control-Expose-Headers': 'Mcp-Session-Id',
    });
    res.end();
    return;
  }

  // Simple health check
  if (req.method === 'GET' && url.pathname === '/') {
    res.writeHead(200, { 'content-type': 'text/plain' }).end('StatusPulse MCP server');
    return;
  }

  const MCP_METHODS = new Set(['POST', 'GET', 'DELETE']);
  if (url.pathname === MCP_PATH && req.method && MCP_METHODS.has(req.method)) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Expose-Headers', 'Mcp-Session-Id');

    const server = createStatusServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless: no memory between requests
      enableJsonResponse: true,
    });
    res.on('close', () => {
      transport.close();
      server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res);
    } catch (error) {
      console.error('Error handling MCP request:', error);
      if (!res.headersSent) res.writeHead(500).end('Internal server error');
    }
    return;
  }

  res.writeHead(404).end('Not Found');
});

httpServer.listen(port, () => {
  console.log(`StatusPulse MCP server listening on http://localhost:${port}${MCP_PATH}`);
});