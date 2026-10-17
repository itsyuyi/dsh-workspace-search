/**
 * Host half of @itsyuyi/dsh-workspace-search.
 *
 * Serves one same-origin search endpoint that answers keyword queries over the
 * workspace's session corpus:
 *
 *   1. When the deployment enables the opt-in full-text index, the ranked
 *      `ctx.sessionQuery.searchSessions()` path answers the query.
 *   2. Otherwise (the default: `session-query-sqlite` with `openAt: never`,
 *      whose search calls fail with SESSION_QUERY_SEARCH_DISABLED) the search
 *      falls back to backend-independent exact reads: `listSessions()` plus
 *      `filterEvents(sessionId, [{ kind: 'text' }])`, which scan the first-party
 *      semantic event documents of each recent session.
 *
 * Both paths return the same shape, so the Client half needs no mode switch.
 * Titles come from `readTitleSnapshots()`; the Client list snapshot remains the
 * authority for live row state.
 */
const ROUTE = '/plugins/dsh-workspace-search/search';
const MAX_BODY_BYTES = 16 * 1024;
const MAX_QUERY_LENGTH = 200;
const LIMIT = 20;
const SCAN_SESSION_LIMIT = 500;
const SCAN_BUDGET_MS = 8000;
const SNIPPET_RADIUS = 70;

export const inject = ['webServer'];

export function apply(ctx) {
  // Optional lookup: the route registers even where the query service is
  // absent, and then answers with a precise reason instead of disappearing.
  const sessionQuery = ctx.get('sessionQuery');
  ctx.effect(
    () =>
      ctx.webServer.register({
        kind: 'exact',
        path: ROUTE,
        handler: (req, res) => serveSearch(sessionQuery, req, res),
      }),
    'workspace-search: search route',
  );
}

/* ------------------------------------------------------------------ */
/* HTTP plumbing (same shape the shipped plugin routes use)            */
/* ------------------------------------------------------------------ */

async function serveSearch(sessionQuery, req, res) {
  if (req.method !== 'POST') return jsonError(res, 405, 'method-not-allowed');
  if (!String(req.headers['content-type'] ?? '').toLowerCase().startsWith('application/json'))
    return jsonError(res, 415, 'json-required');
  if (!sameOrigin(req)) return jsonError(res, 403, 'origin-rejected');
  if (sessionQuery === undefined) return jsonError(res, 503, 'search-unavailable');

  let body;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return jsonError(res, 400, 'invalid-request');
  }
  const query = typeof body?.query === 'string' ? body.query.trim() : '';
  if (query === '' || query.length > MAX_QUERY_LENGTH) return jsonError(res, 400, 'invalid-query');

  // Stop scanning when the browser supersedes the request (debounced typing).
  const controller = new AbortController();
  const abort = () => controller.abort();
  req.on('close', abort);
  req.on('aborted', abort);

  try {
    const result = await searchSessions(sessionQuery, query, controller.signal);
    if (!res.writableEnded) {
      res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(result));
    }
  } catch (error) {
    if (!res.writableEnded) {
      jsonError(res, 500, 'search-failed', error instanceof Error ? error.message : String(error));
    }
  }
}

function sameOrigin(req) {
  const origin = req.headers.origin;
  const host = req.headers.host;
  if (origin !== undefined && host !== undefined && origin !== `http://${host}` && origin !== `https://${host}`)
    return false;
  return true;
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > MAX_BODY_BYTES) throw new Error('request too large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function jsonError(res, status, code, message) {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(message === undefined ? { ok: false, error: code } : { ok: false, error: code, message }));
}

/* ------------------------------------------------------------------ */
/* Search                                                              */
/* ------------------------------------------------------------------ */

async function searchSessions(sessionQuery, query, signal) {
  const indexed = await searchIndex(sessionQuery, query, signal);
  if (indexed !== null) return { ok: true, backend: 'index', items: indexed };
  return { ok: true, backend: 'scan', ...(await searchCorpus(sessionQuery, query, signal)) };
}

/**
 * Ranked full-text path. Returns null when this deployment keeps content search
 * disabled, so the caller falls back to the corpus scan.
 */
