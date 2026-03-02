/*
 * MCP server skeleton for Plastic SCM access (Phase 2).
 * Excluded from main build via tsconfig.json.
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { listChangesets as listChangesetsCli } from '../services/plasticCli';

const server = new Server({ name: 'plastic-scm', version: '0.1.0' }, { capabilities: { tools: {} } });

const tools: Tool[] = [
  {
    name: 'plastic_history',
    description: 'Query Plastic SCM history via CLI',
    inputSchema: {
      type: 'object',
      properties: {
        itemsPerPage: { type: 'number', default: 50 },
        order: { type: 'string', enum: ['newest-first', 'oldest-first'], default: 'newest-first' }
      }
    }
  }
];

server.setRequestHandler('tools/list', async () => ({ tools }));

server.setRequestHandler('tools/call', async (req) => {
  switch (req.params.name) {
    case 'plastic_history': {
      const itemsPerPage = (req.params.arguments?.itemsPerPage as number) ?? 50;
      const order = (req.params.arguments?.order as 'newest-first' | 'oldest-first') ?? 'newest-first';
      const data = await listChangesetsCli({ itemsPerPage, order });
      return { content: [{ type: 'text', text: JSON.stringify(data) }] };
    }
  }
  return { content: [{ type: 'text', text: 'Unknown tool' }] };
});

const transport = new StdioServerTransport();
server.connect(transport);


