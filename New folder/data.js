import yaml from "js-yaml";

// Source: huggingface/ai-deadlines is the actively-maintained continuation of the
// original aideadlin.es project (paperswithcode/ai-deadlines). Each conference has
// its own YAML file under src/data/conferences/, containing one or more yearly
// entries (title, year, deadline, timezone, place, tags, etc).
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
    const res = await fetch(url, { ...opts, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(t);
  }
}

/**
 * List all conference YAML file paths, following pagination via the Link header.
 */
async function listConferenceFiles() {
  const paths = [];
  let url = API_TREE_BASE;
  while (url) {
    const res = await fetchWithTimeout(url, {
      headers: { Accept: "application/json" },
    });
    if (!res.ok) {
      throw new Error(`Failed to list conference files (${res.status} ${res.statusText})`);
    }
    const entries = await res.json();
    for (const entry of entries) {
      if (entry.type === "file" && entry.path.endsWith(".yml")) {
        paths.push(entry.path);
      }
    }
    const link = res.headers.get("link");
    url = parseNextLink(link);
  }
  return paths;
}

function parseNextLink(linkHeader) {
  if (!linkHeader) return null;
  // Format: <https://...>; rel="next", <https://...>; rel="prev"
  const parts = linkHeader.split(",");
  for (const part of parts) {
    const match = part.match(/<([^>]+)>;\s*rel="next"/);
    if (match) return match[1];
  }
  return null;
}

async function fetchConferenceFile(path) {
  const filename = path.split("/").pop();
  const res = await fetchWithTimeout(RAW_BASE + filename);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${filename} (${res.status} ${res.statusText})`);
  }
  const text = await res.text();
  const parsed = yaml.load(text);
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

/** Best-effort parse of a deadline string (with optional timezone) into a UTC Date. */
export function parseDeadline(entry) {
  if (!entry.deadline) return null;
  const raw = String(entry.deadline).trim();
  // Most deadlines look like "2025-05-16 23:59:59" or "2025-05-16 23:59".
  const isoish = raw.includes("T") ? raw : raw.replace(" ", "T");
  const withZ = /[zZ]|[+-]\d{2}:?\d{2}$/.test(isoish) ? isoish : `${isoish}Z`;
  const d = new Date(withZ);
  return Number.isNaN(d.getTime()) ? null : d;
}

async function loadAll({ forceRefresh = false } = {}) {
  const now = Date.now();
  if (!forceRefresh && cache.data && now - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.data;
  }
  if (inFlight) return inFlight;

  inFlight = (async () => {
    try {
      const paths = await listConferenceFiles();
      const results = [];
      const errors = [];
      // Fetch with light concurrency to be a good citizen of the source.
      const CONCURRENCY = 8;
      for (let i = 0; i < paths.length; i += CONCURRENCY) {
        const batch = paths.slice(i, i + CONCURRENCY);
        const settled = await Promise.allSettled(batch.map(fetchConferenceFile));
        settled.forEach((s, idx) => {
          if (s.status === "fulfilled") {
            results.push(...s.value.map(normalizeEntry));
          } else {
            errors.push(`${batch[idx]}: ${s.reason?.message ?? s.reason}`);
          }
        });
      }
      cache = { data: results, fetchedAt: Date.now(), error: errors.length ? errors : null };
      return results;
    } catch (err) {
      // If we have stale cached data, prefer returning it over throwing.
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

export async function getAllConferences(opts) {
  return loadAll(opts);
}

export function getCacheInfo() {
  return {
    entries: cache.data ? cache.data.length : 0,
    fetchedAt: cache.fetchedAt ? new Date(cache.fetchedAt).toISOString() : null,
    errors: cache.error,
  };
}
