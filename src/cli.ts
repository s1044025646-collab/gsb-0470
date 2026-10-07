// CLI：create-axis / add-gearset / fix-speed / lock / solve / state / equations / substitute / report / serve / demo
import path from "node:path";
import fs from "node:fs";
import { Store } from "./store";
import { createServer, listen } from "./server";
import { validateAxisId, validateTeeth, parseSpeed, substitute, buildEquations, ValidationError } from "./model";
import { toString as ratStr } from "./rational";

const DATA_DIR = process.env.DATA_DIR ?? path.join(process.cwd(), "data");
const DB_PATH = process.env.DB_PATH ?? path.join(DATA_DIR, "planetary.db");

function openStore(): Store {
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  return new Store(DB_PATH);
}

function print(x: unknown): void {
  process.stdout.write(JSON.stringify(x, null, 2) + "\n");
}

function fail(e: unknown): never {
  if (e instanceof ValidationError) {
    print({ ok: false, error: { code: e.code, message: e.message } });
  } else {
    print({ ok: false, error: { code: "E_INTERNAL", message: (e as Error).message } });
  }
  process.exit(1);
}

function parseValue(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const argMap = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    if (args[i]?.startsWith("--")) argMap.set(args[i].slice(2), args[i + 1] ?? "");
  }
  const get = (k: string): string | undefined => argMap.get(k);
  const need = (k: string): string => {
    const v = argMap.get(k);
    if (v === undefined) throw new ValidationError("E_ARGS", `缺少参数 --${k}`);
    return v;
  };

  try {
    switch (cmd) {
      case "create-axis": {
        const store = openStore();
        print(store.addAxis(validateAxisId(need("id"))));
        store.close();
        break;
      }
      case "add-gearset": {
        const store = openStore();
        const { ns, nr } = validateTeeth(Number(need("ns")), Number(need("nr")));
        print(
          store.addGearset({
            id: get("id") ?? `g${Date.now()}`,
            ns,
            nr,
            sun: validateAxisId(need("sun")),
            ring: validateAxisId(need("ring")),
            carrier: validateAxisId(need("carrier")),
          }),
        );
        store.close();
        break;
      }
      case "fix-speed": {
        const store = openStore();
        const v = parseSpeed(parseValue(need("value")));
        print(store.addFixed(get("id") ?? `f${Date.now()}`, validateAxisId(need("axis")), v.n.toString(), v.d.toString()));
        store.close();
        break;
      }
      case "lock": {
        const store = openStore();
        print(store.addLock(get("id") ?? `l${Date.now()}`, validateAxisId(need("a")), validateAxisId(need("b"))));
        store.close();
        break;
      }
      case "solve": {
        const store = openStore();
        print(store.frozen());
        store.close();
        break;
      }
      case "state": {
        const store = openStore();
        const s = store.loadState();
        print({
          version: store.version,
          axes: s.axes.map((a) => a.id),
          gearsets: s.gearsets,
          constraints: s.constraints.map((c) =>
            c.kind === "fixed" ? { kind: c.kind, id: c.id, axis: c.axis, value: ratStr(c.value) } : c,
          ),
        });
        store.close();
        break;
      }
      case "equations": {
        const store = openStore();
        print(
          buildEquations(store.loadState()).map((e) => ({
            index: e.source.index,
            description: e.source.description,
            coefficients: e.a.map(ratStr),
            rhs: ratStr(e.b),
          })),
        );
        store.close();
        break;
      }
      case "substitute": {
        const store = openStore();
        print(substitute(store.loadState(), JSON.parse(need("params")) as Record<string, unknown>));
        store.close();
        break;
      }
      case "report": {
        const store = openStore();
        const out = {
          generatedAt: new Date().toISOString(),
          version: store.version,
          result: store.frozen(),
        };
        const file = get("out");
        if (file) {
          fs.writeFileSync(file, JSON.stringify(out, null, 2), "utf8");
          process.stdout.write(`报告已导出到 ${file}\n`);
        } else {
          print(out);
        }
        store.close();
        break;
      }
      case "serve": {
        const store = openStore();
        const port = get("port") !== undefined ? Number(get("port")) : Number(process.env.PORT ?? 0);
        const server = createServer(store);
        const actual = await listen(server, port);
        process.stdout.write(`API 服务已启动: http://127.0.0.1:${actual} (数据目录 ${DATA_DIR})\n`);
        break;
      }
      case "demo": {
        const tmp = path.join(DATA_DIR, `demo-${Date.now()}.db`);
        const store = new Store(tmp);
        runDemo(store);
        store.close();
        cleanupDemoFiles();
        break;
      }
      default:
        process.stdout.write(
          [
            "用法: node dist/src/cli.js <命令> [参数]",
            "  create-axis --id S",
            "  add-gearset --id g1 --ns 20 --nr 60 --sun S --ring R --carrier C",
            "  fix-speed --id f1 --axis S --value 1200   （value 支持 \"-3/4\" 或 '{\"num\":-3,\"den\":4}'）",
            "  lock --id l1 --a A --b B",
            "  solve | state | equations | report [--out file]",
            "  substitute --params '{\"C\": \"100\"}'",
            "  serve [--port 8080]   （默认自动选择空闲端口）",
            "  demo",
          ].join("\n") + "\n",
        );
        if (cmd !== undefined && cmd !== "help") process.exitCode = 1;
    }
  } catch (e) {
    fail(e);
  }
}

