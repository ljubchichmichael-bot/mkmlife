// Cloudflare Worker: private write gateway for a public GitHub Pages CRM.
// Configure these Worker secrets/variables in Cloudflare before deployment:
// GITHUB_TOKEN (secret), APP_PASSWORD (secret), GITHUB_OWNER, GITHUB_REPO,
// DATA_BRANCH (for example "crm-data"), DATA_PATH (for example "data/channel-crm.json"),
// ALLOWED_ORIGIN (for example "https://YOURNAME.github.io").

const corsHeaders = (origin, env) => ({
  "Access-Control-Allow-Origin": env.ALLOWED_ORIGIN,
  "Access-Control-Allow-Methods": "GET, PUT, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type",
  "Access-Control-Max-Age": "86400",
  "Vary": "Origin",
});

function jsonResponse(body, status, origin, env) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...corsHeaders(origin, env) },
  });
}

function encodeBase64Utf8(text) {
  const bytes = new TextEncoder().encode(text);
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

function decodeBase64Utf8(value) {
  const binary = atob(value.replace(/\n/g, ""));
  const bytes = Uint8Array.from(binary, ch => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

function githubFileUrl(env) {
  const path = env.DATA_PATH.split("/").map(encodeURIComponent).join("/");
  return `https://api.github.com/repos/${encodeURIComponent(env.GITHUB_OWNER)}/${encodeURIComponent(env.GITHUB_REPO)}/contents/${path}?ref=${encodeURIComponent(env.DATA_BRANCH)}`;
}

async function githubRequest(url, env, init = {}) {
  return fetch(url, {
    ...init,
    headers: {
      Accept: "application/vnd.github+json",
      Authorization: `Bearer ${env.GITHUB_TOKEN}`,
      "X-GitHub-Api-Version": "2022-11-28",
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
}

async function readCurrent(env) {
  const response = await githubRequest(githubFileUrl(env), env);
  if (response.status === 404) return { exists: false, sha: null, data: null };
  if (!response.ok) throw new Error(`GitHub read failed (${response.status}): ${await response.text()}`);
  const file = await response.json();
  return { exists: true, sha: file.sha, data: JSON.parse(decodeBase64Utf8(file.content)) };
}

async function writeData(data, env) {
  const serialized = JSON.stringify(data, null, 2);
  if (serialized.length > 1_000_000) throw new Error("CRM data file is over 1 MB.");
  const url = githubFileUrl(env).split("?")[0];
  let current = await readCurrent(env);
  for (let attempt = 0; attempt < 2; attempt++) {
    const body = {
      message: "Update CRM data",
      content: encodeBase64Utf8(serialized),
      branch: env.DATA_BRANCH,
      ...(current.sha ? { sha: current.sha } : {}),
    };
    const response = await githubRequest(url, env, { method: "PUT", body: JSON.stringify(body) });
    if (response.ok) {
      const result = await response.json();
      return { sha: result.content.sha, updatedAt: result.commit.committer.date };
    }
    if ((response.status === 409 || response.status === 422) && attempt === 0) {
      current = await readCurrent(env);
      continue;
    }
    throw new Error(`GitHub write failed (${response.status}): ${await response.text()}`);
  }
  throw new Error("Could not write CRM data after retry.");
}

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    if (origin !== env.ALLOWED_ORIGIN) return new Response("Origin not allowed", { status: 403 });
    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(origin, env) });
    if (!env.GITHUB_TOKEN || !env.APP_PASSWORD || !env.GITHUB_OWNER || !env.GITHUB_REPO || !env.DATA_BRANCH || !env.DATA_PATH || !env.ALLOWED_ORIGIN) {
      return jsonResponse({ error: "Worker configuration is incomplete." }, 500, origin, env);
    }
    const url = new URL(request.url);
    if (url.pathname !== "/data") return jsonResponse({ error: "Not found" }, 404, origin, env);
    const auth = request.headers.get("Authorization") || "";
    if (auth !== `Bearer ${env.APP_PASSWORD}`) return jsonResponse({ error: "Unauthorized" }, 401, origin, env);
    try {
      if (request.method === "GET") {
        const current = await readCurrent(env);
        return jsonResponse(current, 200, origin, env);
      }
      if (request.method === "PUT") {
        const payload = await request.json();
        if (!payload || typeof payload !== "object" || !Array.isArray(payload.items) || !Array.isArray(payload.rubrics)) {
          return jsonResponse({ error: "Invalid CRM payload." }, 400, origin, env);
        }
        const result = await writeData(payload, env);
        return jsonResponse({ ok: true, ...result }, 200, origin, env);
      }
      return jsonResponse({ error: "Method not allowed" }, 405, origin, env);
    } catch (error) {
      return jsonResponse({ error: error.message || "Worker error" }, 502, origin, env);
    }
  },
};
