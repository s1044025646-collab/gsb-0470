import { DatabaseSync } from 'node:sqlite';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Rat, parseRat, RatError } from './rational';
import { LinConstraint, solveSystem, SolveResult, BudgetExceeded } from './linear';

export interface Limits { maxAxes: number; maxRows: number; maxDigits: number; maxBits: number; }
export const LIMITS: Limits = {
  maxAxes: 64,
  maxRows: 64,
  maxDigits: 60,
  maxBits: 2048,
};

export class ApiError extends Error {
  constructor(public code: string, msg: string, public http = 400) { super(msg); }
}

export interface AxisRec { id: string; pos: number; }
export interface RowRec {
  id: number; ns: number; nr: number; sun: string; ring: string; carrier: string;
}
export interface ConstraintRec {
  id: number; kind: 'fixed' | 'lock'; axis?: string; a?: string; b?: string; value?: string;
}

const ID_RE = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export class GearStore {
  private db: DatabaseSync;
  readonly limits: Limits;

  constructor(dbPath: string, limits: Partial<Limits> = {}) {
    this.limits = { ...LIMITS, ...limits };
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS axes (id TEXT PRIMARY KEY, pos INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS rows (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ns INTEGER NOT NULL, nr INTEGER NOT NULL,
        sun TEXT NOT NULL, ring TEXT NOT NULL, carrier TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS constraints (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL, axis TEXT, a TEXT, b TEXT, value TEXT);
      CREATE TABLE IF NOT EXISTS versions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        created_at TEXT NOT NULL, note TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS snapshots (
        version INTEGER PRIMARY KEY, payload TEXT NOT NULL);
      INSERT OR IGNORE INTO meta(key, value) VALUES ('version', '0');
    `);
  }

  close(): void { this.db.close(); }

  private q(sql: string) {
    return this.db.prepare(sql) as unknown as {
      run: (...p: unknown[]) => { changes: number; lastInsertRowid: number | bigint };
      get: (...p: unknown[]) => unknown;
      all: (...p: unknown[]) => unknown[];
    };
  }

  private get version(): number {
    return Number((this.q(`SELECT value FROM meta WHERE key='version'`).get() as { value: string }).value);
  }

  private bump(note: string): number {
    const v = this.version + 1;
    this.q(`UPDATE meta SET value=? WHERE key='version'`).run(String(v));
    this.q(`INSERT INTO versions(created_at, note) VALUES (?, ?)`)
      .run(new Date().toISOString(), note);
    return v;
  }

  axes(): AxisRec[] {
    return this.q(`SELECT id, pos FROM axes ORDER BY pos`).all() as unknown as AxisRec[];
  }
  rows(): RowRec[] {
    return this.q(`SELECT id, ns, nr, sun, ring, carrier FROM rows ORDER BY id`).all() as unknown as RowRec[];
  }
  constraints(): ConstraintRec[] {
    return this.q(`SELECT id, kind, axis, a, b, value FROM constraints ORDER BY id`).all() as unknown as ConstraintRec[];
  }

  private axisSet(): Set<string> { return new Set(this.axes().map((a) => a.id)); }

  private requireAxis(id: unknown): string {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new ApiError('BAD_AXIS_ID', `非法轴 ID: ${String(id)}`);
    if (!this.axisSet().has(id)) throw new ApiError('AXIS_NOT_FOUND', `轴不存在: ${id}`, 404);
    return id;
  }

  addAxis(id: unknown): { created: boolean; id: string } {
    if (typeof id !== 'string' || !ID_RE.test(id)) throw new ApiError('BAD_AXIS_ID', `非法轴 ID: ${String(id)}`);
    const existing = this.q(`SELECT id FROM axes WHERE id=?`).get(id);
    if (existing) return { created: false, id }; // 幂等
    if (this.axes().length >= this.limits.maxAxes) throw new ApiError('LIMIT_EXCEEDED', '轴数量超限', 413);
    const pos = this.axes().length;
    this.q(`INSERT INTO axes(id, pos) VALUES (?, ?)`).run(id, pos);
    this.bump(`add axis ${id}`);
    return { created: true, id };
  }

  addRow(input: Record<string, unknown>): { id: number } {
    const ns = Number(input.Ns), nr = Number(input.Nr);
    if (!Number.isSafeInteger(ns) || !Number.isSafeInteger(nr) || ns <= 0 || nr <= 0) {
      throw new ApiError('BAD_TEETH', 'Ns/Nr 必须为正整数');
    }
    if (nr <= ns) throw new ApiError('BAD_TEETH', '要求 Nr > Ns');
    if ((nr - ns) % 2 !== 0) throw new ApiError('BAD_TEETH', 'Nr-Ns 必须为正偶数');
    const sun = this.requireAxis(input.sun);
    const ring = this.requireAxis(input.ring);
    const carrier = this.requireAxis(input.carrier);
    if (this.rows().length >= this.limits.maxRows) throw new ApiError('LIMIT_EXCEEDED', '行星排数量超限', 413);
    const r = this.q(`INSERT INTO rows(ns, nr, sun, ring, carrier) VALUES (?,?,?,?,?)`)
      .run(ns, nr, sun, ring, carrier);
    this.bump(`add row ns=${ns} nr=${nr}`);
    return { id: Number(r.lastInsertRowid) };
  }

  updateRow(id: number, patch: Record<string, unknown>): void {
    const row = this.rows().find((x) => x.id === id);
    if (!row) throw new ApiError('ROW_NOT_FOUND', `行星排不存在: ${id}`, 404);
    const merged = { Ns: patch.Ns ?? row.ns, Nr: patch.Nr ?? row.nr, sun: patch.sun ?? row.sun, ring: patch.ring ?? row.ring, carrier: patch.carrier ?? row.carrier };
    const ns = Number(merged.Ns), nr = Number(merged.Nr);
    if (!Number.isSafeInteger(ns) || !Number.isSafeInteger(nr) || ns <= 0 || nr <= 0 || nr <= ns || (nr - ns) % 2 !== 0) {
      throw new ApiError('BAD_TEETH', '齿数不合法');
    }
    this.requireAxis(merged.sun); this.requireAxis(merged.ring); this.requireAxis(merged.carrier);
    this.q(`UPDATE rows SET ns=?, nr=?, sun=?, ring=?, carrier=? WHERE id=?`)
      .run(ns, nr, merged.sun, merged.ring, merged.carrier, id);
    this.bump(`update row ${id}`);
  }

  addFixed(axis: unknown, value: unknown): { id: number; created: boolean } {
    const a = this.requireAxis(axis);
    const rat = parseRat(value, this.limits.maxDigits);
    const dup = this.constraints().find((c) => c.kind === 'fixed' && c.axis === a && c.value === rat.toString());
    if (dup) return { id: dup.id, created: false }; // 幂等
    const r = this.q(`INSERT INTO constraints(kind, axis, value) VALUES ('fixed', ?, ?)`)
      .run(a, rat.toString());
    this.bump(`fix ${a} = ${rat}`);
    return { id: Number(r.lastInsertRowid), created: true };
  }

  addLock(a: unknown, b: unknown): { id: number; created: boolean } {
    const x = this.requireAxis(a), y = this.requireAxis(b);
    if (x === y) throw new ApiError('SAME_AXIS', '锁连需要两个不同 ID 的轴');
    const key = (p: string, q: string) => [p, q].sort().join('|');
    const dup = this.constraints().find((c) => c.kind === 'lock' && key(c.a!, c.b!) === key(x, y));
    if (dup) return { id: dup.id, created: false };
    const r = this.q(`INSERT INTO constraints(kind, a, b) VALUES ('lock', ?, ?)`).run(x, y);
    this.bump(`lock ${x} = ${y}`);
    return { id: Number(r.lastInsertRowid), created: true };
  }

  removeConstraint(id: number): void {
    const r = this.q(`DELETE FROM constraints WHERE id=?`).run(id);
    if (r.changes === 0) throw new ApiError('CONSTRAINT_NOT_FOUND', `约束不存在: ${id}`, 404);
    this.bump(`remove constraint ${id}`);
  }

  // 组装线性方程组（Willis + 固定 + 锁连）
  buildSystem(): { axes: AxisRec[]; constraints: LinConstraint[] } {
    const axes = this.axes();
    const idx = new Map(axes.map((a, i) => [a.id, i]));
    const out: LinConstraint[] = [];
    for (const row of this.rows()) {
      const coeffs = Array.from({ length: axes.length }, () => Rat.zero());
      const add = (axis: string, v: bigint) => {
        const i = idx.get(axis)!;
        coeffs[i] = coeffs[i].add(Rat.of(v));
      };
      // Willis: Ns*ws + Nr*wr - (Ns+Nr)*wc = 0，同轴引用先合并系数
      add(row.sun, BigInt(row.ns));
      add(row.ring, BigInt(row.nr));
      add(row.carrier, -BigInt(row.ns + row.nr));
      out.push({
        id: `row#${row.id}`, kind: 'willis', coeffs, rhs: Rat.zero(),
        note: `Ns=${row.ns} Nr=${row.nr} sun=${row.sun} ring=${row.ring} carrier=${row.carrier}`,
      });
    }
    for (const c of this.constraints()) {
      const coeffs = Array.from({ length: axes.length }, () => Rat.zero());
      if (c.kind === 'fixed') {
        coeffs[idx.get(c.axis!)!] = Rat.one();
        out.push({ id: `fixed#${c.id}`, kind: 'fixed', coeffs, rhs: parseRat(c.value!, this.limits.maxDigits), note: `${c.axis} = ${c.value}` });
      } else {
        coeffs[idx.get(c.a!)!] = Rat.one();
        coeffs[idx.get(c.b!)!] = Rat.one().neg();
        out.push({ id: `lock#${c.id}`, kind: 'lock', coeffs, rhs: Rat.zero(), note: `${c.a} = ${c.b}` });
      }
    }
    return { axes, constraints: out };
  }

  solve(): SolveResult & { version: number; axes: string[] } {
    const { axes, constraints } = this.buildSystem();
    let result: SolveResult;
    try {
      result = solveSystem(constraints, axes.length, this.limits.maxBits);
    } catch (e) {
      if (e instanceof BudgetExceeded) {
        result = { status: 'BUDGET_EXCEEDED', rank: 0, numVars: axes.length, freeCols: [], pivotCols: [], budgetDetail: (e as Error).message };
      } else throw e;
    }
    const payload = {
      version: this.version,
      axes: axes.map((a) => a.id),
      constraints: constraints.map((c) => ({
        id: c.id, kind: c.kind, note: c.note,
        coeffs: c.coeffs.map((x) => x.toString()), rhs: c.rhs.toString(),
      })),
      result: {
        status: result.status, rank: result.rank, numVars: result.numVars,
        freeCols: result.freeCols, pivotCols: result.pivotCols,
        solution: result.solution?.map((x) => x.toString()),
        directions: result.directions?.map((d) => d.map((x) => x.toString())),
        residuals: result.residuals?.map((x) => x.toString()),
        witness: result.witness
          ? { coeffs: result.witness.coeffs.map((x) => x.toString()), rhs: result.witness.rhs.toString() }
          : undefined,
        budgetDetail: result.budgetDetail,
      },
    };
    this.q(`INSERT OR REPLACE INTO snapshots(version, payload) VALUES (?, ?)`)
      .run(this.version, JSON.stringify(payload));
    return { ...result, version: this.version, axes: axes.map((a) => a.id) };
  }

  // 代入自由参数（不修改系统）
  substitute(params: Record<string, unknown>): { values: Record<string, string>; residuals: string[] } {
    const { axes, constraints } = this.buildSystem();
    const solved = this.solve();
    if (solved.status !== 'UNDERDETERMINED') {
      throw new ApiError('NOT_UNDERDETERMINED', `当前状态为 ${solved.status}，无自由参数可代入`);
    }
    const values = solved.solution!.map((x) => x);
    solved.freeCols.forEach((col, k) => {
      const axisId = axes[col].id;
      const p = axisId in params ? parseRat(params[axisId], this.limits.maxDigits) : Rat.zero();
      for (let j = 0; j < values.length; j++) {
        values[j] = values[j].add(p.mul(solved.directions![k][j]));
      }
    });
    const residuals = constraints.map((c) =>
      c.coeffs.reduce((acc, a, j) => acc.add(a.mul(values[j])), Rat.zero().sub(c.rhs)));
    const out: Record<string, string> = {};
    axes.forEach((a, i) => { out[a.id] = values[i].toString(); });
    return { values: out, residuals: residuals.map((x) => x.toString()) };
  }

  snapshot(version: number): unknown {
    const row = this.q(`SELECT payload FROM snapshots WHERE version=?`).get(version) as { payload: string } | undefined;
    if (!row) throw new ApiError('VERSION_NOT_FOUND', `版本不存在或无冻结结果: ${version}`, 404);
    return JSON.parse(row.payload);
  }

  report(): unknown {
    const solved = this.solve();
    const axes = this.axes();
    const lines: Record<string, unknown> = {
      version: solved.version,
      axes: solved.axes,
      rows: this.rows(),
      constraints: this.constraints(),
      status: solved.status,
      rank: solved.rank,
      dof: solved.freeCols.length,
    };
    if (solved.solution) {
      lines.solution = Object.fromEntries(solved.solution.map((v, i) => [
        axes[i].id, { exact: v.toString(), decimal: v.toDecimal() },
      ]));
    }
    if (solved.status === 'UNDERDETERMINED') {
      lines.freeAxes = solved.freeCols.map((c) => axes[c].id);
      lines.directions = solved.directions!.map((d, k) => ({
        freeAxis: axes[solved.freeCols[k]].id,
        vector: Object.fromEntries(d.map((v, i) => [axes[i].id, v.toString()])),
      }));
      lines.particular = lines.solution;
      delete lines.solution;
    }
    if (solved.witness) {
      const { constraints } = this.buildSystem();
      lines.witness = {
        rhs: solved.witness.rhs.toString(),
        combination: constraints
          .map((c, i) => ({ id: c.id, coeff: solved.witness!.coeffs[i].toString() }))
          .filter((x) => x.coeff !== '0'),
      };
    }
    return lines;
  }
}

export function mapError(e: unknown): { code: string; message: string; http: number } {
  if (e instanceof ApiError) return { code: e.code, message: e.message, http: e.http };
  if (e instanceof RatError) return { code: e.code, message: e.message, http: 400 };
  return { code: 'INTERNAL', message: (e as Error).message, http: 500 };
}



