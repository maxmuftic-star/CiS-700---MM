import express from "express";
import yaml from "js-yaml";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { z } from "zod";

// ---------------------------------------------------------------------------
// Data: fetch + cache conference deadline data from huggingface/ai-deadlines
// ---------------------------------------------------------------------------

const REPO = "huggingface/ai-deadlines";
const DATA_PATH = "src/data/conferences";
const API_TREE_BASE = `https://huggingface.co/api/spaces/${REPO}/tree/main/${DATA_PATH}`;
const RAW_BASE = `https://huggingface.co/spaces/${REPO}/resolve/main/${DATA_PATH}/`;

const CACHE_TTL_MS = 6 * 60 * 60 * 1000; // 6 hours
const FETCH_TIMEOUT_MS = 15_000;

let cache = { data: null, fetchedAt: 0, error: null };
let inFlight = null;

async function fetchWithTimeout(url, opts = {}) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    return await fetch(url, { ...opts, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  for (const part of linkHeader.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function listConferenceFiles() {
  const paths = [];
  let url = API_TREE_BASE;
  while (url) {
    const res = await fetchWithTimeout(url, { headers: { Accept: "application/json" } });
    if (!res.ok) throw new Error(`Failed to list conference files (${res.status} ${res.statusText})`);
    const entries = await res.json();
    for (const entry of entries) {
      if (entry.type === "file" && entry.path.endsWith(".yml")) paths.push(entry.path);
    }
    url = parseNextLink(res.headers.get("link"));
  }
  return paths;
}

async function fetchConferenceFile(path) {
  const filename = path.split("/").pop();
  const res = await fetchWithTimeout(RAW_BASE + filename);
  if (!res.ok) throw new Error(`Failed to fetch ${filename} (${res.status} ${res.statusText})`);
  const parsed = yaml.load(await res.text());
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.entries)) return parsed.entries;
  if (parsed) return [parsed];
  return [];
}

function normalizeEntry(entry) {
  return {
    id: entry.id ?? null,
    title: entry.title ?? entry.name ?? null,
    full_name: entry.full_name ?? entry.description ?? null,
    year: entry.year ?? null,
    link: entry.link ?? null,
    deadline: entry.deadline ?? null,
    abstract_deadline: entry.abstract_deadline ?? null,
    timezone: entry.timezone ?? null,
    date: entry.date ?? null,
    start: entry.start ?? null,
    end: entry.end ?? null,
    city: entry.city ?? null,
    country: entry.country ?? null,
    place: entry.place ?? ([entry.city, entry.country].filter(Boolean).join(", ") || null),
    venue: entry.venue ?? null,
    tags: entry.tags ?? [],
    note: entry.note ?? null,
    rankings: entry.rankings ?? null,
  };
}

function parseDeadline(entry) {
  if (!entry.deadline) return null;
  const raw = String(entry.deadline).trim();
  const isoish = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(isoish) ? isoish : `${isoish}Z`;
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function loadAll({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.data && now - cache.fetchedAt < CACHE_TTL_MS) return cache.data;
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const paths = await listConferenceFiles();
      const results = [];
      const errors = [];
      const CONCURRENCY = 8;
      for (let i = 0; i < paths.length; i += CONCURRENCY) {
        const batch = paths.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(batch.map(fetchConferenceFile));
        settled.forEach((s, idx) => {
          if (s.status === "fulfilled") results.push(...s.value.map(normalizeEntry));
          else errors.push(`${batch[idx]}: ${s.reason?.message ?? s.reason}`);
        });
      }
      cache = { data: results, fetchedAt: Date.now(), error: errors.length ? errors : null };
      return results;
    } catch (err) {
      if (cache.data) {
        cache = { ...cache, error: [String(err.message ?? err)] };
        return cache.data;
      }
      throw err;
    } finally {
      inFlight = null;
    }
  })();

  return inFlight;
}

function getCacheInfo() {
  return {
    entries: cache.data ? cache.data.length : 0,
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    errors: cache.error,
  };
}

// ---------------------------------------------------------------------------
// MCP server: tools exposed to clients
// ---------------------------------------------------------------------------

function toResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function toErrorResult(err) {
  return { content: [{ type: "text", text: `Error: ${err.message ?? String(err)}` }], isError: true };
}

function withDaysUntil(entry) {
  const d = parseDeadline(entry);
  const daysUntil = d ? Math.ceil((d.getTime() - Date.now()) / 86_400_000) : null;
  return { ...entry, deadline_utc: d ? d.toISOString() : null, days_until_deadline: daysUntil };
}

function buildServer() {
  const server = new McpServer({ name: "conference-deadlines", version: "1.0.0" });

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
        const all = await loadAll();
        let filtered = all;
        if (tag) {
          const needle = tag.toLowerCase();
          filtered = filtered.filter((e) => (e.tags || []).some((t) => t.toLowerCase().includes(needle)));
        }
        let enriched = filtered.map(withDaysUntil);
        if (upcomingOnly) enriched = enriched.filter((e) => e.days_until_deadline === null || e.days_until_deadline >= 0);
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
      description: "Look up a specific conference by id (e.g. 'neurips25') or by title/year (e.g. title='NeurIPS', year=2025).",
      inputSchema: {
        id: z.string().optional().describe("Exact conference-year id, e.g. 'neurips25'."),
        title: z.string().optional().describe("Conference short title, e.g. 'NeurIPS' (case-insensitive)."),
        year: z.number().int().optional().describe("Year, used together with title if id is not given."),
      },
    },
    async ({ id, title, year }) => {
      try {
        const all = await loadAll();
        let matches = all;
        if (id) matches = matches.filter((e) => e.id?.toLowerCase() === id.toLowerCase());
        else if (title) {
          matches = matches.filter((e) => e.title?.toLowerCase() === title.toLowerCase());
          if (year) matches = matches.filter((e) => e.year === year);
        } else {
          return toErrorResult(new Error("Provide either 'id', or 'title' (optionally with 'year')."));
        }
        if (matches.length === 0) return toResult({ found: false, message: "No matching conference found." });
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
      description: "Free-text search over conference title, full name, and tags. Useful when you don't know the exact id.",
      inputSchema: {
        query: z.string().min(1).describe("Search text, e.g. 'vision' or 'robotics'."),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ query, limit }) => {
      try {
        const all = await loadAll();
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
      description: "Get conferences with submission deadlines in the next N days, soonest first. Good for a 'what's due soon' view.",
      inputSchema: {
        days: z.number().int().positive().max(3650).optional().describe("Look-ahead window in days (default 60)."),
        tag: z.string().optional().describe("Optional tag filter, e.g. 'machine-learning'."),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async ({ days, tag, limit }) => {
      try {
        const window = days ?? 60;
        const all = await loadAll();
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
        const all = await loadAll({ forceRefresh: true });
        return toResult({ refreshed: true, entries: all.length, cache: getCacheInfo() });
      } catch (err) {
        return toErrorResult(err);
      }
    }
  );

  return server;
}

// ---------------------------------------------------------------------------
// HTTP server
// ---------------------------------------------------------------------------

const app = express();
app.use(express.json());

app.get("/health", (_req, res) => res.json({ status: "ok", cache: getCacheInfo() }));

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
      res.status(500).json({ jsonrpc: "2.0", error: { code: -32603, message: "Internal server error" }, id: null });
    }
  }
});

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
});
