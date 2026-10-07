export class Rat {
  readonly n: bigint;
  readonly d: bigint;
  private constructor(n: bigint, d: bigint) {
    this.n = n;
    this.d = d;
  }
  static of(n: bigint | number | string, d: bigint | number | string = 1n): Rat {
    let num = BigInt(n);
    let den = BigInt(d);
    if (den === 0n) throw new RatError('DENOMINATOR_ZERO', 'denominator must not be zero');
    if (den < 0n) { num = -num; den = -den; }
    const g = gcd(abs(num), den);
    return new Rat(num / g, den / g);
  }
  static zero(): Rat { return new Rat(0n, 1n); }
  static one(): Rat { return new Rat(1n, 1n); }
  isZero(): boolean { return this.n === 0n; }
  add(o: Rat): Rat { return Rat.of(this.n * o.d + o.n * this.d, this.d * o.d); }
  sub(o: Rat): Rat { return Rat.of(this.n * o.d - o.n * this.d, this.d * o.d); }
  mul(o: Rat): Rat { return Rat.of(this.n * o.n, this.d * o.d); }
  div(o: Rat): Rat {
    if (o.n === 0n) throw new RatError('DIVIDE_BY_ZERO', 'divide by zero');
    return Rat.of(this.n * o.d, this.d * o.n);
  }
  neg(): Rat { return new Rat(-this.n, this.d); }
  abs(): Rat { return this.n < 0n ? new Rat(-this.n, this.d) : this; }
  toString(): string { return this.d === 1n ? this.n.toString() : `${this.n}/${this.d}`; }
  toDecimal(places = 6): string {
    const neg = this.n < 0n;
    const a = neg ? -this.n : this.n;
    const ip = a / this.d;
    let rem = a % this.d;
    let frac = '';
    for (let i = 0; i < places; i++) {
      rem *= 10n;
      frac += (rem / this.d).toString();
      rem %= this.d;
    }
    frac = frac.replace(/0+$/, '');
    return (neg ? '-' : '') + ip.toString() + (frac ? '.' + frac : '');
  }
  maxBits(): number {
    const bits = (x: bigint) => (x === 0n ? 1 : x.toString(2).length);
    return Math.max(bits(this.n < 0n ? -this.n : this.n), bits(this.d));
  }
}

export class RatError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}

export function gcd(a: bigint, b: bigint): bigint {
  a = a < 0n ? -a : a;
  b = b < 0n ? -b : b;
  while (b !== 0n) { const t = a % b; a = b; b = t; }
  return a === 0n ? 1n : a;
}
function abs(x: bigint): bigint { return x < 0n ? -x : x; }

export function parseRat(v: unknown, maxDigits: number): Rat {
  if (typeof v === 'string') {
    const m = /^([+-]?\d+)(?:\/([+-]?\d+))?$/.exec(v);
    if (!m) throw new RatError('BAD_NUMBER', `bad number: ${v}`);
    if (m[2] !== undefined) return Rat.of(BigInt(m[1]), BigInt(m[2]));
    if (v.replace(/^[+-]/, '').length > maxDigits) throw new RatError('DIGITS_EXCEEDED', 'integer digits exceeded');
    return Rat.of(BigInt(v));
  }
  if (typeof v === 'number' && Number.isSafeInteger(v)) return Rat.of(BigInt(v));
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    const num = o.num, den = o.den;
    if ((typeof num === 'string' || typeof num === 'number') &&
        (typeof den === 'string' || typeof den === 'number')) {
      const n = parseRat(num, maxDigits);
      const d = parseRat(den, maxDigits);
      if (d.isZero()) throw new RatError('DENOMINATOR_ZERO', 'denominator must not be zero');
      return n.div(d);
    }
  }
  throw new RatError('BAD_NUMBER', 'value must be integer string or {num, den}');
}

