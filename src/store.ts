// SQLite 持久化：有序轴、齿数、原约束、版本与冻结求解结果、幂等键。
import { DatabaseSync } from "node:sqlite";
import { SystemState, Axis, Gearset, Constraint, SolveResult, solve, validateTeeth, ValidationError, LIMITS } from "./model";
import { rat } from "./rational";

export class Store {
  private db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS axes (id TEXT PRIMARY KEY, ord INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS gearsets (
        id TEXT PRIMARY KEY, ns INTEGER NOT NULL, nr INTEGER NOT NULL,
        sun TEXT NOT NULL, ring TEXT NOT NULL, carrier TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS constraints (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL,
        axis TEXT, num TEXT, den TEXT, axis_b TEXT
      );
      CREATE TABLE IF NOT EXISTS versions (
        version INTEGER PRIMARY KEY, frozen TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS idempotency (key TEXT PRIMARY KEY, response TEXT NOT NULL);
    `);
    if (this.getMeta("version") === null) this.setMeta("version", "0");
  }

  close(): void {
    this.db.close();
  }

  private getMeta(key: string): string | null {
    const row = this.db.prepare("SELECT value FROM meta WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? row.value : null;
  }

  private setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  get version(): number {
    return Number(this.getMeta("version"));
  }

  loadState(): SystemState {
    const axes = (this.db.prepare("SELECT id, ord FROM axes ORDER BY ord").all() as unknown as { id: string; ord: number }[]).map(
      (r): Axis => ({ id: r.id, order: r.ord }),
    );
    const gearsets = this.db.prepare("SELECT * FROM gearsets ORDER BY rowid").all() as unknown as Gearset[];
    const constraints = (this.db.prepare("SELECT * FROM constraints ORDER BY rowid").all() as unknown as {
      id: string; kind: string; axis: string | null; num: string | null; den: string | null; axis_b: string | null;
    }[]).map((r): Constraint => {
      if (r.kind === "fixed") return { kind: "fixed", id: r.id, axis: r.axis!, value: rat(BigInt(r.num!), BigInt(r.den!)) };
      return { kind: "lock", id: r.id, a: r.axis!, b: r.axis_b! };
    });
    return { axes, gearsets, constraints };
  }

  // 每次成功修改后调用：版本 +1，冻结求解结果（含 budget_exceeded，便于重启后核对）
  private commit(): SolveResult {
    const version = this.version + 1;
    this.setMeta("version", String(version));
    const result = solve(this.loadState());
    result.version = version;
    this.db.prepare("INSERT INTO versions (version, frozen, created_at) VALUES (?, ?, ?)").run(
      version,
      JSON.stringify(result),
      new Date().toISOString(),
    );
    return result;
  }

  frozen(version?: number): SolveResult | null {
    const v = version ?? this.version;
    const row = this.db.prepare("SELECT frozen FROM versions WHERE version = ?").get(v) as { frozen: string } | undefined;
    return row ? (JSON.parse(row.frozen) as SolveResult) : null;
  }

  // 幂等执行：同 key 直接返回首次响应；抛错不写入、不覆盖系统
  idempotent<T>(key: string | undefined, fn: () => T): T {
    if (key) {
      const row = this.db.prepare("SELECT response FROM idempotency WHERE key = ?").get(key) as { response: string } | undefined;
      if (row) return JSON.parse(row.response) as T;
    }
    const out = fn();
    if (key) {
      this.db.prepare("INSERT OR IGNORE INTO idempotency (key, response) VALUES (?, ?)").run(key, JSON.stringify(out));
    }
    return out;
  }

  addAxis(id: string): SolveResult {
    if (this.loadState().axes.length >= LIMITS.maxAxes) throw new ValidationError("E_LIMIT", "轴数量超限");
    const exists = this.db.prepare("SELECT 1 FROM axes WHERE id = ?").get(id);
    if (exists) throw new ValidationError("E_DUP", `轴 ${id} 已存在`);
    const ord = (this.db.prepare("SELECT COALESCE(MAX(ord), -1) + 1 AS o FROM axes").get() as { o: number }).o;
    this.db.prepare("INSERT INTO axes (id, ord) VALUES (?, ?)").run(id, ord);
    return this.commit();
  }

  addGearset(g: Gearset): SolveResult {
    validateTeeth(g.ns, g.nr);
    if (this.loadState().gearsets.length >= LIMITS.maxGearsets) throw new ValidationError("E_LIMIT", "行星排数量超限");
    if (this.db.prepare("SELECT 1 FROM gearsets WHERE id = ?").get(g.id)) {
      throw new ValidationError("E_DUP", `行星排 ${g.id} 已存在`);
    }
    const state = this.loadState();
    const ids = new Set(state.axes.map((a) => a.id));
    for (const ref of [g.sun, g.ring, g.carrier]) {
      if (!ids.has(ref)) throw new ValidationError("E_REF", `行星排引用了未声明的轴 ${ref}`);
    }
    this.db.prepare("INSERT INTO gearsets (id, ns, nr, sun, ring, carrier) VALUES (?, ?, ?, ?, ?, ?)").run(
      g.id, g.ns, g.nr, g.sun, g.ring, g.carrier,
    );
    return this.commit();
  }

  addFixed(id: string, axis: string, num: string, den: string): SolveResult {
    if (this.db.prepare("SELECT 1 FROM constraints WHERE id = ?").get(id)) {
      throw new ValidationError("E_DUP", `约束 ${id} 已存在`);
    }
    const ids = new Set(this.loadState().axes.map((a) => a.id));
    if (!ids.has(axis)) throw new ValidationError("E_REF", `固定转速引用了未声明的轴 ${axis}`);
    this.db.prepare("INSERT INTO constraints (id, kind, axis, num, den) VALUES (?, 'fixed', ?, ?, ?)").run(id, axis, num, den);
    return this.commit();
  }

  addLock(id: string, a: string, b: string): SolveResult {
    if (this.db.prepare("SELECT 1 FROM constraints WHERE id = ?").get(id)) {
      throw new ValidationError("E_DUP", `约束 ${id} 已存在`);
    }
    if (a === b) throw new ValidationError("E_LOCK_SELF", "锁连两端是同一根轴");
    const ids = new Set(this.loadState().axes.map((x) => x.id));
    if (!ids.has(a) || !ids.has(b)) throw new ValidationError("E_REF", "锁连引用了未声明的轴");
    this.db.prepare("INSERT INTO constraints (id, kind, axis, axis_b) VALUES (?, 'lock', ?, ?)").run(id, a, b);
    return this.commit();
  }
}
