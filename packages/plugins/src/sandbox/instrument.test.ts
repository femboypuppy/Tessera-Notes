import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { parse } from 'acorn';
import { describe, expect, it } from 'vitest';
import { instrumentModule, InstrumentError } from './instrument';
import { createRuntimeKit } from './runtime-kit';

/** A fresh realm whose microtasks run inside `runInContext`, under its timeout. */
function realm(guard: string, limitMs: number) {
  const context = vm.createContext({}, { microtaskMode: 'afterEvaluate' });
  const stalls: number[] = [];
  const firstRuns: number[] = [];
  createRuntimeKit().installGuard({
    target: context,
    name: guard,
    limitMs,
    now: () => performance.now(),
    afterTask: (callback) => setImmediate(callback),
    onFirstRun: () => firstRuns.push(1),
    onStall: (elapsed) => stalls.push(elapsed),
  });
  return { context, stalls, firstRuns };
}

/** Runs instrumented code with a short limit. The vm timeout only catches a guard that failed. */
function runGuarded(source: string, limitMs = 50) {
  const { code, guard } = instrumentModule(source);
  const { context, stalls, firstRuns } = realm(guard, limitMs);
  // Not instrumented: handles the rejection a stopped promise chain ends in.
  vm.runInContext('globalThis.settle = (promise) => { promise.catch(() => undefined); };', context);
  const started = performance.now();
  let error: unknown = null;
  try {
    vm.runInContext(code, context, { timeout: 10_000 });
  } catch (caught) {
    error = caught;
  }
  return { error, elapsed: performance.now() - started, stalls, firstRuns };
}

/** The value of a script, run as is and instrumented (with a guard that never trips). */
function bothWays(source: string): [unknown, unknown] {
  const plain = vm.runInContext(source, vm.createContext({}));
  const { code, guard } = instrumentModule(source);
  const { context } = realm(guard, 60_000);
  return [plain, vm.runInContext(code, context)];
}

