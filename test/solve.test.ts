import { test } from "node:test";
import assert from "node:assert/strict";
import { Store } from "../src/store";
import { solve, substitute, buildEquations, SystemState, parseSpeed } from "../src/model";
import { residuals } from "../src/linear";
import { rat, ZERO, add, mul, isZero, setMaxBits, parseRat } from "../src/rational";

function memStore(): Store {
  return new Store(":memory:");
}

function demoState(extraFixed: { axis: string; value: string }[]): SystemState {
  return {
    axes: [
      { id: "S", order: 0 },
      { id: "R", order: 1 },
      { id: "C", order: 2 },
    ],
    gearsets: [{ id: "g1", ns: 20, nr: 60, sun: "S", ring: "R", carrier: "C" }],
    constraints: extraFixed.map((f, i) => ({
      kind: "fixed" as const,
      id: `f${i}`,
      axis: f.axis,
      value: parseSpeed(f.value),
    })),
  };
}

function exactOf(list: { axis: string; exact: string }[], axis: string): string {
  return list.find((x) => x.axis === axis)!.exact;
}

test("演示1：太阳轮1200、齿圈固定 => 行星架300，残差全零", () => {
  const r = solve(demoState([{ axis: "S", value: "1200" }, { axis: "R", value: "0" }]));
  assert.equal(r.status, "unique");
  assert.equal(exactOf(r.solution!, "C"), "300");
  assert.equal(exactOf(r.solution!, "S"), "1200");
  assert.ok(r.residuals!.every((x) => x.exact === "0"));
});

test("演示2：行星架固定、太阳轮1200 => 齿圈 -400", () => {
  const r = solve(demoState([{ axis: "S", value: "1200" }, { axis: "C", value: "0" }]));
  assert.equal(r.status, "unique");
  assert.equal(exactOf(r.solution!, "R"), "-400");
});

test("演示3：两排共轴串联 => 末端行星架 75", () => {
  const state: SystemState = {
    axes: ["S1", "R1", "C1", "R2", "C2"].map((id, i) => ({ id, order: i })),
    gearsets: [
      { id: "g1", ns: 20, nr: 60, sun: "S1", ring: "R1", carrier: "C1" },
      { id: "g2", ns: 20, nr: 60, sun: "C1", ring: "R2", carrier: "C2" },
    ],
    constraints: [
      { kind: "fixed", id: "f1", axis: "S1", value: rat(1200n) },
      { kind: "fixed", id: "f2", axis: "R1", value: rat(0n) },
      { kind: "fixed", id: "f3", axis: "R2", value: rat(0n) },
    ],
  };
  const r = solve(state);
  assert.equal(r.status, "unique");
  assert.equal(exactOf(r.solution!, "C1"), "300");
  assert.equal(exactOf(r.solution!, "C2"), "75");
});

test("欠定：不固定任何轴，给特解与每条自由轴方向，方向独立代入核验", () => {
  const state = demoState([]);
  const r = solve(state);
  assert.equal(r.status, "underdetermined");
  assert.deepEqual(r.freeAxes!, ["R", "C"]);
  assert.equal(r.directions!.length, 2);
  const eqs = buildEquations(state);
  // 特解代入残差为零
  const px = r.particular!.map((p) => parseSpeed(p.exact));
  assert.ok(residuals(eqs, px).every(isZero));
  // 每条方向代入齐次方程残差为零
  for (const d of r.directions!) {
    const v = d.vector.map((c) => parseSpeed(c.exact));
    assert.ok(residuals(eqs, v).every(isZero));
  }
  // 任意参数组合：x = particular + 3*d1 - 7/2*d2 仍满足
  const combo = px.map((p, i) => {
    let acc = p;
    const d1 = parseSpeed(r.directions![0].vector[i].exact);
    const d2 = parseSpeed(r.directions![1].vector[i].exact);
    acc = add(acc, mul(rat(3n), d1));
    acc = add(acc, mul(rat(-7n, 2n), d2));
    return acc;
  });
  assert.ok(residuals(eqs, combo).every(isZero));
});

test("代入自由参数生成候选解，残差为零且不改变自由度", () => {
  const state = demoState([{ axis: "R", value: "0" }]);
  const r = solve(state);
  assert.equal(r.status, "underdetermined");
  assert.equal(r.freeAxes!.length, 1);
  const out = substitute(state, { [r.freeAxes![0]]: "300" });
  assert.ok(out.residuals.every((x) => x.exact === "0"));
  assert.equal(exactOf(out.candidate, "S"), "1200");
  const again = solve(state);
  assert.equal(again.status, "underdetermined");
});

test("重复一致约束不算冲突", () => {
  const state = demoState([
    { axis: "S", value: "1200" },
    { axis: "R", value: "0" },
    { axis: "S", value: "1200" },
  ]);
  const r = solve(state);
  assert.equal(r.status, "unique");
  assert.equal(exactOf(r.solution!, "C"), "300");
});

test("冲突转速：不一致并给出可核验的矛盾组合", () => {
  const state = demoState([
    { axis: "S", value: "100" },
    { axis: "R", value: "0" },
    { axis: "C", value: "0" },
  ]);
  const r = solve(state);
  assert.equal(r.status, "inconsistent");
  const eqs = buildEquations(state);
  // 独立核验：组合系数乘回原方程，左端全零、右端非零
  const n = state.axes.length;
  let lhs = new Array(n).fill(ZERO).map(() => ({ ...ZERO }));
  let rhs = { ...ZERO };
  for (const term of r.inconsistency!.combination) {
    const coeff = parseSpeed(term.coefficient);
    const eqn = eqs[term.equation];
    lhs = lhs.map((x, j) => add(x, mul(coeff, eqn.a[j])));
    rhs = add(rhs, mul(coeff, eqn.b));
  }
  assert.ok(lhs.every(isZero));
  assert.ok(!isZero(rhs));
  assert.equal(rhs.n.toString() + "/" + rhs.d.toString(), r.inconsistency!.rhs.includes("/") ? r.inconsistency!.rhs : r.inconsistency!.rhs + "/1");
});

