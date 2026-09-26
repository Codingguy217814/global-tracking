// Shared pipeline logic used by generate-digest.js
// Ported from the Python tracker_mvp.py — same schema, same reconciliation
// rules, just in JS so it can run as a Netlify Function.

export const FEEDS = {
  "BBC World": "http://feeds.bbci.co.uk/news/world/rss.xml",
  "Al Jazeera": "https://www.aljazeera.com/xml/rss/all.xml",
  "NYT World": "https://rss.nytimes.com/services/xml/rss/nyt/World.xml",
  "DW": "https://rss.dw.com/rdf/rss-en-world",
  "Al Arabiya (ME)": "https://english.alarabiya.net/.mrss/en.xml",
  "Nikkei Asia": "https://asia.nikkei.com/rss/feed/nar",
};

// structural metadata only — not a subjective bias score
export const SOURCE_META = {
  "BBC World": { ownership: "public broadcaster", country: "UK" },
  "Al Jazeera": { ownership: "state-funded", country: "Qatar" },
  "NYT World": { ownership: "private", country: "US" },
  "DW": { ownership: "public broadcaster", country: "Germany" },
  "Al Arabiya (ME)": { ownership: "private", country: "UAE" },
  "Nikkei Asia": { ownership: "private", country: "Japan" },
};

export const EXTRACTION_SCHEMA_PROMPT = (title, text) => `You are a neutral extraction engine for a geopolitical/economic
tracker. Given a single news article, extract ONLY facts stated in the text.
Do not add outside knowledge. Do not editorialize. Attribute any characterization
or opinion in the article to whoever said it (do not state it as fact).

Return strict JSON only, matching this schema exactly, no markdown fences:

{
  "event_type": "diplomatic | military | sanction | election | protest | policy | economic_data | market_reaction | other",
  "region": "Asia | Europe | Africa | Oceania | North America | South America | Middle East | Global",
  "countries_involved": ["..."],
  "actors": ["..."],
  "summary_neutral": "one neutral sentence, no adjectives implying judgment",
  "factual_claims": ["short factual claim 1", "short factual claim 2"],
  "attributed_opinions": [{"speaker": "...", "claim": "..."}],
  "date_of_event": "YYYY-MM-DD or null if unclear",
  "confidence_note": "any explicit uncertainty/hedging language found in the article, or null"
}

Article title: ${title}
Article text: ${text}
`;

// ---- lightweight string similarity (0-100), no external dep needed ----
function tokenSortRatio(a = "", b = "") {
  const norm = (s) => s.toLowerCase().split(/\s+/).filter(Boolean).sort().join(" ");
  const s1 = norm(a), s2 = norm(b);
  if (!s1 && !s2) return 100;
  if (!s1 || !s2) return 0;
  const longer = s1.length > s2.length ? s1 : s2;
  const shorter = s1.length > s2.length ? s2 : s1;
  if (longer.length === 0) return 100;
  const dist = levenshtein(longer, shorter);
  return Math.round(((longer.length - dist) / longer.length) * 100);
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) => [i, ...Array(n).fill(0)]);
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ---- dedupe near-identical headlines (same wire story, many outlets) ----
export function dedupe(articles) {
  const kept = [];
  for (const a of articles) {
    const isDupe = kept.some((k) => tokenSortRatio(a.title, k.title) > 88);
    if (!isDupe) kept.push(a);
  }
  return kept;
}

// ---- cluster events describing the same underlying incident ----
export function clusterEvents(events) {
  const clusters = [];
  for (const ev of events) {
    let placed = false;
    for (const cluster of clusters) {
      const rep = cluster[0];
      const titleSim = tokenSortRatio(ev.title, rep.title);
      const a = new Set(ev.extraction?.countries_involved || []);
      const b = new Set(rep.extraction?.countries_involved || []);
      const overlap = [...a].some((c) => b.has(c));
      if (titleSim > 60 || (overlap && titleSim > 35)) {
        cluster.push(ev);
        placed = true;
        break;
      }
    }
    if (!placed) clusters.push([ev]);
  }
  return clusters;
}

// ---- consensus vs disputed within a cluster ----
export function summarizeCluster(cluster) {
  const allClaims = [];
  for (const ev of cluster) {
    for (const claim of ev.extraction?.factual_claims || []) {
      allClaims.push({ claim, source: ev.source });
    }
  }

  const consensus = [], disputed = [];
  const seen = new Set();
  for (let i = 0; i < allClaims.length; i++) {
    if (seen.has(i)) continue;
    const matches = [allClaims[i]];
    for (let j = 0; j < allClaims.length; j++) {
      if (i !== j && !seen.has(j) && tokenSortRatio(allClaims[i].claim, allClaims[j].claim) > 70) {
        matches.push(allClaims[j]);
        seen.add(j);
      }
    }
    const sources = [...new Set(matches.map((m) => m.source))];
    const entry = { claim: allClaims[i].claim, sources };
    (sources.length >= 2 ? consensus : disputed).push(entry);
  }

  const modelFlagged = cluster
    .filter((ev) => ev.modelAgreement?.checked && !ev.modelAgreement.agree)
    .map((ev) => ({ headline: ev.title, disagreements: ev.modelAgreement.disagreements }));

  const sourcesSet = new Set(cluster.map((e) => e.source));

  return {
    sources_count: sourcesSet.size,
    sources: [...sourcesSet],
    region: cluster[0].extraction?.region ?? null,
    event_type: cluster[0].extraction?.event_type ?? null,
    countries_involved: [...new Set(cluster.flatMap((e) => e.extraction?.countries_involved || []))],
    consensus_facts: consensus,
    disputed_or_unconfirmed_facts: disputed,
    confidence: sourcesSet.size >= 2 ? "high" : "low_single_source",
    sample_headline: cluster[0].title,
    model_disagreements: modelFlagged,
  };
}

// ---- Claude vs Gemini extraction agreement check ----
export function compareExtractions(claudeEx, geminiEx) {
  if (!geminiEx || geminiEx.error) {
    return { checked: false, reason: "gemini_extraction_unavailable" };
  }
  const disagreements = [];

  if (claudeEx.event_type !== geminiEx.event_type) {
    disagreements.push({ field: "event_type", claude: claudeEx.event_type, gemini: geminiEx.event_type });
  }
  if (claudeEx.region !== geminiEx.region) {
    disagreements.push({ field: "region", claude: claudeEx.region, gemini: geminiEx.region });
  }
  const c = new Set(claudeEx.countries_involved || []);
  const g = new Set(geminiEx.countries_involved || []);
  const sameSet = c.size === g.size && [...c].every((x) => g.has(x));
  if (!sameSet) {
    disagreements.push({
      field: "countries_involved",
      claude: [...c].sort(),
      gemini: [...g].sort(),
    });
  }
  const cClaims = (claudeEx.factual_claims || []).length;
  const gClaims = (geminiEx.factual_claims || []).length;
  if (Math.abs(cClaims - gClaims) >= 2) {
    disagreements.push({ field: "factual_claims_count", claude: cClaims, gemini: gClaims });
  }

  return { checked: true, agree: disagreements.length === 0, disagreements };
}

// ---- safe JSON parse for model output that may be wrapped in fences ----
export function parseModelJson(raw) {
  const cleaned = (raw || "").trim().replace(/^```json/i, "").replace(/```$/, "").trim();
  try {
    return JSON.parse(cleaned);
  } catch {
    return { error: "failed_to_parse", raw: cleaned };
  }
}
