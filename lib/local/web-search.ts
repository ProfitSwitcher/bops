/**
 * Local web search used by the Responses adapter when public internet is allowed.
 * No API key. Tries DuckDuckGo HTML, then the instant API and Wikipedia OpenSearch.
 */
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15";

export type WebSearchHit = { title: string; url: string; snippet?: string };

const WEATHER = /\b(weather|forecast|temperature)\b/i;

/** "what's the weather in Missoula" -> "Missoula". Null when it isn't a weather question. */
export function weatherPlace(query: string): string | null {
  const q = query.trim();
  if (!WEATHER.test(q)) return null;
  const named =
    q.match(/\b(?:weather|forecast|temperature)\s+(?:in|for|at|near)\s+([A-Za-z][^?]{1,60}?)(?:\s+(?:today|tomorrow|tonight|now|please))?\s*$/i) ??
    q.match(/\b(?:in|for|at|near)\s+([A-Za-z][^?]{1,60}?)\b(?:\s+\S+){0,4}\s+(?:weather|forecast|temperature)\b/i);
  const place = named?.[1]?.replace(/[?.!,]+$/g, "").trim();
  return place || null;
}

/** A live reading from wttr.in. Null when the site doesn't answer. No API key. */
export async function weatherNow(place: string, fetchImpl: typeof fetch = fetch): Promise<string | null> {
  const url = `https://wttr.in/${encodeURIComponent(place)}?format=j1`;
  let raw = "";
  try {
    raw = await getText(url, fetchImpl, { headers: { accept: "application/json" } });
  } catch {
    return null;
  }
  let data: { current_condition?: { temp_F?: string; temp_C?: string; humidity?: string; windspeedMiles?: string; weatherDesc?: { value?: string }[] }[]; nearest_area?: { areaName?: { value?: string }[]; region?: { value?: string }[]; country?: { value?: string }[] }[] };
  try {
    data = JSON.parse(raw);
  } catch {
    return null;
  }
  const cur = data.current_condition?.[0];
  if (!cur?.temp_F && !cur?.temp_C) return null;
  const area = data.nearest_area?.[0];
  const where = [area?.areaName?.[0]?.value, area?.region?.[0]?.value, area?.country?.[0]?.value].filter(Boolean).join(", ") || place;
  const desc = cur.weatherDesc?.[0]?.value || "current conditions";
  return `Live weather for ${where}: ${cur.temp_F ?? "?"}°F (${cur.temp_C ?? "?"}°C), ${desc}, humidity ${cur.humidity ?? "?"}%, wind ${cur.windspeedMiles ?? "?"} mph. Source: ${url}`;
}

export async function webSearch(query: string, fetchImpl: typeof fetch = fetch): Promise<string> {
  const q = query.trim();
  if (!q) return "No search query was given.";
  const place = weatherPlace(q);
  const live = place ? await weatherNow(place, fetchImpl) : null;
  const hits: WebSearchHit[] = [];
  const errors: string[] = [];
  try {
    hits.push(...(await duckDuckGoHtml(q, fetchImpl)));
  } catch (e) {
    errors.push(`DuckDuckGo HTML: ${(e as Error).message}`);
  }
  if (hits.length < 3) {
    try {
      hits.push(...(await duckDuckGoInstant(q, fetchImpl)));
    } catch (e) {
      errors.push(`DuckDuckGo instant: ${(e as Error).message}`);
    }
  }
  if (hits.length < 3) {
    try {
      hits.push(...(await wikipediaOpenSearch(q, fetchImpl)));
    } catch (e) {
      errors.push(`Wikipedia: ${(e as Error).message}`);
    }
  }
  const unique = dedupe(hits).slice(0, 8);
  if (!unique.length) {
    if (live) return live;
    const why = errors.length ? ` (${errors.join("; ")})` : "";
    return `No web search results for ${JSON.stringify(q)}.${why}`;
  }
  const list = unique
    .map((h, i) => {
      const snippet = h.snippet ? `\n   ${h.snippet}` : "";
      return `${i + 1}. ${h.title}\n   ${h.url}${snippet}`;
    })
    .join("\n");
  return [live, list].filter(Boolean).join("\n\n");
}