test("构件锁连：同一排太阳轮与行星架同轴，系数合并", () => {
  const state: SystemState = {
    axes: ["S", "R"].map((id, i) => ({ id, order: i })),
    gearsets: [{ id: "g1", ns: 20, nr: 60, sun: "S", ring: "R", carrier: "S" }],
    constraints: [{ kind: "fixed", id: "f1", axis: "S", value: rat(100n) }],
  };
  const eqs = buildEquations(state);
  // 合并后 Willis 行: (20-80)ωS + 60ωR = 0
  assert.equal(eqs[0].a[0].n, -60n);
  assert.equal(eqs[0].a[1].n, 60n);
  const r = solve(state);
  assert.equal(r.status, "unique");
  assert.equal(exactOf(r.solution!, "R"), "100");
});

test("孤立轴参与自由度解释；锁连约束生效", () => {
  const state: SystemState = {
    axes: ["S", "R", "C", "ISO"].map((id, i) => ({ id, order: i })),
    gearsets: [{ id: "g1", ns: 20, nr: 60, sun: "S", ring: "R", carrier: "C" }],
    constraints: [
      { kind: "fixed", id: "f1", axis: "S", value: rat(1200n) },
      { kind: "fixed", id: "f2", axis: "R", value: rat(0n) },
      { kind: "lock", id: "l1", a: "ISO", b: "C" },
    ],
  };
  const r = solve(state);
  assert.equal(r.status, "unique");
  assert.equal(exactOf(r.solution!, "ISO"), "300");
});

test("分数输入：1/3 与 -2/5 精确求解", () => {
  const state = demoState([{ axis: "S", value: "1/3" }, { axis: "R", value: "-2/5" }]);
  const r = solve(state);
  assert.equal(r.status, "unique");
  // 80*C = 20*(1/3) + 60*(-2/5) = 20/3 - 24 = -52/3 => C = -13/60
  assert.equal(exactOf(r.solution!, "C"), "-13/60");
});

test("预算不足与约束不足状态不同", () => {
  const state = demoState([{ axis: "S", value: "1200" }, { axis: "R", value: "0" }]);
  setMaxBits(8);
  try {
    const r = solve(state);
    assert.equal(r.status, "budget_exceeded");
  } finally {
    setMaxBits(4096);
  }
  const under = solve(demoState([]));
  assert.equal(under.status, "underdetermined");
});

test("持久化：重启后可核对冻结结果；修改生成新版本", () => {
  const fs = require("node:fs") as typeof import("node:fs");
  const os = require("node:os") as typeof import("node:os");
  const path = require("node:path") as typeof import("node:path");
  const tmp = path.join(os.tmpdir(), `planetary-test-${Date.now()}.db`);
  try {
    let store = new Store(tmp);
    store.addAxis("S");
    store.addAxis("R");
    store.addAxis("C");
    store.addGearset({ id: "g1", ns: 20, nr: 60, sun: "S", ring: "R", carrier: "C" });
    store.addFixed("f1", "S", "1200", "1");
    const vLast = store.addFixed("f2", "R", "0", "1");
    assert.equal(vLast.version, 6);
    store.close();
    // 重新打开
    store = new Store(tmp);
    const frozen = store.frozen()!;
    assert.equal(frozen.status, "unique");
    assert.equal(exactOf(frozen.solution!, "C"), "300");
    assert.equal(store.frozen(5)!.status, "underdetermined"); // 历史版本（未固定齿圈前）
    store.close();
  } finally {
    for (const suffix of ["", "-wal", "-shm"]) {
      try {
        fs.rmSync(tmp + suffix, { force: true, maxRetries: 10, retryDelay: 200 });
      } catch {
        // Windows 上 SQLite 文件锁释放有延迟，清理失败不影响测试结果
      }
    }
  }
});

test("幂等：相同幂等键重复请求返回同一响应，失败不覆盖系统", () => {
  const store = memStore();
  const r1 = store.idempotent("k1", () => store.addAxis("S"));
  const r2 = store.idempotent("k1", () => store.addAxis("S"));
  assert.deepEqual(r1, r2);
  assert.equal(store.loadState().axes.length, 1);
  assert.throws(() => store.addAxis("S"), /已存在/);
  assert.equal(store.loadState().axes.length, 1);
  store.close();
});

test("参数校验：齿数、引用、分母、锁连自环", () => {
  const store = memStore();
  store.addAxis("S");
  assert.throws(() => store.addGearset({ id: "g", ns: 60, nr: 20, sun: "S", ring: "S", carrier: "S" }), /Nr > Ns/);
  assert.throws(() => store.addGearset({ id: "g", ns: 20, nr: 61, sun: "S", ring: "S", carrier: "S" }), /正偶数/);
  assert.throws(() => store.addGearset({ id: "g", ns: 20, nr: 60, sun: "S", ring: "X", carrier: "S" }), /未声明的轴/);
  assert.throws(() => parseRat({ num: 1, den: 0 }, 50), /分母/);
  assert.throws(() => store.addLock("l", "S", "S"), /同一根轴/);
  store.close();
});
