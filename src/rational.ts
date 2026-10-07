// 既约分数：分母恒正，0 表示为 0/1。全部使用 BigInt，绝不转浮点判秩。
export interface Rat {
  n: bigint;
  d: bigint;
}

export class BudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetError";
  }
}

// 中间分数分子/分母允许的最大比特数，超限抛 BudgetError（对应状态 budget_exceeded）
export let MAX_BITS = 4096;
export function setMaxBits(bits: number): void {
  MAX_BITS = bits;
}

function bitLength(x: bigint): number {
  return x < 0n ? (-x).toString(2).length : x.toString(2).length;
}

function checkBudget(x: bigint): void {
  if (bitLength(x) > MAX_BITS) {
    throw new BudgetError(`中间分数超出计算预算（>${MAX_BITS} bit）`);
  }
}

export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) {
    const t = a % b;
    a = b;
    b = t;
  }
  return a === 0n ? 1n : a;
}

export function rat(n: bigint, d: bigint = 1n): Rat {
  if (d === 0n) throw new Error("分母不能为零");
  if (d < 0n) {
    n = -n;
    d = -d;
  }
  if (n === 0n) return { n: 0n, d: 1n };
  const g = gcd(n, d);
  const rn = n / g;
  const rd = d / g;
  checkBudget(rn);
  checkBudget(rd);
  return { n: rn, d: rd };
}

export const ZERO: Rat = { n: 0n, d: 1n };
export const ONE: Rat = { n: 1n, d: 1n };

export function add(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d + b.n * a.d, a.d * b.d);
}

export function sub(a: Rat, b: Rat): Rat {
  return rat(a.n * b.d - b.n * a.d, a.d * b.d);
}

export function mul(a: Rat, b: Rat): Rat {
  return rat(a.n * b.n, a.d * b.d);
}

export function div(a: Rat, b: Rat): Rat {
  if (b.n === 0n) throw new Error("除以零分数");
  return rat(a.n * b.d, a.d * b.n);
}

export function neg(a: Rat): Rat {
  return { n: -a.n, d: a.d };
}

export function isZero(a: Rat): boolean {
  return a.n === 0n;
}

export function eq(a: Rat, b: Rat): boolean {
  return a.n === b.n && a.d === b.d;
}

export function toString(a: Rat): string {
  return a.d === 1n ? a.n.toString() : `${a.n}/${a.d}`;
}

export function toDecimal(a: Rat, digits = 6): string {
  const negSign = a.n < 0n ? "-" : "";
  const abs = a.n < 0n ? -a.n : a.n;
  const ip = abs / a.d;
  let rem = abs % a.d;
  if (rem === 0n) return negSign + ip.toString();
  let frac = "";
  for (let i = 0; i < digits && rem !== 0n; i++) {
    rem *= 10n;
    frac += (rem / a.d).toString();
    rem %= a.d;
  }
  return `${negSign}${ip}.${frac}`;
}

// 解析用户输入：有符号整数字符串、"n/d" 字符串，或 {num, den} 对象（数字或字符串）
export function parseRat(input: unknown, maxDigits: number): Rat {
  const checkDigits = (s: string): void => {
    const digits = s.replace(/^-/, "").replace(/^0+/, "");
    if (digits.length > maxDigits) {
      throw new Error(`整数位数超限（>${maxDigits} 位）`);
    }
  };
  const parseInt_ = (v: unknown, what: string): bigint => {
    if (typeof v === "number") {
      if (!Number.isSafeInteger(v)) throw new Error(`${what} 必须是安全整数或用字符串表示`);
      return BigInt(v);
    }
    if (typeof v === "string") {
      if (!/^-?\d+$/.test(v)) throw new Error(`${what} 必须是有符号整数字符串`);
      checkDigits(v);
      return BigInt(v);
    }
    if (typeof v === "bigint") return v;
    throw new Error(`${what} 类型非法`);
  };
  if (typeof input === "object" && input !== null) {
    const o = input as Record<string, unknown>;
    const num = parseInt_(o.num ?? o.numerator, "分子");
    const den = parseInt_(o.den ?? o.denominator ?? 1, "分母");
    if (den === 0n) throw new Error("分母不能为零");
    return rat(num, den);
  }
  if (typeof input === "string") {
    const m = input.trim().match(/^(-?\d+)(?:\/(-?\d+))?$/);
    if (!m) throw new Error("转速必须是有符号整数或 n/d 分数字符串");
    const num = parseInt_(m[1], "分子");
    const den = m[2] !== undefined ? parseInt_(m[2], "分母") : 1n;
    if (den === 0n) throw new Error("分母不能为零");
    return rat(num, den);
  }
  if (typeof input === "number") {
    if (!Number.isSafeInteger(input)) throw new Error("数值转速必须是安全整数，分数请用字符串或对象");
    return rat(BigInt(input));
  }
  throw new Error("无法解析的转速输入");
}
