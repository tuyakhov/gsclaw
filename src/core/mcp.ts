import { McpServer } from '@modelcontextprotocol/server';
import type { ActivityLog } from './activity.js';
import { publicErrorMessage } from './errors.js';
import { capText } from './format.js';
import type { Logger } from './log.js';
import { seoHealthCheckArgs, seoHealthCheckPrompt } from './prompts.js';
import type { AnyTool, ToolContext } from './tools/types.js';
import { NAME, VERSION } from './version.js';

export const SERVER_INSTRUCTIONS = `GSClaw gives you read access to Google Search Console (and sitemap writes only if the operator enabled them).
- Start with list_sites to find the exact property; site_url also accepts a bare domain like "example.com".
- Prefer the analysis tools (compare_periods, striking_distance_keywords, ctr_opportunities, keyword_cannibalization, content_decay, page_report) over raw search_analytics for common questions.
- Dates are Pacific Time. Final data lags ~2–3 days; relative ranges end on the latest final day. Pass fresh=true for partial recent data.
- Results show the top rows only and say how many were omitted; raise limit if you need more.
- Search Console keeps ~16 months of data, and rare queries are anonymized.`;

export interface McpServerDeps {
  tools: AnyTool[];
  ctx: ToolContext;
  logger: Logger;
  client: string;
  activity?: ActivityLog;
}

/** Builds a fresh MCP server instance (one per HTTP request or stdio connection). */
export function buildMcpServer(deps: McpServerDeps): McpServer {
  const server = new McpServer(
    { name: NAME, title: 'GSClaw', version: VERSION },
    { instructions: SERVER_INSTRUCTIONS },
  );

  for (const tool of deps.tools) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.input,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args) => {
        const started = Date.now();
        const site =
          typeof args.site_url === 'string'
            ? args.site_url
            : typeof args.url === 'string'
              ? args.url
              : null;
        try {
          const result = await tool.run(deps.ctx, args);
          const text = capText(tool.format(result, args));
          deps.activity?.record({
            time: new Date().toISOString(),
            client: deps.client,
            tool: tool.name,
            site,
            ms: Date.now() - started,
            ok: true,
          });
          return {
            content: [{ type: 'text', text }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (error) {
          const { message, kind } = publicErrorMessage(error);
          if (kind === 'internal') deps.logger.error('tool failed', { tool: tool.name, error });
          else deps.logger.info('tool returned error', { tool: tool.name, kind });
          deps.activity?.record({
            time: new Date().toISOString(),
            client: deps.client,
            tool: tool.name,
            site,
            ms: Date.now() - started,
            ok: false,
            error_kind: kind,
          });
          return { content: [{ type: 'text', text: message }], isError: true };
        }
      },
    );
  }

  server.registerPrompt(
    'seo_health_check',
    {
      title: 'SEO health check',
      description:
        'Full review of a Search Console property: trends, quick wins, CTR fixes, cannibalization, decaying content, sitemaps and indexing, ending in a prioritized action plan.',
      argsSchema: seoHealthCheckArgs,
    },
    (args) => ({
      messages: [{ role: 'user', content: { type: 'text', text: seoHealthCheckPrompt(args) } }],
    }),
  );

  return server;
}
