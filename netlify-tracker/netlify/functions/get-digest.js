// Reads the most recently generated digest out of Netlify Blobs and returns
// it as JSON. The frontend (public/index.html) calls this on load.

import { getStore } from "@netlify/blobs";

export default async () => {
  try {
    const store = getStore("tracker-digests");
    const digest = await store.get("latest", { type: "json" });

    if (!digest) {
      return new Response(
        JSON.stringify({
          ok: false,
          message: "No digest generated yet. Wait for the daily schedule to run, or trigger generate-digest manually.",
        }),
        { status: 200, headers: { "content-type": "application/json" } }
      );
    }

    return new Response(JSON.stringify({ ok: true, digest }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  } catch (err) {
    return new Response(JSON.stringify({ ok: false, error: err.message }), {
      status: 500,
      headers: { "content-type": "application/json" },
    });
  }
};
