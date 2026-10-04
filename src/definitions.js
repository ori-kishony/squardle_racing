import { db } from "./db.js";

const UA = { "User-Agent": "squardle-racing (friends-group, puzzle definitions)" };
const inFlight = new Set();
const getCached = db.prepare("SELECT definition FROM word_definitions WHERE word = ?");
const saveCached = db.prepare(`
  INSERT INTO word_definitions (word, definition, updated_at) VALUES (?, ?, ?)
  ON CONFLICT(word) DO UPDATE SET definition=excluded.definition, updated_at=excluded.updated_at
`);

export function cachedDefinition(word) {
  return getCached.get(String(word).toUpperCase())?.definition || null;
}

async function fetchDefinition(word) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 5000);
  try {
    const slug = encodeURIComponent(word.toLowerCase());
    const urls = [
      `https://api.dictionaryapi.dev/api/v2/entries/en/${slug}`,
      `https://en.wiktionary.org/api/rest_v1/page/definition/${slug}`,
    ];
    const candidates = urls.map(async (url, index) => {
      const res = await fetch(url, { headers: UA, signal: controller.signal });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const json = await res.json();
      const definition = index === 0
        ? json?.[0]?.meanings?.[0]?.definitions?.[0]?.definition
        : json?.en?.[0]?.definitions?.[0]?.definition;
      if (!definition) throw new Error("No definition");
      return String(definition).replace(/<[^>]+>/g, "").trim();
    });
    const definition = await Promise.any(candidates);
    saveCached.run(word, definition, Date.now());
  } catch {
    // Missing entries and provider outages are retried on the next puzzle refresh.
  } finally {
    clearTimeout(timeout);
  }
}

// Warm a small number at a time so puzzle ingestion stays fast and providers
// are not flooded with a burst of requests. Each word is persisted as it lands.
export async function prefetchDefinitions(words) {
  const pending = [...new Set(words.map((word) => String(word).toUpperCase()))]
    .filter((word) => /^[A-Z]{3,9}$/.test(word) && !cachedDefinition(word) && !inFlight.has(word));
  pending.forEach((word) => inFlight.add(word));
  let next = 0;
  const workers = Array.from({ length: Math.min(3, pending.length) }, async () => {
    while (next < pending.length) {
      const word = pending[next++];
      try { await fetchDefinition(word); }
      finally { inFlight.delete(word); }
    }
  });
  await Promise.all(workers);
}
