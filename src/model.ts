// 领域模型：轴、行星排、固定转速、锁连；组装方程并联立求解。
import { Rat, rat, ZERO, parseRat, toString as ratStr, toDecimal, BudgetError } from "./rational";
import { LinRow, rref, solutionSet, residuals } from "./linear";

export const LIMITS = {
  maxAxes: 64,
  maxGearsets: 32,
  maxIntDigits: 50,
};

export interface Axis {
  id: string;
  order: number;
}

export interface Gearset {
  id: string;
  ns: number;
  nr: number;
  sun: string;
  ring: string;
  carrier: string;
}

export type Constraint =
  | { kind: "fixed"; id: string; axis: string; value: Rat }
  | { kind: "lock"; id: string; a: string; b: string };

export interface SystemState {
  axes: Axis[];
  gearsets: Gearset[];
  constraints: Constraint[];
}

export interface EquationSource {
  index: number;
  description: string;
  constraintId: string;
}

export interface Equation {
  a: Rat[];
  b: Rat;
  source: EquationSource;
}

export class ValidationError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "ValidationError";
  }
}

export function validateAxisId(id: unknown): string {
  if (typeof id !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
    throw new ValidationError("E_AXIS_ID", "轴 ID 必须是 1-64 位字母数字/下划线/连字符");
  }
  return id;
}

export function validateTeeth(ns: unknown, nr: unknown): { ns: number; nr: number } {
  if (!Number.isSafeInteger(ns) || !Number.isSafeInteger(nr) || (ns as number) <= 0 || (nr as number) <= 0) {
    throw new ValidationError("E_TEETH", "齿数必须是正整数");
  }
  const n = ns as number;
  const r = nr as number;
  if (r <= n) throw new ValidationError("E_TEETH_ORDER", "要求 Nr > Ns");
  if ((r - n) % 2 !== 0) throw new ValidationError("E_TEETH_PARITY", "Nr-Ns 必须是正偶数（行星轮齿数须为整数）");
  return { ns: n, nr: r };
}

export function parseSpeed(input: unknown): Rat {
  try {
    return parseRat(input, LIMITS.maxIntDigits);
  } catch (e) {
    throw new ValidationError("E_SPEED", (e as Error).message);
  }
}

// 组装方程：Willis 关系按共享轴合并系数；固定转速与锁连各为一条线性约束。
export function buildEquations(state: SystemState): Equation[] {
  const idx = new Map(state.axes.map((a, i) => [a.id, i]));
  const n = state.axes.length;
  const equations: Equation[] = [];
  let seq = 0;

  for (const g of state.gearsets) {
    const coeff = new Array<bigint>(n).fill(0n);
    const addTo = (axis: string, v: bigint): void => {
      const i = idx.get(axis);
      if (i === undefined) throw new ValidationError("E_REF", `行星排 ${g.id} 引用了未声明的轴 ${axis}`);
      coeff[i] += v;
    };
    // Ns*ωs + Nr*ωr - (Ns+Nr)*ωc = 0，同一轴多次出现时合并系数
    addTo(g.sun, BigInt(g.ns));
    addTo(g.ring, BigInt(g.nr));
    addTo(g.carrier, -BigInt(g.ns + g.nr));
    equations.push({
      a: coeff.map((c) => rat(c)),
      b: { ...ZERO },
      source: {
        index: seq++,
        constraintId: g.id,
        description: `行星排 ${g.id} Willis: ${g.ns}*ω(${g.sun}) + ${g.nr}*ω(${g.ring}) - ${g.ns + g.nr}*ω(${g.carrier}) = 0`,
      },
    });
  }

  for (const c of state.constraints) {
    const coeff = new Array<bigint>(n).fill(0n);
    if (c.kind === "fixed") {
      const i = idx.get(c.axis);
      if (i === undefined) throw new ValidationError("E_REF", `固定转速引用了未声明的轴 ${c.axis}`);
      coeff[i] = 1n;
      equations.push({
        a: coeff.map((x) => rat(x)),
        b: c.value,
        source: {
          index: seq++,
          constraintId: c.id,
          description: `固定转速 ${c.id}: ω(${c.axis}) = ${ratStr(c.value)}`,
        },
      });
    } else {
      const ia = idx.get(c.a);
      const ib = idx.get(c.b);
      if (ia === undefined || ib === undefined) throw new ValidationError("E_REF", `锁连 ${c.id} 引用了未声明的轴`);
      if (ia === ib) throw new ValidationError("E_LOCK_SELF", `锁连 ${c.id} 两端是同一根轴，无需约束`);
      coeff[ia] = 1n;
      coeff[ib] = -1n;
      equations.push({
        a: coeff.map((x) => rat(x)),
        b: { ...ZERO },
        source: {
          index: seq++,
          constraintId: c.id,
          description: `锁连 ${c.id}: ω(${c.a}) - ω(${c.b}) = 0`,
        },
      });
    }
  }
  return equations;
}