function runDemo(store: Store): void {
  const section = (t: string): void => {
    process.stdout.write(`\n=== ${t} ===\n`);
  };

  section("演示 1：Ns=20 Nr=60，太阳轮 1200 rpm，齿圈固定 => 行星架 300 rpm");
  store.addAxis("S");
  store.addAxis("R");
  store.addAxis("C");
  store.addGearset({ id: "g1", ns: 20, nr: 60, sun: "S", ring: "R", carrier: "C" });
  store.addFixed("f1", "S", "1200", "1");
  print(store.addFixed("f2", "R", "0", "1"));

  section("演示 2：行星架固定，太阳轮 1200 rpm => 齿圈 -400 rpm（修改约束生成新版本）");
  const store2 = new Store(path.join(DATA_DIR, `demo2-${Date.now()}.db`));
  store2.addAxis("S");
  store2.addAxis("R");
  store2.addAxis("C");
  store2.addGearset({ id: "g1", ns: 20, nr: 60, sun: "S", ring: "R", carrier: "C" });
  store2.addFixed("f1", "S", "1200", "1");
  print(store2.addFixed("f2", "C", "0", "1"));
  store2.close();

  section("演示 3：两排串联（第一排行星架与第二排太阳轮共轴），末端行星架 75 rpm");
  const store3 = new Store(path.join(DATA_DIR, `demo3-${Date.now()}.db`));
  for (const a of ["S1", "R1", "C1", "R2", "C2"]) store3.addAxis(a);
  store3.addGearset({ id: "g1", ns: 20, nr: 60, sun: "S1", ring: "R1", carrier: "C1" });
  store3.addGearset({ id: "g2", ns: 20, nr: 60, sun: "C1", ring: "R2", carrier: "C2" });
  store3.addFixed("f1", "S1", "1200", "1");
  store3.addFixed("f2", "R1", "0", "1");
  print(store3.addFixed("f3", "R2", "0", "1"));
  store3.close();

  cleanupDemoFiles();
}

function cleanupDemoFiles(): void {
  try {
    for (const f of fs.readdirSync(DATA_DIR).filter((x) => x.startsWith("demo"))) {
      try {
        fs.rmSync(path.join(DATA_DIR, f), { force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Windows 文件锁释放有延迟，临时演示库清理失败可忽略
      }
    }
  } catch {
    // 数据目录不存在时忽略
  }
}

main().catch(fail);
