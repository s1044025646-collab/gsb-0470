// 小规模精确线性消元：BigInt 有理数，按列顺序确定主元，跟踪每行作为原约束的线性组合。
import { Rat, ZERO, rat, add, sub, mul, div, neg, isZero } from "./rational";

export interface LinRow {
  a: Rat[]; // 未知数系数
  b: Rat; // 右端
  combo: Rat[]; // 该行 = sum combo[k] * 原约束[k]
}

export interface RrefResult {
  rows: LinRow[]; // 已化为最简行阶梯（含零行，零行保留 combo 用于矛盾见证）
  pivotCols: number[]; // 每行主元列（零行为 -1）
  rank: number;
  inconsistency: { rowIndex: number; combo: Rat[]; rhs: Rat } | null;
}

function cloneRow(r: LinRow): LinRow {
  return { a: r.a.map((x) => ({ ...x })), b: { ...r.b }, combo: r.combo.map((x) => ({ ...x })) };
}

function rowOp(target: LinRow, src: LinRow, factor: Rat): void {
  // target -= factor * src
  for (let j = 0; j < target.a.length; j++) {
    target.a[j] = sub(target.a[j], mul(factor, src.a[j]));
  }
  target.b = sub(target.b, mul(factor, src.b));
  for (let k = 0; k < target.combo.length; k++) {
    target.combo[k] = sub(target.combo[k], mul(factor, src.combo[k]));
  }
}

function scaleRow(target: LinRow, factor: Rat): void {
  for (let j = 0; j < target.a.length; j++) target.a[j] = mul(target.a[j], factor);
  target.b = mul(target.b, factor);
  for (let k = 0; k < target.combo.length; k++) target.combo[k] = mul(target.combo[k], factor);
}

// 对增广矩阵做 Gauss-Jordan 消元，主元策略：按列从左到右，取该列当前行及以下首个非零行。
export function rref(input: LinRow[], numVars: number): RrefResult {
  const rows = input.map(cloneRow);
  const m = rows.length;
  const pivotCols: number[] = new Array(m).fill(-1);
  let rank = 0;
  let inconsistency: RrefResult["inconsistency"] = null;

  let r = 0;
  for (let c = 0; c < numVars && r < m; c++) {
    let piv = -1;
    for (let i = r; i < m; i++) {
      if (!isZero(rows[i].a[c])) {
        piv = i;
        break;
      }
    }
    if (piv === -1) continue;
    [rows[r], rows[piv]] = [rows[piv], rows[r]];
    // 主元归一
    const inv = div(rat(1n), rows[r].a[c]);
    scaleRow(rows[r], inv);
    // 消去其它所有行（直接得到 RREF）
    for (let i = 0; i < m; i++) {
      if (i !== r && !isZero(rows[i].a[c])) {
        rowOp(rows[i], rows[r], rows[i].a[c]);
      }
    }
    pivotCols[r] = c;
    r++;
  }
  rank = r;

  for (let i = 0; i < m; i++) {
    const allZero = rows[i].a.every(isZero);
    if (allZero && !isZero(rows[i].b) && inconsistency === null) {
      inconsistency = { rowIndex: i, combo: rows[i].combo, rhs: rows[i].b };
    }
  }
  return { rows, pivotCols, rank, inconsistency };
}

export interface SolutionSet {
  particular: Rat[]; // 自由变量置零的特解
  directions: Rat[][]; // 每个自由变量一条齐次方向（长度为未知数个数）
  freeVars: number[]; // 自由变量列下标
}

// 由 RREF 结果构造特解与零空间基（仅在不一致不存在时调用）
export function solutionSet(res: RrefResult, numVars: number): SolutionSet {
  const pivotOfCol = new Map<number, number>();
  for (let i = 0; i < res.rank; i++) pivotOfCol.set(res.pivotCols[i], i);
  const freeVars: number[] = [];
  for (let c = 0; c < numVars; c++) if (!pivotOfCol.has(c)) freeVars.push(c);

  const particular: Rat[] = new Array(numVars).fill(ZERO).map(() => ({ ...ZERO }));
  for (let i = 0; i < res.rank; i++) {
    particular[res.pivotCols[i]] = { ...res.rows[i].b };
  }

  const directions: Rat[][] = [];
  for (const f of freeVars) {
    const dir: Rat[] = new Array(numVars).fill(ZERO).map(() => ({ ...ZERO }));
    dir[f] = { n: 1n, d: 1n };
    for (let i = 0; i < res.rank; i++) {
      // 主元行：x_p + sum a_ij x_j = b_i => 方向分量 = -a_if
      dir[res.pivotCols[i]] = neg(res.rows[i].a[f]);
    }
    directions.push(dir);
  }
  return { particular, directions, freeVars };
}

// 独立核验：把解向量代回原方程，返回每条方程的精确残差 lhs - rhs
export function residuals(equations: { a: Rat[]; b: Rat }[], x: Rat[]): Rat[] {
  return equations.map((eqn) => {
    let acc: Rat = { ...ZERO };
    for (let j = 0; j < eqn.a.length; j++) acc = add(acc, mul(eqn.a[j], x[j]));
    return sub(acc, eqn.b);
  });
}