describe('instrumentModule keeps what code does', () => {
  it.each([
    ['closures', 'const add = (a) => (b) => a + b; add(2)(3)'],
    ['arrow returning an object', 'const make = () => ({ a: 1 }); JSON.stringify(make())'],
    ['arrow returning a sequence', 'let n = 0; const f = () => (n++, n * 10); f() + f()'],
    ['curried arrows without semicolons', 'const c = a => b => d => a + b + d\nc(1)(2)(3)'],
    [
      'nested loops without braces',
      'let out = []; for (let i = 0; i < 3; i++) for (let j = 0; j < 2; j++) out.push(i * j)\nout.join()',
    ],
    [
      'labels and continue',
      "let s = ''; outer: for (const a of [1, 2, 3]) { for (const b in { x: 1, y: 2 }) { if (a === 2) continue outer; s += a + b; } } s",
    ],
    ['do-while without braces', 'let k = 0; do k += 2; while (k < 7) k'],
    ['do-while relying on ASI', 'let k = 0\ndo k++\nwhile (k < 3)\nk'],
    [
      'a loop as the body of an if with an else',
      "let r = ''; if (r === '') while (r.length < 2) r += 'a'; else r = 'no'; r",
    ],
    ['an empty loop body', 'let i = 0; while (i++ < 5); i'],
    ['generators', 'function* gen() { let i = 0; while (i < 3) yield i++; } [...gen()].join()'],
    [
      'classes: fields, static blocks, private members, getters, super in arrows',
      'class A { #x = 1; static y = 2; static { A.z = A.y * 2; } get x() { return this.#x; } m() { return () => this.#x + A.z; } } class B extends A { constructor() { super(); this.w = 3; } m() { return () => super.m()() * 10 + this.w; } } new B().m()()',
    ],
    [
      'templates and regular expressions with braces',
      "const re = /{(\\d+)}/g; `${[1, 2].map((v) => `<${v}>`).join('')}` + '{3}'.replace(re, (_, d) => d * 2)",
    ],
    [
      'optional chaining, nullish and commas in for',
      "let p = null; let q = p?.x ?? 'none'; for (let i = 0, j = 10; i < j; i += 4, j--) q += i; q",
    ],
    ['default parameters', 'function g(a = () => 5) { return a() + 1 } g()'],
    [
      'getters and computed methods',
      "const o = { get v() { return 7 }, ['m' + 1]() { return this.v * 2 } }; o.m1()",
    ],
    [
      'switch in a loop',
      "let z = ''; for (const c of 'abc') switch (c) { case 'b': z += 'B'; break; default: z += c } z",
    ],
    ['division, not a regular expression', 'let a = 10, g = 2, x = a / g / 1; x'],
    ['a labeled block', "lbl: { if (true) break lbl; } 'ok'"],
    [
      'an arrow in a loop body without braces',
      'const fs = []; for (let i = 0; i < 3; i++) fs.push(() => i)\nfs.map((f) => f()).join()',
    ],
  ])('%s', (_name, source) => {
    const [plain, instrumented] = bothWays(source);
    expect(instrumented).toEqual(plain);
  });

  it('adds a guard call at the top, in every function and in every loop', () => {
    const { code, guard } = instrumentModule(
      'export const f = (x) => x;\nfunction g() { for (;;) break; }\nwhile (false) g();',
    );
    expect(guard).toBe('$$tg');
    expect(code).toBe(
      '$$tg();export const f = (x) => ($$tg(),x);\nfunction g() {$$tg(); for (;;) {$$tg();break;} }\nwhile (false) {$$tg();g();}',
    );
  });

  it('keeps a #! line first, and directives in force', () => {
    expect(instrumentModule('#!/usr/bin/env node\nlet a = 1;').code).toBe(
      '#!/usr/bin/env node$$tg();\nlet a = 1;',
    );
    expect(
      instrumentModule("'use strict'\nfunction f() { 'use strict'; 'another'; return 1 }").code,
    ).toBe("'use strict';$$tg();\nfunction f() { 'use strict'; 'another';;$$tg(); return 1 }");
    // A function's directive still applies in a script (modules are always strict).
    expect(bothWays("(function () { 'use strict'; return this === undefined; })()")).toEqual([
      true,
      true,
    ]);
  });

  it('picks a guard name the code never uses, even spelled with escapes', () => {
    expect(instrumentModule('const $$tg = 1, $$tg1 = 2;').guard).toBe('$$tg2');
    // `$$tg` is the identifier $$tg, though the text doesn't contain it.
    const escaped = `${String.fromCharCode(92)}u0024${String.fromCharCode(92)}u0024tg`;
    expect(instrumentModule(`const ${escaped} = () => 1;`).guard).toBe('$$tg1');
    expect(instrumentModule("const text = 'call $$tg';").guard).toBe('$$tg1');
  });

  it('refuses code that does not parse, saying where', () => {
    expect(() => instrumentModule('function (')).toThrow(InstrumentError);
    expect(() => instrumentModule('let x = ;')).toThrow(/\(1:8\)/);
  });
});

