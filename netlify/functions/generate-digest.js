// Netlify Scheduled Function — runs automatically once a day (see `config`
// below) and on every deploy trigger. Fetches feeds, extracts structured
// events with Claude (and Gemini, if configured, as a cross-check), clusters
// them, reconciles consensus vs disputed claims, and stores the result in
// Netlify Blobs so the frontend can read it without re-running the pipeline
// on every page load.
//
// Manual test trigger (after deploy):
//   curl "https://YOUR-SITE.netlify.app/.netlify/functions/generate-digest?key=YOUR_ADMIN_KEY"
//
// Required environment variables (set in Netlify → Site settings → Environment variables):
//   ANTHROPIC_API_KEY   (required)
//   GEMINI_API_KEY      (optional — enables the dual-model cross-check)
//   ADMIN_TRIGGER_KEY   (optional — set this to allow manual runs via the URL above;
//                        without it, manual HTTP triggers are rejected and only the
//                        schedule can run the function)

import Anthropic from "@anthropic-ai/sdk";
import Parser from "rss-parser";
import { getStore } from "@netlify/blobs";
import {
  FEEDS,
  EXTRACTION_SCHEMA_PROMPT,
  dedupe,
  clusterEvents,
  summarizeCluster,
  compareExtractions,
  parseModelJson,
} from "./lib/pipeline.js";

const rssParser = new Parser();

async function fetchAllFeeds() {
  const articles = [];
  for (const [sourceName, url] of Object.entries(FEEDS)) {
    try {
      const feed = await rssParser.parseURL(url);
      for (const entry of (feed.items || []).slice(0, 20)) {
        articles.push({
          source: sourceName,
          title: entry.title || "",
          link: entry.link || "",
          published: entry.pubDate || "",
          text: entry.contentSnippet || entry.content || entry.summary || "",
        });
      }
    } catch (err) {
      console.warn(`[WARN] failed to fetch ${sourceName}: ${err.message}`);
    }
  }
  return articles;
}

async function extractWithClaude(anthropic, article) {
  const prompt = EXTRACTION_SCHEMA_PROMPT(article.title, article.text);
  const resp = await anthropic.messages.create({
    model: "claude-sonnet-4-6",
    max_tokens: 600,
    messages: [{ role: "user", content: prompt }],
  });
  const raw = resp.content.filter((b) => b.type === "text").map((b) => b.text).join("");
  return parseModelJson(raw);
}

async function extractWithGemini(geminiApiKey, article) {
  const prompt = EXTRACTION_SCHEMA_PROMPT(article.title, article.text);
  const resp = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${geminiApiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { responseMimeType: "application/json" },
      }),
    }
  );
  if (!resp.ok) {
    return { error: "gemini_request_failed", status: resp.status };
  }
  const data = await resp.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return parseModelJson(raw);
}

async function runPipeline() {
  const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
  const geminiKey = process.env.GEMINI_API_KEY || null;

  const rawArticles = await fetchAllFeeds();
  const articles = dedupe(rawArticles);

  const events = [];
  let disagreementCount = 0;

  for (const article of articles) {
    const extraction = await extractWithClaude(anthropic, article);
    const ev = { source: article.source, title: article.title, link: article.link, extraction };

    if (geminiKey) {
      const geminiExtraction = await extractWithGemini(geminiKey, article);
      ev.geminiExtraction = geminiExtraction;
      ev.modelAgreement = compareExtractions(extraction, geminiExtraction);
      if (ev.modelAgreement.checked && !ev.modelAgreement.agree) disagreementCount++;
    }
    events.push(ev);
  }

  const clusters = clusterEvents(events);
  const summaries = clusters.map(summarizeCluster);

  return {
    generated_at: new Date().toISOString(),
    articles_fetched: rawArticles.length,
    articles_after_dedupe: articles.length,
    events_identified: clusters.length,
    gemini_crosscheck_enabled: Boolean(geminiKey),
    model_disagreement_count: disagreementCount,
    summaries,
  };
}

export default async (req) => {
  const adminKey = process.env.ADMIN_TRIGGER_KEY;
  const isScheduled = req.headers.get("x-nf-schedule") === "true" || req.headers.get("x-netlify-scheduled") === "true";

  // If ADMIN_TRIGGER_KEY is set, require it for any manually-invoked (non-scheduled) run.
  if (!isScheduled && adminKey) {
    const url = new URL(req.url);
    if (url.searchParams.get("key") !== adminKey) {
      return new Response("Unauthorized", { status: 401 });
    }
  }

  try {
    const digest = await runPipeline();
    const store = getStore("tracker-digests");
    await store.setJSON("latest", digest);
    await store.setJSON(`archive/${digest.generated_at.slice(0, 10)}`, digest);

    return new Response(JSON.stringify({ ok: true, events_identified: digest.events_identified }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};

// Runs once a day automatically. Change the cron string to adjust cadence
// (e.g. "0 */6 * * *" for every 6 hours). See Netlify Scheduled Functions docs.
export const config = {
  schedule: "@daily",
};
