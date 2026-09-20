type Reply = { status: number; body: unknown }
function route(method: string, path: string, query: Record<string, string>): Reply {
  if (method !== "GET") return { status: 405, body: { error: "method" } }
  if (path === "/health") return { status: 200, body: { ok: true } }
  if (path === "/sum") {
    const n = Number(query.n ?? "0")
    return { status: 200, body: { sum: n > 0 ? (n * (n + 1)) / 2 : 0 } }
  }
  return { status: 404, body: { error: "not found" } }
}
console.log(JSON.stringify(route("GET", "/health", {})))
console.log(JSON.stringify(route("GET", "/sum", { n: "5" })))
console.log(JSON.stringify(route("POST", "/", {})))
