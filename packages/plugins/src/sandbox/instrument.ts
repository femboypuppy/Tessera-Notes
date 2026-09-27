import { parse, type Node } from 'acorn';

/**
 * Makes plugin UI code stoppable.
 *
 * Panels and blocks need the DOM, so they run in sandboxed frames, and Firefox and Chromium
 * without site isolation run those frames on the app's main thread. There, a loop in plugin code
 * would freeze the app, and nothing outside the frame can interrupt it. So the host rewrites the
 * code before it runs: every function and every loop iteration first calls a guard (installed by
 * the frame's runtime, `installGuard` in `runtime-kit.ts`), which throws once the code has run for
 * too long without letting the event loop turn. The guard's first call, at the top of the module,
 * also forbids loading any more code, so everything that runs in the frame went through here.
 *
 * Runs in a worker (`instrument.worker.ts`): parsing a large plugin takes seconds.
 */

/** Plugin code, instrumented. */
export interface InstrumentedCode {
  code: string;
  /** The global function the code calls: a name the original code never uses. */
  guard: string;
}

/** The code can't be parsed (the message is the parser's, with the position). */
export class InstrumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstrumentError';
  }
}

type AnyNode = Node & { [key: string]: unknown };

const LOOPS = new Set([
  'WhileStatement',
  'DoWhileStatement',
  'ForStatement',
  'ForInStatement',
  'ForOfStatement',
]);
const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression']);

/** What to insert where. `close` texts end a wrapper; `order` is the node's place in the walk. */
interface Site {
  at: number;
  kind:
    | 'call'
    | 'call-after-directive'
    | 'open-block'
    | 'close-block'
    | 'open-expression'
    | 'close-expression';
  order: number;
}

const isNode = (value: unknown): value is AnyNode =>
  typeof value === 'object' && value !== null && typeof (value as AnyNode).type === 'string';

const isClose = (site: Site) => site.kind === 'close-block' || site.kind === 'close-expression';

/**
 * Sorts insertions by position. At the same position, closing texts come first (they end
 * something before it), then opening ones; nested wrappers close inner first and open outer first.
 */
function compareSites(a: Site, b: Site): number {
  if (a.at !== b.at) return a.at - b.at;
  const aClose = isClose(a);
  if (aClose !== isClose(b)) return aClose ? -1 : 1;
  return aClose ? b.order - a.order : a.order - b.order;
}

/** A global name that no identifier of the code uses and that its text doesn't contain. */
function pickGuardName(source: string, identifiers: ReadonlySet<string>): string {
  for (let index = 0; ; index += 1) {
    const name = index === 0 ? '$$tg' : `$$tg${index}`;
    if (!identifiers.has(name) && !source.includes(name)) return name;
  }
}

/** Where code can go at the top of the module: after a `#!` line, if there is one. */
function prologueAt(source: string): number {
  if (!source.startsWith('#!')) return 0;
  for (let index = 2; index < source.length; index += 1) {
    // Line terminators: \n, \r, and the line and paragraph separators.
    const code = source.charCodeAt(index);
    if (code === 0x0a || code === 0x0d || code === 0x2028 || code === 0x2029) return index;
  }
  return source.length;
}

/** The last directive (`'use strict'`) at the start of a body, which a guard call must follow. */
function lastDirective(statements: unknown): AnyNode | null {
  let last: AnyNode | null = null;
  if (!Array.isArray(statements)) return last;
  for (const statement of statements) {
    if (!isNode(statement) || typeof statement.directive !== 'string') break;
    last = statement;
  }
  return last;
}

/**
 * Instruments an ES module: a guard call at the top of the module, at the start of every function
 * body (arrow functions with an expression body get `(guard(), expression)`), and at the start of
 * every loop body (a body that isn't a block is wrapped in one). Throws {@link InstrumentError}
 * when the code doesn't parse.
 */
export function instrumentModule(source: string): InstrumentedCode {
  let program: AnyNode;
  try {
    program = parse(source, {
      ecmaVersion: 'latest',
      sourceType: 'module',
      allowHashBang: true,
    }) as unknown as AnyNode;
  } catch (error) {
    throw new InstrumentError(error instanceof Error ? error.message : String(error));
  }

  const topDirective = lastDirective(program.body);
  const sites: Site[] = [
    topDirective
      ? { at: topDirective.end, kind: 'call-after-directive', order: 0 }
      : { at: prologueAt(source), kind: 'call', order: 0 },
  ];
  const identifiers = new Set<string>();
  // Depth-first, parents before children, so `order` grows with nesting along any path.
  const stack: AnyNode[] = [program];
  let order = 0;
  const guardBody = (body: AnyNode, expression: boolean) => {
    order += 1;
    if (body.type === 'BlockStatement') {
      const directive = lastDirective(body.body);
      sites.push(
        directive
          ? { at: directive.end, kind: 'call-after-directive', order }
          : { at: body.start + 1, kind: 'call', order },
      );
    } else if (expression) {
      sites.push({ at: body.start, kind: 'open-expression', order });
      sites.push({ at: body.end, kind: 'close-expression', order });
    } else {
      sites.push({ at: body.start, kind: 'open-block', order });
      sites.push({ at: body.end, kind: 'close-block', order });
    }
  };
  for (let node = stack.pop(); node; node = stack.pop()) {
    if (node.type === 'Identifier') identifiers.add(node.name as string);
    else if (FUNCTIONS.has(node.type)) guardBody(node.body as AnyNode, true);
    else if (LOOPS.has(node.type)) guardBody(node.body as AnyNode, false);
    const children: AnyNode[] = [];
    for (const key in node) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const item of value) if (isNode(item)) children.push(item);
      } else if (isNode(value)) children.push(value);
    }
    // Reversed onto the stack, so children are visited in source order.
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const child = children[index];
      if (child) stack.push(child);
    }
  }

  const guard = pickGuardName(source, identifiers);
  const text: Record<Site['kind'], string> = {
    call: `${guard}();`,
    // A directive may end without a semicolon.
    'call-after-directive': `;${guard}();`,
    'open-block': `{${guard}();`,
    'close-block': '}',
    'open-expression': `(${guard}(),`,
    'close-expression': ')',
  };
  sites.sort(compareSites);
  const parts: string[] = [];
  let last = 0;
  for (const site of sites) {
    parts.push(source.slice(last, site.at), text[site.kind]);
    last = site.at;
  }
  parts.push(source.slice(last));
  return { code: parts.join(''), guard };
}