function dedupe(hits: WebSearchHit[]): WebSearchHit[] {
  const seen = new Set<string>();
  const out: WebSearchHit[] = [];
  for (const h of hits) {
    const key = normalizeUrl(h.url);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function normalizeUrl(raw: string): string {
  try {
    const u = new URL(raw);
    u.hash = "";
    return u.href;
  } catch {
    return "";
  }
}

async function getText(url: string, fetchImpl: typeof fetch, init?: RequestInit): Promise<string> {
  const res = await fetchImpl(url, {
    ...init,
    headers: { "user-agent": UA, accept: "text/html,application/json;q=0.9,*/*;q=0.8", ...(init?.headers ?? {}) },
    redirect: "follow",
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
}

async function duckDuckGoHtml(query: string, fetchImpl: typeof fetch): Promise<WebSearchHit[]> {
  const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
  const html = await getText(url, fetchImpl);
  const hits: WebSearchHit[] = [];
  const re = /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(html))) {
    const href = decodeDuckHref(decodeHtml(m[1]));
    const title = stripTags(decodeHtml(m[2])).trim();
    if (!href || !title) continue;
    const after = html.slice(m.index, m.index + 1200);
    const snip = /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/(?:a|td|div)>/i.exec(after);
    hits.push({ title, url: href, snippet: snip ? collapse(stripTags(decodeHtml(snip[1]))) : undefined });
  }
  if (hits.length) return hits;
  // lite.duckduckgo.com fallback markup
  const lite = await getText(`https://lite.duckduckgo.com/lite/?q=${encodeURIComponent(query)}`, fetchImpl);
  const liteRe = /<a[^>]*rel="nofollow"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  while ((m = liteRe.exec(lite))) {
    const href = decodeDuckHref(decodeHtml(m[1]));
    const title = stripTags(decodeHtml(m[2])).trim();
    if (!href || !title || href.includes("duckduckgo.com")) continue;
    hits.push({ title, url: href });
  }
  return hits;
}

async function duckDuckGoInstant(query: string, fetchImpl: typeof fetch): Promise<WebSearchHit[]> {
  const url = `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&no_redirect=1&skip_disambig=1`;
  const raw = await getText(url, fetchImpl, { headers: { accept: "application/json" } });
  const data = JSON.parse(raw) as {
    AbstractURL?: string;
    AbstractText?: string;
    Heading?: string;
    OfficialWebsite?: string;
    Results?: { FirstURL?: string; Text?: string }[];
    RelatedTopics?: ( { FirstURL?: string; Text?: string } | { Topics?: { FirstURL?: string; Text?: string }[] } )[];
  };
  const hits: WebSearchHit[] = [];
  if (data.AbstractURL) {
    hits.push({ title: data.Heading || data.AbstractURL, url: data.AbstractURL, snippet: data.AbstractText });
  }
  for (const r of data.Results ?? []) if (r.FirstURL && r.Text) hits.push({ title: r.Text, url: r.FirstURL });
  for (const t of data.RelatedTopics ?? []) {
    const list = "Topics" in t && t.Topics ? t.Topics : [t as { FirstURL?: string; Text?: string }];
    for (const item of list) if (item.FirstURL && item.Text) hits.push({ title: item.Text, url: item.FirstURL });
  }
  return hits;
}

async function wikipediaOpenSearch(query: string, fetchImpl: typeof fetch): Promise<WebSearchHit[]> {
  const url = `https://en.wikipedia.org/w/api.php?action=opensearch&limit=5&namespace=0&format=json&search=${encodeURIComponent(query)}`;
  const raw = await getText(url, fetchImpl, { headers: { accept: "application/json" } });
  const parsed = JSON.parse(raw) as unknown;
  if (!Array.isArray(parsed) || parsed.length < 4) return [];
  const titles = parsed[1] as unknown[];
  const snippets = parsed[2] as unknown[];
  const links = parsed[3] as unknown[];
  const hits: WebSearchHit[] = [];
  for (let i = 0; i < titles.length; i++) {
    const title = String(titles[i] ?? "").trim();
    const href = String(links[i] ?? "").trim();
    if (!title || !href) continue;
    hits.push({ title, url: href, snippet: String(snippets[i] ?? "").trim() || undefined });
  }
  return hits;
}

function decodeDuckHref(href: string): string {
  const raw = href.startsWith("//") ? `https:${href}` : href;
  try {
    const u = new URL(raw, "https://html.duckduckgo.com/");
    const uddg = u.searchParams.get("uddg");
    if (uddg) return uddg;
    if (u.hostname.endsWith("duckduckgo.com") && (u.pathname === "/l/" || u.pathname === "/l")) {
      return u.searchParams.get("uddg") || "";
    }
    if (u.protocol === "http:" || u.protocol === "https:") return u.href;
  } catch {
    return "";
  }
  return "";
}

function decodeHtml(s: string): string {
  return s
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, " ")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function stripTags(s: string): string {
  return s.replace(/<[^>]+>/g, " ");
}

function collapse(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}
