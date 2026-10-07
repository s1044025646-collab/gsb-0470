import * as path from 'node:path';
import { GearStore, mapError } from './store';
import { createServer, findFreePort } from './server';

const DATA_DIR = process.env.GEAR_DATA_DIR ?? path.join(process.cwd(), 'data');
const DB_PATH = process.env.GEAR_DB ?? path.join(DATA_DIR, 'gears.db');

function out(x: unknown): void { console.log(JSON.stringify(x, null, 2)); }

function fail(e: unknown): never {
  const err = mapError(e);
  console.error(JSON.stringify({ error: { code: err.code, message: err.message } }));
  process.exit(1);
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  const store = new GearStore(DB_PATH);
  try {
    switch (cmd) {
      case 'serve': {
        const preferred = Number(process.env.PORT ?? args[0] ?? 0);
        const port = await findFreePort(preferred);
        const server = createServer(store);
        server.listen(port, () => console.log(`listening on http://127.0.0.1:${port} (db: ${DB_PATH})`));
        return; // 不关闭 store
      }
      case 'add-axis': out(store.addAxis(args[0])); break;
      case 'add-row': {
        const [Ns, Nr, sun, ring, carrier] = args;
        out(store.addRow({ Ns: Number(Ns), Nr: Number(Nr), sun, ring, carrier }));
        break;
      }
      case 'update-row': {
        const [id, Ns, Nr] = args;
        store.updateRow(Number(id), { Ns: Number(Ns), Nr: Number(Nr) });
        out({ ok: true });
        break;
      }
      case 'fix': out(store.addFixed(args[0], args[1])); break;
      case 'lock': out(store.addLock(args[0], args[1])); break;
      case 'axes': out(store.axes()); break;
      case 'rows': out(store.rows()); break;
      case 'constraints': out(store.constraints()); break;
      case 'equations': out(store.buildSystem().constraints.map((c) => ({
        id: c.id, kind: c.kind, note: c.note,
        coeffs: c.coeffs.map((x) => x.toString()), rhs: c.rhs.toString(),
      }))); break;
      case 'solve': {
        const s = store.solve();
        out({
          version: s.version, status: s.status, rank: s.rank, axes: s.axes,
          dof: s.freeCols.length,
          freeAxes: s.freeCols.map((c) => s.axes[c]),
          solution: s.solution?.map((v, i) => ({ axis: s.axes[i], exact: v.toString(), decimal: v.toDecimal() })),
          directions: s.directions?.map((d, k) => ({
            freeAxis: s.axes[s.freeCols[k]],
            vector: Object.fromEntries(d.map((v, i) => [s.axes[i], v.toString()])),
          })),
          residuals: s.residuals?.map((x) => x.toString()),
          witness: s.witness ? {
            rhs: s.witness.rhs.toString(),
            coeffs: s.witness.coeffs.map((x) => x.toString()),
          } : undefined,
          budgetDetail: s.budgetDetail,
        });
        break;
      }
      case 'substitute': {
        const params: Record<string, string> = {};
        for (const kv of args) {
          const [k, v] = kv.split('=');
          params[k] = v;
        }
        out(store.substitute(params));
        break;
      }
      case 'report': out(store.report()); break;
      case 'snapshot': out(store.snapshot(Number(args[0]))); break;
      default:
        console.error(`用法: node dist/cli.js <命令>
  serve [port]                 启动 HTTP API（默认自动选空闲端口）
  add-axis <id>                创建轴（幂等）
  add-row <Ns> <Nr> <sun> <ring> <carrier>
  update-row <id> <Ns> <Nr>    修改齿数（生成新版本）
  fix <axis> <rpm>             固定转速（整数字符串）
  lock <axisA> <axisB>         锁连两轴
  axes | rows | constraints | equations
  solve                        联立求解
  substitute AXIS=VAL [...]    代入自由参数
  report                       导出报告
  snapshot <version>           查询冻结结果`);
        process.exit(cmd ? 1 : 0);
    }
    store.close();
  } catch (e) {
    fail(e);
  }
}

main();
