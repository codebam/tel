import { createServer } from "node:http"
const port = Number(process.env.PORT ?? 0)
createServer((req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host}`)
  if (url.pathname === "/health") return send(res, 200, { ok: true })
  if (url.pathname === "/sum") {
    const n = Number(url.searchParams.get("n") ?? 0)
    return send(res, 200, { n, sum: n > 0 ? (n * (n + 1)) / 2 : 0 })
  }
  send(res, 404, "not found", false)
}).listen(port, "127.0.0.1")
function send(res, status, body, json = true) {
  const raw = json ? JSON.stringify(body) : body
  res.writeHead(status, { "content-type": json ? "application/json" : "text/plain" })
  res.end(raw)
}
