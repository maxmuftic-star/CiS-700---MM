import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";
import { getAllConferences, parseDeadline, getCacheInfo } from "./data.js";

function toResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function toErrorResult(err) {
  return {
    content: [{ type: "text", text: `Error: ${err.message ?? String(err)}` }],
    isError: true,
  };
}

function withDaysUntil(entry) {
  const d = parseDeadline(entry);
  const daysUntil = d ? Math.ceil((d.getTime() - Date.now()) / 86_400_000) : null;
  return { ...entry, deadline_utc: d ? d.toISOString() : null, days_until_deadline: daysUntil };
}

function buildServer() {
  const server = new McpServer({
    name: "conference-deadlines",
    version: "1.0.0",
  });

  server.registerTool(
    "list_conferences",
    {
      title: "List conferences",
      description:
        "List academic AI/CS conferences and their submission deadlines. Optionally filter by tag (e.g. 'machine-learning', 'computer-vision', 'natural-language-processing') and/or restrict to conferences whose deadline hasn't passed yet.",
      inputSchema: {
        tag: z.string().optional().describe("Filter to entries whose tags include this value (case-insensitive substring match)."),
        upcomingOnly: z.boolean().optional().describe("If true, only include entries with a future (or missing) deadline."),
        limit: z.number().int().positive().max(500).optional().describe("Max number of entries to return (default 100)."),
      },
    },
    async ({ tag, upcomingOnly, limit }) => {
      try {
        const all = await getAllConferences();
        let filtered = all;
        if (tag) {
          const needle = tag.toLowerCase();
          filtered = filtered.filter((e) => (e.tags || []).some((t) => t.toLowerCase().includes(needle)));
        }
        let enriched = filtered.map(withDaysUntil);
        if (upcomingOnly) {
          enriched = enriched.filter((e) => e.days_until_deadline === null || e.days_until_deadline >= 0);
        }
        enriched.sort((a, b) => {
          if (a.days_until_deadline === null) return 1;
          if (b.days_until_deadline === null) return -1;
          return a.days_until_deadline - b.days_until_deadline;
        });
        return toResult(enriched.slice(0, limit ?? 100));
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    "get_conference",
    {
      title: "Get a specific conference",
      description:
        "Look up a specific conference by id (e.g. 'neurips25') or by title/year (e.g. title='NeurIPS', year=2025).",
      inputSchema: {
        id: z.string().optional().describe("Exact conference-year id, e.g. 'neurips25'."),
        title: z.string().optional().describe("Conference short title, e.g. 'NeurIPS' (case-insensitive)."),
        year: z.number().int().optional().describe("Year, used together with title if id is not given."),
      },
    },
    async ({ id, title, year }) => {
      try {
        const all = await getAllConferences();
        let matches = all;
        if (id) {
          matches = matches.filter((e) => e.id?.toLowerCase() === id.toLowerCase());
        } else if (title) {
          matches = matches.filter((e) => e.title?.toLowerCase() === title.toLowerCase());
          if (year) matches = matches.filter((e) => e.year === year);
        } else {
          return toErrorResult(new Error("Provide either 'id', or 'title' (optionally with 'year')."));
        }
        if (matches.length === 0) {
          return toResult({ found: false, message: "No matching conference found." });
        }
        return toResult(matches.map(withDaysUntil));
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    "search_conferences",
    {
      title: "Search conferences",
      description:
        "Free-text search over conference title, full name, and tags. Useful when you don't know the exact id.",
      inputSchema: {
        query: z.string().min(1).describe("Search text, e.g. 'vision' or 'robotics'."),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ query, limit }) => {
      try {
        const all = await getAllConferences();
        const needle = query.toLowerCase();
        const matches = all.filter((e) => {
          const haystack = [e.title, e.full_name, ...(e.tags || [])].filter(Boolean).join(" ").toLowerCase();
          return haystack.includes(needle);
        });
        const enriched = matches.map(withDaysUntil).sort((a, b) => {
          if (a.days_until_deadline === null) return 1;
          if (b.days_until_deadline === null) return -1;
          return a.days_until_deadline - b.days_until_deadline;
        });
        return toResult(enriched.slice(0, limit ?? 50));
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    "upcoming_deadlines",
    {
      title: "Upcoming deadlines",
      description:
        "Get conferences with submission deadlines in the next N days, soonest first. Good for a 'what's due soon' view.",
      inputSchema: {
        days: z.number().int().positive().max(3650).optional().describe("Look-ahead window in days (default 60)."),
        tag: z.string().optional().describe("Optional tag filter, e.g. 'machine-learning'."),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ days, tag, limit }) => {
      try {
        const window = days ?? 60;
        const all = await getAllConferences();
        let filtered = all;
        if (tag) {
          const needle = tag.toLowerCase();
          filtered = filtered.filter((e) => (e.tags || []).some((t) => t.toLowerCase().includes(needle)));
        }
        const enriched = filtered
          .map(withDaysUntil)
          .filter((e) => e.days_until_deadline !== null && e.days_until_deadline >= 0 && e.days_until_deadline <= window)
          .sort((a, b) => a.days_until_deadline - b.days_until_deadline);
        return toResult(enriched.slice(0, limit ?? 100));
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  server.registerTool(
    "refresh_data",
    {
      title: "Refresh conference data",
      description: "Force a re-fetch of conference deadline data from the source, bypassing the cache.",
      inputSchema: {},
    },
    async () => {
      try {
        const all = await getAllConferences({ forceRefresh: true });
        return toResult({ refreshed: true, entries: all.length, cache: getCacheInfo() });
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  return server;
}

const app = express();
app.use(express.json());

app.get("/health", async (_req, res) => {
  res.json({ status: "ok", cache: getCacheInfo() });
});

// Stateless mode: build a fresh server + transport per request. Simple and
// horizontally scalable — no session/session-id bookkeeping needed.
app.post("/mcp", async (req, res) => {
  try {
    const server = buildServer();
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
    res.on("close", () => {
      transport.close();
      server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    console.error("Error handling MCP request:", err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: "2.0",
        error: { code: -32603, message: "Internal server error" },
        id: null,
      });
    }
  }
});

// GET/DELETE aren't used in stateless mode, but the spec expects a response.
app.get("/mcp", (_req, res) => {
  res.status(405).json({
    jsonrpc: "2.0",
    error: { code: -32000, message: "Method not allowed (this server is stateless; use POST /mcp)." },
    id: null,
  });
});
app.delete("/mcp", (_req, res) => res.status(405).end());

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Conference deadlines MCP server listening on port ${PORT}`);
  console.log(`  Health check: GET /health`);
  console.log(`  MCP endpoint: POST /mcp`);
});
