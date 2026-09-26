# Global Tracker — Netlify deploy

This is a self-contained deployable version of the tracker: a scheduled
serverless function does the ingestion + Claude/Gemini extraction +
reconciliation once a day, stores the result, and a static page displays it.

## What's in here

```
netlify.toml                        # build/functions config
package.json                        # dependencies
netlify/functions/generate-digest.js   # the pipeline — runs on a daily schedule
netlify/functions/get-digest.js        # serves the latest stored digest as JSON
netlify/functions/lib/pipeline.js      # shared logic: feeds, schema, clustering, reconciliation
public/index.html                   # the page you actually look at
```

## Deploy steps

1. **Push this folder to a GitHub repo** (Netlify deploys from git).
2. **In Netlify:** "Add new site" → "Import an existing project" → pick the repo.
   Build settings are already set via `netlify.toml` (publish = `public`,
   functions = `netlify/functions`) — you shouldn't need to change anything.
3. **Set environment variables** — Site settings → Environment variables:
   - `ANTHROPIC_API_KEY` — required
   - `GEMINI_API_KEY` — optional; add it to turn on the Claude/Gemini
     dual-model cross-check. Leave it unset and the pipeline just runs
     Claude-only, no errors.
   - `ADMIN_TRIGGER_KEY` — optional; set this to any secret string if you
     want to be able to manually trigger a run for testing (see below).
     If you don't set it, only the daily schedule can run the function.
4. **Deploy.** Netlify will install the npm dependencies automatically.
5. **Netlify Blobs** needs no setup — it's enabled by default on Netlify
   sites and `getStore()` just works once deployed.

## Testing it without waiting a day

Once deployed, if you set `ADMIN_TRIGGER_KEY`, you can trigger a run by hand:

```
curl "https://YOUR-SITE.netlify.app/.netlify/functions/generate-digest?key=YOUR_ADMIN_KEY"
```

Then reload the site — `index.html` calls `get-digest` on load and will show
whatever was just generated.

## Changing how often it runs

`generate-digest.js` ends with:

```js
export const config = { schedule: "@daily" };
```

Change `"@daily"` to a cron string (e.g. `"0 */6 * * *"` for every 6 hours)
to adjust cadence. More frequent runs mean more Claude/Gemini API calls —
watch your usage/cost as you tighten this.

## Adding more sources

Edit `FEEDS` in `netlify/functions/lib/pipeline.js` — same format as the
standalone Python version (`tracker_mvp.py`), just add `"Outlet Name": "rss url"`.

## Known limitations, stated plainly

- **Clustering/reconciliation is heuristic** (fuzzy title match + country
  overlap), same as the Python MVP — good enough to demo the concept, not
  a production entity-resolution system. Swap in embedding similarity
  (a vector DB) once you're past a few dozen events/day.
- **RSS feed URLs can change or get rate-limited** by publishers — if a
  feed silently returns nothing, that outlet just contributes zero
  articles that day rather than erroring the whole run.
- **This hasn't been run against a live Netlify deploy** in the environment
  this was written in (no outbound network access there) — the code is
  correct against the documented Netlify Functions v2 / Blobs / Anthropic
  / Gemini APIs, but do a manual trigger test right after your first
  deploy to confirm end-to-end before relying on the schedule.
