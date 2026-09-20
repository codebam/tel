// Node target runtime. Pure factory: codegen inlines this source and passes
// imported node modules in; the interpreter imports an adapter that does the
// same. No top-level `import` statements live here.
export function makeNodeExtra(core, fs, http, path, proc) {
  const { Ok, Err, Sum, str, truthy, rec } = core;

  function tryOp(fn) {
    try { return Ok(fn()); } catch (e) { return Err(String(e && e.message ? e.message : e)); }
  }
  async function tryAsync(fn) {
    try { return Ok(await fn()); } catch (e) { return Err(String(e && e.message ? e.message : e)); }
  }

  const fsStd = {
    read(p) { return tryOp(() => fs.readFileSync(path.resolve(str(p)), 'utf8')); },
    readBytes(p) { return tryOp(() => [...fs.readFileSync(path.resolve(str(p)))]); },
    write(p, data) { return tryOp(() => { fs.writeFileSync(path.resolve(str(p)), str(data)); return p; }); },
    append(p, data) { return tryOp(() => { fs.appendFileSync(path.resolve(str(p)), str(data)); return p; }); },
    exists(p) { return fs.existsSync(path.resolve(str(p))); },
    list(p = '.') { return tryOp(() => fs.readdirSync(path.resolve(str(p)))); },
    remove(p) { return tryOp(() => { fs.rmSync(path.resolve(str(p)), { recursive: true, force: true }); return true; }); },
    mkdir(p) { return tryOp(() => { fs.mkdirSync(path.resolve(str(p)), { recursive: true }); return p; }); },
    cwd() { return proc.cwd(); },
    readJson(p) { return tryOp(() => JSON.parse(fs.readFileSync(path.resolve(str(p)), 'utf8'))); },
    writeJson(p, v) { return tryOp(() => { fs.writeFileSync(path.resolve(str(p)), JSON.stringify(v, null, 2)); return p; }); },
  };

  function res(status = 200, body = null, headers = {}) {
    return { __res: true, status, body, headers };
  }

  function normalizeResponse(r) {
    if (r && r.__res) return r;
    if (r instanceof Sum) return { status: 200, body: str(r), headers: {} };
    if (r === null || r === undefined) return { status: 204, body: null, headers: {} };
    if (typeof r === 'object') return { status: 200, body: JSON.stringify(r), headers: { 'content-type': 'application/json' } };
    return { status: 200, body: str(r), headers: { 'content-type': 'text/plain; charset=utf-8' } };
  }

  const httpStd = {
    res,
    async serve(port, handler, host = '127.0.0.1') {
      const server = http.createServer(async (req, rsp) => {
        const chunks = [];
        for await (const c of req) chunks.push(c);
        const bodyRaw = Buffer.concat(chunks).toString('utf8');
        let body = bodyRaw;
        try { if (bodyRaw) body = JSON.parse(bodyRaw); } catch { body = bodyRaw; }
        const q = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
        const query = Object.fromEntries(q.searchParams.entries());
        try {
          const out = await handler(rec('Request', { method: req.method, path: q.pathname, query, headers: req.headers, body }));
          const r = normalizeResponse(out);
          rsp.writeHead(r.status, r.headers);
          rsp.end(r.body === null || r.body === undefined ? '' : str(r.body));
        } catch (e) {
          rsp.writeHead(500, { 'content-type': 'text/plain' });
          rsp.end(String(e && e.stack ? e.stack : e));
        }
      });
      await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, host, resolve); });
      return {
        port: server.address().port,
        close() { return new Promise((r) => server.close(r)); },
      };
    },
    async get(url, headers = {}) {
      return tryAsync(async () => {
        const r = await fetch(str(url), { headers });
        const text = await r.text();
        let body = text;
        try { body = JSON.parse(text); } catch { /* keep text */ }
        return { status: r.status, body, headers: Object.fromEntries(r.headers.entries()) };
      });
    },
    async post(url, body = null, headers = {}) {
      return tryAsync(async () => {
        const init = { method: 'POST', headers: { 'content-type': 'application/json', ...headers } };
        init.body = typeof body === 'string' ? body : JSON.stringify(body);
        const r = await fetch(str(url), init);
        const text = await r.text();
        let out = text;
        try { out = JSON.parse(text); } catch { /* keep text */ }
        return { status: r.status, body: out };
      });
    },
  };

  const envStd = {
    get(name, fallback = null) { const v = proc.env[str(name)]; return v === undefined ? fallback : v; },
    set(name, value) { proc.env[str(name)] = str(value); return value; },
    args: proc.argv.slice(2),
    cwd: () => proc.cwd(),
    exit(code = 0) { proc.exit(Number(code) || 0); },
  };

  const timeStd = {
    now: () => Date.now(),
    iso: () => new Date().toISOString(),
    sleep: (ms) => new Promise((r) => setTimeout(r, Number(ms) || 0)),
  };

  return { fs: fsStd, http: httpStd, env: envStd, time: timeStd, exit: envStd.exit, res };
}
