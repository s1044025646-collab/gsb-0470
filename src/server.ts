import * as http from 'node:http';
import * as net from 'node:net';
import { GearStore, mapError } from './store';

type Handler = (body: Record<string, unknown>, params: Record<string, string>) => unknown;

interface Route { method: string; pattern: RegExp; keys: string[]; handler: Handler; }

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const pattern = new RegExp('^' + path.replace(/:([A-Za-z]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; }) + '$');
  return { method, pattern, keys, handler };
}

export function createServer(store: GearStore): http.Server {
  const routes: Route[] = [
    route('GET', '/health', () => ({ ok: true })),
    route('POST', '/axes', (b) => store.addAxis(b.id)),
    route('GET', '/axes', () => store.axes()),
    route('POST', '/rows', (b) => store.addRow(b)),
    route('GET', '/rows', () => store.rows()),
    route('PATCH', '/rows/:id', (b, p) => { store.updateRow(Number(p.id), b); return { ok: true }; }),
    route('POST', '/constraints/fixed', (b) => store.addFixed(b.axis, b.value)),
    route('POST', '/constraints/lock', (b) => store.addLock(b.a, b.b)),
    route('GET', '/constraints', () => store.constraints()),
    route('DELETE', '/constraints/:id', (_b, p) => { store.removeConstraint(Number(p.id)); return { ok: true }; }),
    route('GET', '/equations', () => store.buildSystem().constraints.map((c) => ({
      id: c.id, kind: c.kind, note: c.note,
      coeffs: c.coeffs.map((x) => x.toString()), rhs: c.rhs.toString(),
    }))),
    route('POST', '/solve', () => {
      const s = store.solve();
      return {
        ...s,
        solution: s.solution?.map((x) => ({ exact: x.toString(), decimal: x.toDecimal() })),
        directions: s.directions?.map((d) => d.map((x) => x.toString())),
        residuals: s.residuals?.map((x) => x.toString()),
        witness: s.witness ? { coeffs: s.witness.coeffs.map((x) => x.toString()), rhs: s.witness.rhs.toString() } : undefined,
      };
    }),
    route('POST', '/substitute', (b) => store.substitute((b.params ?? {}) as Record<string, unknown>)),
    route('GET', '/report', () => store.report()),
    route('GET', '/snapshots/:version', (_b, p) => store.snapshot(Number(p.version))),
  ];

  return http.createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      let body: Record<string, unknown> = {};
      if (chunks.length) {
        try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
        catch { send(res, 400, { error: { code: 'BAD_JSON', message: '请求体不是合法 JSON' } }); return; }
      }
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
        try {
          send(res, 200, { data: r.handler(body, params) });
        } catch (e) {
          const err = mapError(e);
          send(res, err.http, { error: { code: err.code, message: err.message } });
        }
        return;
      }
      send(res, 404, { error: { code: 'NOT_FOUND', message: `${req.method} ${url.pathname}` } });
    });
  });
}

function send(res: http.ServerResponse, status: number, payload: unknown): void {
  const text = JSON.stringify(payload, null, 2);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
}

export function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(findFreePort(preferred === 0 ? 0 : preferred + 1)));
    srv.listen(preferred, () => {
      const port = (srv.address() as net.AddressInfo).port;
      srv.close(() => resolve(port));
    });
  });
}
