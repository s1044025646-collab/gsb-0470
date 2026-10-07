// HTTP API：仅本机回环，node:http 实现，无外部依赖。
import http from "node:http";
import { Store } from "./store";
import {
  validateAxisId, validateTeeth, parseSpeed, solve, substitute, buildEquations, ValidationError,
} from "./model";
import { toString as ratStr } from "./rational";

interface ApiOk {
  ok: true;
  data: unknown;
}
interface ApiErr {
  ok: false;
  error: { code: string; message: string };
}

function send(res: http.ServerResponse, status: number, body: ApiOk | ApiErr): void {
  const s = JSON.stringify(body, null, 2);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(s);
}

function readBody(req: http.IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      if (chunks.length === 0) return resolve({});
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      } catch {
        reject(new ValidationError("E_JSON", "请求体不是合法 JSON"));
      }
    });
    req.on("error", reject);
  });
}

export function createServer(store: Store): http.Server {
  const handler = async (req: http.IncomingMessage, res: http.ServerResponse): Promise<void> => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const method = req.method ?? "GET";
    const idemKey = req.headers["idempotency-key"] as string | undefined;
    try {
      const body = method === "POST" ? ((await readBody(req)) as Record<string, unknown>) : {};
      const b = body as Record<string, unknown>;

      if (method === "POST" && path === "/axes") {
        const id = validateAxisId(b.id);
        const out = store.idempotent(idemKey, () => store.addAxis(id));
        return send(res, 200, { ok: true, data: out });
      }
      if (method === "POST" && path === "/gearsets") {
        const { ns, nr } = validateTeeth(b.ns, b.nr);
        const id = typeof b.id === "string" ? b.id : `g${Date.now()}`;
        validateAxisId(id);
        const sun = validateAxisId(b.sun);
        const ring = validateAxisId(b.ring);
        const carrier = validateAxisId(b.carrier);
        const out = store.idempotent(idemKey, () => store.addGearset({ id, ns, nr, sun, ring, carrier }));
        return send(res, 200, { ok: true, data: out });
      }
      if (method === "POST" && path === "/fixed") {
        const id = typeof b.id === "string" ? b.id : `f${Date.now()}`;
        validateAxisId(id);
        const axis = validateAxisId(b.axis);
        const v = parseSpeed(b.value);
        const out = store.idempotent(idemKey, () => store.addFixed(id, axis, v.n.toString(), v.d.toString()));
        return send(res, 200, { ok: true, data: out });
      }
      if (method === "POST" && path === "/locks") {
        const id = typeof b.id === "string" ? b.id : `l${Date.now()}`;
        validateAxisId(id);
        const a = validateAxisId(b.a);
        const bb = validateAxisId(b.b);
        const out = store.idempotent(idemKey, () => store.addLock(id, a, bb));
        return send(res, 200, { ok: true, data: out });
      }
      if (method === "POST" && path === "/solve") {
        const out = store.frozen() ?? { status: "unique", axes: [], numEquations: 0 };
        return send(res, 200, { ok: true, data: out });
      }
      if (method === "GET" && path === "/state") {
        const s = store.loadState();
        return send(res, 200, {
          ok: true,
          data: {
            version: store.version,
            axes: s.axes.map((a) => a.id),
            gearsets: s.gearsets,
            constraints: s.constraints.map((c) =>
              c.kind === "fixed" ? { kind: c.kind, id: c.id, axis: c.axis, value: ratStr(c.value) } : c,
            ),
          },
        });
      }
      if (method === "GET" && path === "/equations") {
        const eqs = buildEquations(store.loadState());
        return send(res, 200, {
          ok: true,
          data: eqs.map((e) => ({
            index: e.source.index,
            description: e.source.description,
            constraintId: e.source.constraintId,
            coefficients: e.a.map(ratStr),
            rhs: ratStr(e.b),
          })),
        });
      }
      if (method === "POST" && path === "/substitute") {
        const params = (b.params ?? {}) as Record<string, unknown>;
        const out = substitute(store.loadState(), params);
        return send(res, 200, { ok: true, data: out });
      }
      if (method === "GET" && path === "/report") {
        const state = store.loadState();
        const frozen = store.frozen();
        const versionParam = url.searchParams.get("version");
        const historical = versionParam ? store.frozen(Number(versionParam)) : null;
        return send(res, 200, {
          ok: true,
          data: {
            generatedAt: new Date().toISOString(),
            version: store.version,
            axes: state.axes.map((a) => a.id),
            gearsets: state.gearsets,
            constraints: state.constraints.map((c) =>
              c.kind === "fixed" ? { kind: c.kind, id: c.id, axis: c.axis, value: ratStr(c.value) } : c,
            ),
            equations: buildEquations(state).map((e) => e.source.description),
            result: frozen,
            requestedVersion: historical,
          },
        });
      }
      return send(res, 404, { ok: false, error: { code: "E_NOT_FOUND", message: `未知路由 ${method} ${path}` } });
    } catch (e) {
      if (e instanceof ValidationError) {
        return send(res, 400, { ok: false, error: { code: e.code, message: e.message } });
      }
      return send(res, 500, { ok: false, error: { code: "E_INTERNAL", message: (e as Error).message } });
    }
  };
  return http.createServer((req, res) => {
    handler(req, res).catch((e) => send(res, 500, { ok: false, error: { code: "E_INTERNAL", message: String(e) } }));
  });
}

export function listen(server: http.Server, port: number): Promise<number> {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr ? addr.port : port);
    });
  });
}