async function searchIndex(sessionQuery, query, signal) {
  try {
    const page = await sessionQuery.searchSessions({ query, limit: LIMIT }, signal ? { signal } : undefined);
    const hits = Array.isArray(page?.items) ? page.items : [];
    const titles = await readTitles(sessionQuery, hits.map((hit) => hit.header?.id).filter(Boolean));
    return hits.map((hit) => {
      const sessionId = hit.header?.id;
      return {
        sessionId,
        title: titles.get(sessionId) ?? '',
        cwd: hit.header?.cwd ?? '',
        snippet: snippetAround(String(hit.bestMatch?.snippet ?? ''), query),
        seq: hit.bestMatch?.seq ?? null,
        eventType: hit.bestMatch?.type ?? null,
      };
    }).filter((item) => typeof item.sessionId === 'string' && item.sessionId !== '');
  } catch (error) {
    // Any failure here — most commonly SESSION_QUERY_SEARCH_DISABLED where the
    // deployment keeps the index off — falls back to the corpus scan.
    return null;
  }
}

/**
 * Backend-independent scan: newest-first sessions, each probed with a literal
 * text filter. Covers every semantic document — the user's questions
 * (`user/message`), the assistant's replies (`assistant/message`), and tool
 * traffic. Bounded by a session count and a wall-clock budget, and cancellable
 * through the caller's signal when the browser supersedes the query.
 */
async function searchCorpus(sessionQuery, query, signal) {
  const records = await sessionQuery.listSessions(signal);
  const candidates = records
    .filter((record) => record?.header?.origin !== 'subagent')
    .slice(0, SCAN_SESSION_LIMIT);
  const deadline = Date.now() + SCAN_BUDGET_MS;
  const matches = [];
  let scanned = 0;
  let exhausted = candidates.length === 0;
  for (const record of candidates) {
    if (signal?.aborted) break;
    if (matches.length >= LIMIT || Date.now() > deadline) break;
    const sessionId = record.header.id;
    scanned += 1;
    if (scanned === candidates.length) exhausted = true;
    let documents;
    try {
      documents = await sessionQuery.filterEvents(sessionId, [{ kind: 'text', text: query }]);
    } catch {
      continue;
    }
    if (!Array.isArray(documents) || documents.length === 0) continue;
    const document = documents[0];
    matches.push({
      sessionId,
      cwd: record.header.cwd ?? '',
      snippet: snippetAround(String(document.text ?? ''), query),
      seq: document.seq ?? null,
      eventType: document.type ?? null,
      title: '',
    });
  }
  const titles = await readTitles(sessionQuery, matches.map((match) => match.sessionId));
  for (const match of matches) match.title = titles.get(match.sessionId) ?? '';
  return { items: matches, scanned, truncated: !exhausted };
}

/** Fold durable titles for the hit sessions; failures stay per-session. */
async function readTitles(sessionQuery, sessionIds) {
  const titles = new Map();
  const unique = [...new Set(sessionIds.filter((id) => typeof id === 'string' && id !== ''))];
  if (unique.length === 0) return titles;
  try {
    const results = await sessionQuery.readTitleSnapshots(unique);
    for (const result of Array.isArray(results) ? results : []) {
      if (result?.status !== 'fulfilled') continue;
      const title = result.value?.title?.title;
      if (typeof title === 'string' && title !== '') titles.set(result.sessionId, title);
    }
  } catch {
    /* titles are presentation only — the Client falls back to its own snapshot */
  }
  return titles;
}

/** One context window around the first match, whitespace-collapsed. */
function snippetAround(text, query) {
  const collapsed = text.replace(/\s+/g, ' ').trim();
  if (collapsed === '') return '';
  const index = collapsed.toLowerCase().indexOf(query.toLowerCase());
  if (index < 0) return collapsed.slice(0, SNIPPET_RADIUS * 2);
  const start = Math.max(0, index - SNIPPET_RADIUS);
  const end = Math.min(collapsed.length, index + query.length + SNIPPET_RADIUS);
  return `${start > 0 ? '…' : ''}${collapsed.slice(start, end)}${end < collapsed.length ? '…' : ''}`;
}
