import { Rat } from './rational';

export interface LinConstraint {
  id: string;
  kind: string;
  coeffs: Rat[];   // 长度 = 轴数
  rhs: Rat;
  note?: string;
}

export type SolveStatus = 'UNIQUE' | 'UNDERDETERMINED' | 'INCONSISTENT' | 'BUDGET_EXCEEDED';

export interface SolveResult {
  status: SolveStatus;
  rank: number;
  numVars: number;
  freeCols: number[];
  pivotCols: number[];
  solution?: Rat[];            // 唯一解或特解（自由变量置零）
  directions?: Rat[][];        // 每个自由变量一条齐次方向
  residuals?: Rat[];           // 唯一解时代入每条原约束的残差（全零）
  witness?: { coeffs: Rat[]; rhs: Rat };  // 原约束的线性组合 => 0 = rhs != 0
  budgetDetail?: string;
}

export class BudgetExceeded extends Error {}

// 精确行最简消元，跟踪每行由原约束的线性组合构成。
export function solveSystem(
  constraints: LinConstraint[],
  numVars: number,
  maxBits: number,
): SolveResult {
  const m = constraints.length;
  const check = (r: Rat) => {
    if (r.maxBits() > maxBits) throw new BudgetExceeded(`fraction bits > ${maxBits}`);
  };
  // 工作行: [系数..., rhs] + 组合系数（长度 m）
  const rows: Rat[][] = [];
  const combos: Rat[][] = [];
  for (let i = 0; i < m; i++) {
    const c = constraints[i];
    const row = [...c.coeffs, c.rhs];
    row.forEach(check);
    rows.push(row);
    combos.push(Array.from({ length: m }, (_, j) => (j === i ? Rat.one() : Rat.zero())));
  }
  const pivotCols: number[] = [];
  const pivotRows: number[] = [];
  let r = 0;
  for (let col = 0; col < numVars && r < rows.length; col++) {
    // 确定主元策略：列内第一个非零行
    let piv = -1;
    for (let i = r; i < rows.length; i++) {
      if (!rows[i][col].isZero()) { piv = i; break; }
    }
    if (piv === -1) continue;
    [rows[r], rows[piv]] = [rows[piv], rows[r]];
    [combos[r], combos[piv]] = [combos[piv], combos[r]];
    const pv = rows[r][col];
    for (let j = col; j <= numVars; j++) { rows[r][j] = rows[r][j].div(pv); check(rows[r][j]); }
    combos[r] = combos[r].map((x) => { const y = x.div(pv); check(y); return y; });
    for (let i = 0; i < rows.length; i++) {
      if (i === r || rows[i][col].isZero()) continue;
      const f = rows[i][col];
      for (let j = col; j <= numVars; j++) {
        rows[i][j] = rows[i][j].sub(f.mul(rows[r][j])); check(rows[i][j]);
      }
      combos[i] = combos[i].map((x, k) => { const y = x.sub(f.mul(combos[r][k])); check(y); return y; });
    }
    pivotCols.push(col);
    pivotRows.push(r);
    r++;
  }
  // 不一致检测：系数全零但 rhs 非零
  for (let i = 0; i < rows.length; i++) {
    const allZero = rows[i].slice(0, numVars).every((x) => x.isZero());
    if (allZero && !rows[i][numVars].isZero()) {
      return {
        status: 'INCONSISTENT', rank: pivotCols.length, numVars,
        freeCols: [], pivotCols,
        witness: { coeffs: combos[i], rhs: rows[i][numVars] },
      };
    }
  }
  const pivotSet = new Set(pivotCols);
  const freeCols: number[] = [];
  for (let c = 0; c < numVars; c++) if (!pivotSet.has(c)) freeCols.push(c);
  // 特解：自由变量 = 0
  const particular = Array.from({ length: numVars }, () => Rat.zero());
  for (let k = 0; k < pivotCols.length; k++) particular[pivotCols[k]] = rows[pivotRows[k]][numVars];
  // 每个自由变量一条齐次方向
  const directions = freeCols.map((fc) => {
    const dir = Array.from({ length: numVars }, () => Rat.zero());
    dir[fc] = Rat.one();
    for (let k = 0; k < pivotCols.length; k++) dir[pivotCols[k]] = rows[pivotRows[k]][fc].neg();
    return dir;
  });
  const status: SolveStatus = freeCols.length === 0 ? 'UNIQUE' : 'UNDERDETERMINED';
  const result: SolveResult = {
    status, rank: pivotCols.length, numVars, freeCols, pivotCols,
    solution: particular, directions,
  };
  if (status === 'UNIQUE') {
    result.residuals = constraints.map((c) =>
      c.coeffs.reduce((acc, a, j) => acc.add(a.mul(particular[j])), Rat.zero().sub(c.rhs)));
  }
  return result;
}
