// Minimal GitHub REST/GraphQL client on Node's built-in fetch (no dependencies).

const API = "https://api.github.com";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function client(token, repo) {
  if (!token) throw new Error("GitHub token is missing");

  async function req(method, path, body, { allow404 = false } = {}) {
    const url = path.startsWith("http") ? path : path.startsWith("/repos/") || path === "/graphql" ? `${API}${path}` : `${API}/repos/${repo}${path}`;
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "X-GitHub-Api-Version": "2022-11-28",
          ...(body ? { "Content-Type": "application/json" } : {}),
        },
        body: body ? JSON.stringify(body) : undefined,
      });
      if (res.status === 404 && allow404) return null;
      if (res.ok) {
        if (res.status === 204) return null;
        const ct = res.headers.get("content-type") ?? "";
        return ct.includes("json") ? res.json() : res.text();
      }
      // Retry only idempotent reads on transient errors. Writes are never retried blindly.
      if (method === "GET" && attempt < 2 && (res.status >= 500 || res.status === 429)) {
        await sleep(1500 * (attempt + 1));
        continue;
      }
      const text = await res.text();
      const err = new Error(`${method} ${path} -> ${res.status}: ${text.slice(0, 300)}`);
      err.status = res.status;
      throw err;
    }
  }

  /** Paginated GET of an array endpoint (or {check_runs}/{workflow_runs} wrappers). Bounded at 10 pages. */
  async function all(path) {
    const out = [];
    for (let page = 1; page <= 10; page++) {
      const sep = path.includes("?") ? "&" : "?";
      const data = await req("GET", `${path}${sep}per_page=100&page=${page}`);
      const items = Array.isArray(data) ? data : data.check_runs ?? data.workflow_runs ?? [];
      out.push(...items);
      if (items.length < 100) break;
    }
    return out;
  }

  async function graphql(query, variables) {
    const res = await req("POST", "/graphql", { query, variables });
    if (res.errors?.length) throw new Error(`GraphQL: ${res.errors.map((e) => e.message).join("; ")}`);
    return res.data;
  }

  return {
    req,
    all,
    graphql,
    get: (p, o) => req("GET", p, undefined, o),
    post: (p, b) => req("POST", p, b),
    patch: (p, b) => req("PATCH", p, b),
    put: (p, b) => req("PUT", p, b),
    del: (p) => req("DELETE", p),
  };
}
