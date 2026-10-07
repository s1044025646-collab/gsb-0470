import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GearStore } from '../src/store';
import { Rat } from '../src/rational';

// 独立核对器：不经过 store 的求解结果结构，直接用 BigInt 分数重算残差
function frac(n: bigint, d: bigint): [bigint, bigint] {
  if (d < 0n) { n = -n; d = -d; }
  let a = n < 0n ? -n : n, b = d;
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  const g = a === 0n ? 1n : a;
  return [n / g, d / g];
}
function parse(s: string): [bigint, bigint] {
  const [n, d] = s.split('/');
  return frac(BigInt(n), BigInt(d ?? '1'));
}
// 用原始定义独立重算每条约束的残差（不读 store 的 coeffs 字符串）
function independentResiduals(store: GearStore, values: Record<string, string>): bigint[] {
  const res: bigint[] = [];
  for (const row of store.rows()) {
    // Ns*ws + Nr*wr - (Ns+Nr)*wc，通分后只检查分子是否为零
    const terms: [bigint, bigint][] = [
      [BigInt(row.ns) * parse(values[row.sun])[0], parse(values[row.sun])[1]],
      [BigInt(row.nr) * parse(values[row.ring])[0], parse(values[row.ring])[1]],
      [-BigInt(row.ns + row.nr) * parse(values[row.carrier])[0], parse(values[row.carrier])[1]],
    ];
    let num = 0n, den = 1n;
    for (const [n, d] of terms) { num = num * d + n * den; den = den * d; }
    res.push(num);
  }
  for (const c of store.constraints()) {
    if (c.kind === 'fixed') {
      const [vn, vd] = parse(values[c.axis!]);
      const [rn, rd] = parse(c.value!);
      res.push(vn * rd - rn * vd);
    } else {
      const [an, ad] = parse(values[c.a!]);
      const [bn, bd] = parse(values[c.b!]);
      res.push(an * bd - bn * ad);
    }
  }
  return res;
}

function demoStore(): GearStore {
  const s = new GearStore(':memory:');
  for (const a of ['S', 'R', 'C']) s.addAxis(a);
  s.addRow({ Ns: 20, Nr: 60, sun: 'S', ring: 'R', carrier: 'C' });
  return s;
}

test('演示1: 太阳轮1200、齿圈固定 => 行星架300', () => {
  const s = demoStore();
  s.addFixed('S', '1200');
  s.addFixed('R', '0');
  const r = s.solve();
  assert.equal(r.status, 'UNIQUE');
  const vals = Object.fromEntries(r.axes.map((a, i) => [a, r.solution![i].toString()]));
  assert.deepEqual(vals, { S: '1200', R: '0', C: '300' });
  assert.ok(r.residuals!.every((x) => x.isZero()));
  assert.ok(independentResiduals(s, vals).every((n) => n === 0n));
});

test('演示2: 行星架固定 => 齿圈 -400', () => {
  const s = demoStore();
  s.addFixed('S', '1200');
  s.addFixed('C', '0');
  const r = s.solve();
  assert.equal(r.status, 'UNIQUE');
  const vals = Object.fromEntries(r.axes.map((a, i) => [a, r.solution![i].toString()]));
  assert.equal(vals.R, '-400');
  assert.ok(independentResiduals(s, vals).every((n) => n === 0n));
});

test('演示3: 两排串联共轴 => 末端行星架75', () => {
  const s = new GearStore(':memory:');
  for (const a of ['S1', 'R1', 'C1S2', 'R2', 'C2']) s.addAxis(a);
  s.addRow({ Ns: 20, Nr: 60, sun: 'S1', ring: 'R1', carrier: 'C1S2' });
  s.addRow({ Ns: 20, Nr: 60, sun: 'C1S2', ring: 'R2', carrier: 'C2' });
  s.addFixed('S1', '1200');
  s.addFixed('R1', '0');
  s.addFixed('R2', '0');
  const r = s.solve();
  assert.equal(r.status, 'UNIQUE');
  const vals = Object.fromEntries(r.axes.map((a, i) => [a, r.solution![i].toString()]));
  assert.equal(vals.C1S2, '300');
  assert.equal(vals.C2, '75');
  assert.ok(independentResiduals(s, vals).every((n) => n === 0n));
});

test('欠定: 不固定任何轴，自由度=2，方向与特解均满足约束', () => {
  const s = demoStore();
  const r = s.solve();
  assert.equal(r.status, 'UNDERDETERMINED');
  assert.equal(r.freeCols.length, 2);
  // 独立核对每条齐次方向：代入原约束残差为零
  for (const dir of r.directions!) {
    const vals = Object.fromEntries(r.axes.map((a, i) => [a, dir[i].toString()]));
    assert.ok(independentResiduals(s, vals).every((n) => n === 0n));
  }
  // 代入自由参数
  const sub = s.substitute({ R: '0', C: '300' });
  assert.equal(sub.values.S, '1200');
  assert.ok(sub.residuals.every((x) => x === '0'));
  assert.ok(independentResiduals(s, sub.values).every((n) => n === 0n));
  // 代入后原系统自由度不变
  assert.equal(s.solve().freeCols.length, 2);
});

test('孤立轴参与自由度解释', () => {
  const s = demoStore();
  s.addAxis('IDLE');
  const r = s.solve();
  assert.equal(r.status, 'UNDERDETERMINED');
  assert.equal(r.freeCols.length, 3);
  assert.ok(r.freeCols.map((c) => r.axes[c]).includes('IDLE'));
});

