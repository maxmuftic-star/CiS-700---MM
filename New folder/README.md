# Conference Deadlines MCP Server

An MCP (Model Context Protocol) server that exposes academic AI/CS conference
submission deadlines as tools an LLM client can call.

Data source: the [`huggingface/ai-deadlines`](https://huggingface.co/spaces/huggingface/ai-deadlines)
dataset (the actively-maintained continuation of the original aideadlin.es /
paperswithcode/ai-deadlines project — NeurIPS, ICML, ICLR, CVPR, ACL, AAAI,
and dozens more). Data is fetched live from the source and cached in memory
for 6 hours.

## Tools

| Tool | Description |
|---|---|
| `list_conferences` | List conferences, optionally filtered by tag and/or upcoming-only. |
| `get_conference` | Look up one conference by `id` (e.g. `neurips25`) or `title`/`year`. |
| `search_conferences` | Free-text search over title, full name, and tags. |
| `upcoming_deadlines` | Deadlines within the next N days, soonest first. |
| `refresh_data` | Force-refresh the cached data from the source. |

## Run locally

```bash
npm install
npm start
```

The server listens on `PORT` (default `3000`) and exposes:
- `POST /mcp` — the MCP Streamable HTTP endpoint
- `GET /health` — health check (also shows cache status)

This server runs in **stateless mode**: every request gets a fresh server +
transport, so it scales horizontally with no session affinity required.

## Connect a client

Point any MCP client that supports Streamable HTTP at:

```
https://<your-render-service>.onrender.com/mcp
```

For Claude, that means adding it as a custom connector using this URL.

## Deploy to Render

This repo needs no Dockerfile — Render's Node runtime works directly:

- **Build command:** `npm install`
- **Start command:** `npm start`
- Render sets `PORT` automatically; the server reads it via `process.env.PORT`.

## Notes

- The upstream dataset is split into one YAML file per conference
  (`src/data/conferences/*.yml` in the `huggingface/ai-deadlines` Space). This
  server lists that directory via the Hugging Face API and fetches each file,
  so new conferences added upstream show up automatically after the cache
  refreshes (or via the `refresh_data` tool).
- Deadlines are parsed as best-effort UTC; the upstream `timezone` field is
  passed through raw in case you need to display it, but `deadline_utc` and
  `days_until_deadline` are computed assuming the timestamp is already in the
  stated zone treated as UTC — good enough for "is this coming up soon"
  purposes, not for down-to-the-minute precision.