export type SolveStatus = "unique" | "underdetermined" | "inconsistent" | "budget_exceeded";

export interface SolveResult {
  status: SolveStatus;
  version?: number;
  axes: string[];
  rank?: number;
  numEquations: number;
  freeAxes?: string[];
  solution?: { axis: string; exact: string; decimal: string }[];
  particular?: { axis: string; exact: string; decimal: string }[];
  directions?: { freeAxis: string; vector: { axis: string; exact: string }[] }[];
  residuals?: { equation: number; exact: string }[];
  inconsistency?: {
    rhs: string;
    combination: { equation: number; coefficient: string; description: string }[];
  };
  message?: string;
}

export function solve(state: SystemState): SolveResult {
  const axes = state.axes.map((a) => a.id);
  let equations: Equation[];
  try {
    equations = buildEquations(state);
  } catch (e) {
    if (e instanceof BudgetError) {
      return { status: "budget_exceeded", axes, numEquations: 0, message: e.message };
    }
    throw e;
  }
  const n = axes.length;

  const rows: LinRow[] = equations.map((eqn, i) => ({
    a: eqn.a,
    b: eqn.b,
    combo: equations.map((_, k) => (k === i ? { n: 1n, d: 1n } : { ...ZERO })),
  }));

  let res;
  try {
    res = rref(rows, n);
  } catch (e) {
    if (e instanceof BudgetError) {
      return { status: "budget_exceeded", axes, numEquations: equations.length, message: e.message };
    }
    throw e;
  }

  if (res.inconsistency) {
    const { combo, rhs } = res.inconsistency;
    return {
      status: "inconsistent",
      axes,
      rank: res.rank,
      numEquations: equations.length,
      inconsistency: {
        rhs: ratStr(rhs),
        combination: combo
          .map((c, k) => ({ c, k }))
          .filter(({ c }) => c.n !== 0n)
          .map(({ c, k }) => ({
            equation: k,
            coefficient: ratStr(c),
            description: equations[k].source.description,
          })),
      },
    };
  }

  let ss;
  try {
    ss = solutionSet(res, n);
  } catch (e) {
    if (e instanceof BudgetError) {
      return { status: "budget_exceeded", axes, numEquations: equations.length, message: e.message };
    }
    throw e;
  }

  const base = {
    axes,
    rank: res.rank,
    numEquations: equations.length,
    freeAxes: ss.freeVars.map((c) => axes[c]),
  };

  if (ss.freeVars.length === 0) {
    const resids = residuals(equations, ss.particular);
    return {
      status: "unique",
      ...base,
      solution: axes.map((axis, i) => ({
        axis,
        exact: ratStr(ss.particular[i]),
        decimal: toDecimal(ss.particular[i]),
      })),
      residuals: resids.map((r, i) => ({ equation: i, exact: ratStr(r) })),
    };
  }

  return {
    status: "underdetermined",
    ...base,
    particular: axes.map((axis, i) => ({
      axis,
      exact: ratStr(ss.particular[i]),
      decimal: toDecimal(ss.particular[i]),
    })),
    directions: ss.freeVars.map((f, k) => ({
      freeAxis: axes[f],
      vector: axes.map((axis, i) => ({ axis, exact: ratStr(ss.directions[k][i]) })),
    })),
  };
}

// 用用户给定的自由参数生成候选解：x = particular + sum param_f * direction_f
export function substitute(
  state: SystemState,
  params: Record<string, unknown>,
): { candidate: { axis: string; exact: string; decimal: string }[]; residuals: { equation: number; exact: string }[] } {
  const solved = solve(state);
  if (solved.status !== "underdetermined") {
    throw new ValidationError("E_NOT_UNDERDETERMINED", `当前系统状态为 ${solved.status}，不能代入自由参数`);
  }
  const equations = buildEquations(state);
  const axes = state.axes.map((a) => a.id);
  const idx = new Map(axes.map((a, i) => [a, i]));
  const x: Rat[] = solved.particular!.map((p) => parseSpeed(p.exact));
  for (const dir of solved.directions!) {
    const pv = params[dir.freeAxis];
    if (pv === undefined) continue;
    const p = parseSpeed(pv);
    for (const comp of dir.vector) {
      const i = idx.get(comp.axis)!;
      const term = parseSpeed(comp.exact);
      x[i] = rat(x[i].n * term.d * p.d + term.n * p.n * x[i].d, x[i].d * term.d * p.d);
    }
  }
  const resids = residuals(equations, x);
  return {
    candidate: axes.map((axis, i) => ({ axis, exact: ratStr(x[i]), decimal: toDecimal(x[i]) })),
    residuals: resids.map((r, i) => ({ equation: i, exact: ratStr(r) })),
  };
}