test('重复一致约束不算冲突', () => {
  const s = demoStore();
  s.addFixed('S', '1200');
  s.addFixed('S', '1200');
  s.addFixed('R', '0');
  const r = s.solve();
  assert.equal(r.status, 'UNIQUE');
  // 幂等：重复导入不产生新约束
  assert.equal(s.constraints().filter((c) => c.kind === 'fixed').length, 2);
});

test('冲突转速 => INCONSISTENT，见证组合代回可核验', () => {
  const s = demoStore();
  s.addFixed('S', '1200');
  s.addFixed('S', '1300');
  const r = s.solve();
  assert.equal(r.status, 'INCONSISTENT');
  assert.ok(r.witness);
  // 独立核验：组合系数加权的左端全为零、右端非零
  const { constraints } = s.buildSystem();
  const w = r.witness!;
  const numVars = r.numVars;
  for (let j = 0; j < numVars; j++) {
    let acc = Rat.zero();
    constraints.forEach((c, i) => { acc = acc.add(w.coeffs[i].mul(c.coeffs[j])); });
    assert.ok(acc.isZero(), `col ${j} should cancel`);
  }
  let rhs = Rat.zero();
  constraints.forEach((c, i) => { rhs = rhs.add(w.coeffs[i].mul(c.rhs)); });
  assert.ok(!rhs.isZero());
  assert.equal(rhs.toString(), w.rhs.toString());
});

test('构件锁连: 同一排太阳轮与行星架同轴 => 齿圈同速', () => {
  const s = new GearStore(':memory:');
  for (const a of ['SR', 'G']) s.addAxis(a);
  s.addRow({ Ns: 20, Nr: 60, sun: 'SR', ring: 'G', carrier: 'SR' });
  s.addFixed('SR', '600');
  const r = s.solve();
  assert.equal(r.status, 'UNIQUE');
  const vals = Object.fromEntries(r.axes.map((a, i) => [a, r.solution![i].toString()]));
  assert.equal(vals.G, '600'); // 整体刚性旋转
  assert.ok(independentResiduals(s, vals).every((n) => n === 0n));
});

test('跨排锁连约束', () => {
  const s = new GearStore(':memory:');
  for (const a of ['S1', 'R1', 'C1', 'OUT']) s.addAxis(a);
  s.addRow({ Ns: 20, Nr: 60, sun: 'S1', ring: 'R1', carrier: 'C1' });
  s.addLock('C1', 'OUT');
  s.addFixed('S1', '1200');
  s.addFixed('R1', '0');
  const r = s.solve();
  assert.equal(r.status, 'UNIQUE');
  const vals = Object.fromEntries(r.axes.map((a, i) => [a, r.solution![i].toString()]));
  assert.equal(vals.OUT, '300');
  assert.ok(independentResiduals(s, vals).every((n) => n === 0n));
});

test('分数输入与展示小数', () => {
  const s = demoStore();
  s.addFixed('S', { num: '2400', den: '2' });
  s.addFixed('R', '0');
  const r = s.solve();
  const vals = Object.fromEntries(r.axes.map((a, i) => [a, r.solution![i]]));
  assert.equal(vals.C.toString(), '300');
  assert.equal(vals.C.toDecimal(), '300');
});

test('齿数校验', () => {
  const s = demoStore();
  assert.throws(() => s.addRow({ Ns: 60, Nr: 20, sun: 'S', ring: 'R', carrier: 'C' }), /Nr > Ns/);
  assert.throws(() => s.addRow({ Ns: 20, Nr: 61, sun: 'S', ring: 'R', carrier: 'C' }), /偶数/);
});

test('修改齿数生成新版本且冻结结果可回查', () => {
  const s = demoStore();
  s.addFixed('S', '1200');
  s.addFixed('R', '0');
  const v1 = s.solve().version;
  s.updateRow(1, { Ns: 30, Nr: 90 });
  const v2 = s.solve().version;
  assert.ok(v2 > v1);
  const snap = s.snapshot(v1) as { result: { solution: string[] } };
  assert.deepEqual(snap.result.solution, ['1200', '0', '300']);
  const vals = Object.fromEntries(s.solve().axes.map((a, i) => [a, s.solve().solution![i].toString()]));
  assert.equal(vals.C, '300'); // 30/90 同比例
});

test('预算不足与约束不足状态不同', () => {
  const s = demoStore();
  s.addFixed('S', '1200');
  assert.equal(s.solve().status, 'UNDERDETERMINED');
  // 构造超大分数触发 BUDGET_EXCEEDED
  const s2 = new GearStore(':memory:', { maxBits: 200 });
  for (const a of ['S', 'R', 'C']) s2.addAxis(a);
  s2.addRow({ Ns: 20, Nr: 60, sun: 'S', ring: 'R', carrier: 'C' });
  s2.addFixed('S', '1'.repeat(50));
  s2.addFixed('R', '0');
  s2.addFixed('C', { num: '1', den: '9'.repeat(50) });
  const r = s2.solve();
  assert.equal(r.status, 'BUDGET_EXCEEDED');
});

test('持久化: 重启后仍可核对冻结结果', () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const p = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'gear-')), 't.db');
  const s1 = new GearStore(p);
  s1.addAxis('S'); s1.addAxis('R'); s1.addAxis('C');
  s1.addRow({ Ns: 20, Nr: 60, sun: 'S', ring: 'R', carrier: 'C' });
  s1.addFixed('S', '1200'); s1.addFixed('R', '0');
  const v = s1.solve().version;
  s1.close();
  const s2 = new GearStore(p);
  const snap = s2.snapshot(v) as { result: { solution: string[]; status: string } };
  assert.equal(snap.result.status, 'UNIQUE');
  assert.deepEqual(snap.result.solution, ['1200', '0', '300']);
  s2.close();
});

