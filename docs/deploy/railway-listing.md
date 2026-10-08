# Railway marketplace listing (maintainers)

Copy for the Railway template's marketplace fields. See [railway.md](railway.md) for service settings.

## Name

GSClaw

## Description (25–75 characters)

Google Search Console MCP server for Claude, ChatGPT and AI agents

## Category

AI/ML (second choice: Analytics)

## Icon

`assets/logo-512.png` (512×512, transparent background). Vector: `assets/logo.svg`.

## Variable descriptions

| Variable                      | Description                                                                                                                                                     |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `GOOGLE_SERVICE_ACCOUNT_JSON` | Required. Your Google service-account key JSON (paste the whole file, raw or base64). Add the key's client_email as a user on each Search Console property.     |
| `GSCLAW_ACCESS_TOKEN`         | Auto-generated secret your AI client must send (Authorization: Bearer <token>, or the URL /mcp/<token>). Copy it from this service's Variables after deploying. |
| `PORT`                        | Port the server listens on. Keep 3000; it must match the service's HTTP proxy port.                                                                             |

## Overview

````markdown
# Deploy and Host GSClaw on Railway

GSClaw is an open-source MCP (Model Context Protocol) server that gives AI assistants such as Claude, ChatGPT, Cursor and VS Code first-party access to your Google Search Console data. Beyond raw queries it ships ready-made SEO analyses: striking-distance keywords, CTR gaps, keyword cannibalization, content decay and period comparisons.

## About Hosting GSClaw

GSClaw runs as a single stateless Node.js service built from the repository's Dockerfile, with no database to manage. It signs in to Google with a service account: create one in Google Cloud, enable the Search Console API, download a JSON key, and add the service account's email as a user on each Search Console property. Paste the key into GOOGLE_SERVICE_ACCOUNT_JSON; the template generates GSCLAW_ACCESS_TOKEN for you. After deploying, your MCP endpoint is https://<your-domain>/mcp. Clients send the token as a bearer header, or use https://<your-domain>/mcp/<token> in clients that cannot set headers, such as claude.ai custom connectors. A /healthz endpoint backs Railway's health checks.

## Common Use Cases

- Ask your AI assistant for striking-distance keywords and quick SEO wins on any property
- Investigate traffic drops with period-over-period and year-over-year comparisons by query and page
- Check index status, canonicals and sitemap health with the URL Inspection and Sitemaps APIs
- Find pages competing for the same query, or pages that are steadily losing clicks

## Dependencies for GSClaw Hosting

- A Google Cloud project with the Google Search Console API enabled
- A Google service-account key (JSON) added as a user on your Search Console properties
- An MCP client that supports remote servers (Claude, ChatGPT, Cursor, VS Code, Claude Code)

### Deployment Dependencies

- GSClaw source and documentation: https://github.com/tuyakhov/gsclaw
- Enable the Search Console API: https://console.cloud.google.com/apis/library/searchconsole.googleapis.com
- Create a service-account key: https://cloud.google.com/iam/docs/keys-create-delete
- Add users to a Search Console property: https://support.google.com/webmasters/answer/7687615

### Implementation Details

Connect Claude Code to your deployment:

```bash
claude mcp add --transport http gsclaw https://<your-domain>/mcp --header "Authorization: Bearer <GSCLAW_ACCESS_TOKEN>"
```

## Why Deploy GSClaw on Railway?

Railway is a singular platform to deploy your infrastructure stack. Railway will host your infrastructure so you don't have to deal with configuration, while allowing you to vertically and horizontally scale it.

By deploying GSClaw on Railway, you are one step closer to supporting a complete full-stack application with minimal burden. Host your servers, databases, AI agents, and more on Railway.
````