describe('instrumented code can always be stopped', () => {
  it.each([
    ['while (true)', 'while (true) {}'],
    ['for (;;) without a body', 'for (;;);'],
    ['do-while', 'do {} while (true)'],
    ['labeled continue', 'spin: for (;;) { continue spin; }'],
    ['an infinite generator', 'for (const x of (function* () { for (;;) yield 1; })()) {}'],
    ['an array growing as it is read', 'const list = [1]; for (const x of list) list.push(x);'],
    [
      'catching the guard and starting over',
      'for (;;) { try { for (;;) {} } catch (error) { /* try again */ } }',
    ],
    [
      'recursion that catches and recurses again',
      'function f() { try { f(); } catch { f(); } } f();',
    ],
    ['a loop in finally', 'try { for (;;) {} } finally { for (;;) {} }'],
    ['a loop in an arrow', 'const spin = () => { while (true) {} }; spin();'],
    [
      'a promise chain that never ends',
      'const next = () => Promise.resolve().then(next); settle(next());',
    ],
    ['an async loop', 'settle((async () => { for (;;) await null; })());'],
  ])('%s', (_name, source) => {
    const { error, elapsed, stalls, firstRuns } = runGuarded(source);
    expect(String(error ?? '')).not.toMatch(/timed out/);
    // Promise loops end in a rejected promise, not in a thrown error.
    if (error) expect(String(error)).toMatch(/ran for more than 0.05 seconds without a break/);
    expect(stalls).toHaveLength(1);
    expect(elapsed).toBeLessThan(2_000);
    expect(firstRuns).toHaveLength(1);
  });

  it('lets code that takes breaks run as long as it likes', async () => {
    const { code, guard } = instrumentModule(
      'globalThis.ticks = 0; const tick = () => { const until = Date.now() + 20; while (Date.now() < until) {} if (++globalThis.ticks < 6) setTimeout(tick, 0); }; tick();',
    );
    const { context, stalls } = realm(guard, 50);
    context.setTimeout = setTimeout;
    vm.runInContext(code, context);
    await expect.poll(() => context.ticks as number).toBe(6);
    // Six runs of 20 ms each: 120 ms in all, but never 50 ms in one go.
    expect(stalls).toEqual([]);
  });

  it('the guard can be neither replaced nor removed', () => {
    // Plugin code can't know the name in advance, but it can look for it.
    const { code, guard } = instrumentModule(`'use strict';
      const name = Object.getOwnPropertyNames(globalThis).find((key) => key.startsWith('$' + '$'));
      const attempts = [];
      for (const attempt of [
        () => { globalThis[name] = () => undefined; },
        () => { if (!delete globalThis[name]) throw new TypeError('not deleted'); },
        () => { Object.defineProperty(globalThis, name, { value: () => undefined }); },
      ]) {
        try { attempt(); attempts.push('done'); } catch (error) { attempts.push(error.name); }
      }
      attempts.join()`);
    const { context } = realm(guard, 60_000);
    const original: unknown = context[guard];
    expect(vm.runInContext(code, context)).toBe('TypeError,TypeError,TypeError');
    expect(context[guard]).toBe(original);
  });
});

const require = createRequire(import.meta.url);

describe('instrumenting real libraries', () => {
  it('keeps acorn working: instrumented, it reads code exactly like the original', () => {
    const acornSource = readFileSync(require.resolve('acorn'), 'utf8');
    const { code, guard } = instrumentModule(acornSource);
    const { context } = realm(guard, 60_000);
    // Its UMD wrapper puts `acorn` on the global object.
    vm.runInContext(code, context);
    const instrumented = context.acorn as { parse: typeof parse };
    const options = { ecmaVersion: 'latest', sourceType: 'module' } as const;
    for (const sample of [acornSource, readFileSync(require.resolve('fflate'), 'utf8')])
      expect(JSON.stringify(instrumented.parse(sample, options))).toBe(
        JSON.stringify(parse(sample, options)),
      );
    expect(() => instrumented.parse('let x = ;', options)).toThrow('Unexpected token (1:8)');
  }, 60_000);

  it('gives code that still parses, with a guard in every function and loop', () => {
    const folder = `${resolve(import.meta.dirname, '../../node_modules/mermaid/dist/chunks/mermaid.esm.min')}/`;
    const files = readdirSync(folder)
      .filter((name) => name.endsWith('.mjs'))
      .map((name) => `${folder}${name}`)
      .filter((path) => statSync(path).size > 200_000);
    expect(files.length).toBeGreaterThanOrEqual(3);
    for (const file of files) {
      const source = readFileSync(file, 'utf8');
      const { code, guard } = instrumentModule(source);
      let sites = 1;
      const count = (node: unknown): void => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(count);
          return;
        }
        const type = (node as { type?: unknown }).type;
        if (typeof type !== 'string') return;
        if (/Function|^(While|DoWhile|For|ForIn|ForOf)Statement$/.test(type)) sites += 1;
        for (const value of Object.values(node)) count(value);
      };
      count(parse(source, { ecmaVersion: 'latest', sourceType: 'module' }));
      expect(() => parse(code, { ecmaVersion: 'latest', sourceType: 'module' })).not.toThrow();
      expect(code.split(`${guard}()`).length - 1).toBe(sites);
    }
  }, 120_000);
});
