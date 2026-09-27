/**
 * Builds `docs/plugins/api.md` from the SDK's TSDoc comments, so the reference can't drift from
 * the code. `api-docs.test.ts` fails when the file is out of date; `write-api-docs.ts` rewrites it.
 *
 * Every export of `@tessera/plugin-api` and `@tessera/plugin-api/testing` must be placed in one of
 * the sections below: a new export without a place in the reference is an error.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const SRC = fileURLToPath(new URL('../src/', import.meta.url));
const ENTRY = `${SRC}index.ts`;
const TESTING_ENTRY = `${SRC}testing/index.ts`;

/** Where the reference is written. */
export const API_DOCS_PATH = fileURLToPath(
  new URL('../../../docs/plugins/api.md', import.meta.url),
);

interface Section {
  title: string;
  intro?: string;
  /** Declarations, in order (exported ones, or local ones that exported types build on). */
  names: string[];
  /** API objects whose methods get their own entry, and how code reaches them (`api.pages`). */
  receivers?: Record<string, string>;
}

const SECTIONS: Section[] = [
  {
    title: 'Defining a plugin',
    intro:
      'A plugin module’s default export is `definePlugin({ … })`. `activate` runs in a background worker; `panels` and `blocks` render in their own sandboxed frames.',
    names: [
      'definePlugin',
      'PluginDefinition',
      'defineBlock',
      'PanelRenderer',
      'BlockRenderer',
      'Cleanup',
      'PanelContext',
      'BlockContext',
      'BlockState',
      'DefinedPlugin',
      'isPluginDefinition',
      'PLUGIN_DEFINITION_MARKER',
    ],
  },
  {
    title: 'The api object',
    intro:
      '`activate(api)` receives it, and panels and blocks get the same object as `ctx.api`. Each call is checked against the permissions the user granted, by the host, every time.',
    names: ['PluginApi', 'PluginInfo', 'PluginSurface', 'Unsubscribe'],
  },
  {
    title: 'Commands',
    names: ['CommandsApi', 'CommandDefinition', 'CommandRunContext'],
    receivers: { CommandsApi: 'api.commands' },
  },
  {
    title: 'Panels, blocks and notifications',
    names: ['UiApi', 'PanelOptions', 'BlockOptions', 'NotifyOptions'],
    receivers: { UiApi: 'api.ui' },
  },
  {
    title: 'Renderers',
    intro:
      'Plugin API 2. Heavy drawing code (a diagram or chart library) goes in a second module, named by `renderer` in the manifest. It loads once, in a hidden frame shared by the plugin’s panels and blocks, which call it with `api.ui.render`.',
    names: [
      'defineRenderer',
      'RenderFunction',
      'RenderFunctions',
      'DefinedRenderer',
      'isRendererDefinition',
      'RENDERER_DEFINITION_MARKER',
    ],
  },
  {
    title: 'Pages',
    names: [
      'PagesApi',
      'PageInfo',
      'PageContent',
      'ContentFormat',
      'ListPagesOptions',
      'CreatePageInput',
      'UpdatePageInput',
      'PageChangeEvent',
    ],
    receivers: { PagesApi: 'api.pages' },
  },
  {
    title: 'Databases',
    names: [
      'DatabasesApi',
      'DatabaseInfo',
      'DatabaseSchema',
      'DatabaseProperty',
      'DatabasePropertyType',
      'DatabaseSelectOption',
      'DatabaseView',
      'DatabaseRow',
      'DatabaseQuery',
      'RowFilter',
      'RowSort',
      'DatabaseQueryResult',
      'RowInput',
    ],
    receivers: { DatabasesApi: 'api.databases' },
  },
  {
    title: 'Storage',
    names: ['StorageApi'],
    receivers: { StorageApi: 'api.storage' },
  },
  {
    title: 'Settings',
    intro:
      'Declare settings in `definePlugin({ settings })`: Tessera renders the form in Settings → Plugins, validates what the user enters, and types `api.settings.get` from the schema.',
    names: [
      'SettingsApi',
      'SettingsSchema',
      'SettingDefinition',
      'SettingBase',
      'StringSetting',
      'NumberSetting',
      'BooleanSetting',
      'SelectSetting',
      'SelectSettingOption',
      'SettingValue',
      'SettingsValues',
    ],
    receivers: { SettingsApi: 'api.settings' },
  },
  {
    title: 'Theme',
    names: ['ThemeApi', 'ThemeInfo'],
    receivers: { ThemeApi: 'api.theme' },
  },
  {
    title: 'Documents and JSON',
    names: ['DocJSON', 'DocNode', 'DocMark', 'JsonValue', 'JsonObject'],
  },
  {
    title: 'Errors',
    names: ['PluginError', 'PluginErrorCode', 'isPluginError', 'isPluginErrorCode'],
  },
  {
    title: 'Permissions and IDs',
    names: [
      'PLUGIN_API_VERSION',
      'PLUGIN_PERMISSIONS',
      'PluginPermission',
      'StaticPluginPermission',
      'NetworkPermission',
      'PLUGIN_ID_PATTERN',
      'PLUGIN_ITEM_ID_PATTERN',
    ],
  },
  {
    title: 'Testing',
    names: [
      'createTestHarness',
      'TestHarnessOptions',
      'TestHarness',
      'HarnessPageInput',
      'HarnessDatabaseInput',
      'HarnessWorkspace',
      'RenderedPanel',
      'RenderedBlock',
      'SettingPrimitive',
      'markdownToDoc',
      'docToMarkdown',
    ],
  },
];

/** Exports of the testing entry that are documented elsewhere (re-exported for convenience). */
const REEXPORTED_IN_TESTING = new Set(['PluginError']);

interface Doc {
  text: string;
  examples: string[];
}

/** Splits a `/** … *\/` comment into its description and `@example` blocks. */
function parseDoc(raw: string): Doc {
  const lines = raw
    .replace(/^\/\*\*[ \t]*/, '')
    .replace(/\s*\*\/$/, '')
    .split('\n')
    .map((line) => line.replace(/^\s*\* ?/, '').replace(/\s+$/, ''));
  const text: string[] = [];
  const examples: string[][] = [];
  let current: string[] = text;
  for (const line of lines) {
    const tag = /^@(\w+)\s*(.*)$/.exec(line);
    if (tag?.[1] === 'example') {
      current = [];
      examples.push(current);
      if (tag[2]) current.push(tag[2]);
    } else current.push(line);
  }
  const trim = (block: string[]) => block.join('\n').replace(/^\n+|\n+$/g, '');
  return { text: trim(text), examples: examples.map(trim).filter(Boolean) };
}

/** The last doc comment right before `node`, if any. */
function docOf(node: ts.Node, source: ts.SourceFile): Doc | null {
  const ranges = ts.getLeadingCommentRanges(source.text, node.getFullStart()) ?? [];
  const range = ranges.filter((candidate) => source.text.startsWith('/**', candidate.pos)).pop();
  return range ? parseDoc(source.text.slice(range.pos, range.end)) : null;
}

/** GitHub-style heading anchor. */
function slug(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9 _-]/g, '')
    .replace(/ /g, '-');
}

interface Entry {
  name: string;
  node: ts.Node;
  source: ts.SourceFile;
}

class Reference {
  private readonly program = ts.createProgram([ENTRY, TESTING_ENTRY], {
    target: ts.ScriptTarget.ESNext,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
  });
  private readonly checker = this.program.getTypeChecker();
  /** Every top-level declaration of the SDK's source files, by name. */
  private readonly declarations = new Map<string, Entry>();
  /** Anchors that `{@link Name}` and `{@link Name.member}` resolve to. */
  private readonly anchors = new Map<string, string>();

  constructor() {
    for (const source of this.program.getSourceFiles()) {
      if (!source.fileName.startsWith(SRC.replaceAll('\\', '/')) || source.isDeclarationFile)
        continue;
      for (const statement of source.statements) {
        const names = ts.isVariableStatement(statement)
          ? statement.declarationList.declarations.map((declaration) =>
              declaration.name.getText(source),
            )
          : 'name' in statement && statement.name && ts.isIdentifier(statement.name as ts.Node)
            ? [(statement.name as ts.Identifier).text]
            : [];
        for (const name of names)
          if (!this.declarations.has(name))
            this.declarations.set(name, { name, node: statement, source });
      }
    }
  }

  /** Names exported by an entry module. */
  exportsOf(file: string): string[] {
    const source = this.program.getSourceFile(file);
    const symbol = source && this.checker.getSymbolAtLocation(source);
    return symbol ? this.checker.getExportsOfModule(symbol).map((item) => item.name) : [];
  }

  moduleDoc(file: string): Doc | null {
    const text = readFileSync(file, 'utf8');
    const match = /^\/\*\*[\s\S]*?\*\//.exec(text);
    return match ? parseDoc(match[0]) : null;
  }

  entry(name: string): Entry {
    const entry = this.declarations.get(name);
    if (!entry) throw new Error(`No declaration named ${name} in packages/plugin-api/src`);
    return entry;
  }

  build(): string {
    const placed = new Set(SECTIONS.flatMap((section) => section.names));
    const exported = [
      ...this.exportsOf(ENTRY),
      ...this.exportsOf(TESTING_ENTRY).filter((name) => !REEXPORTED_IN_TESTING.has(name)),
    ];
    const missing = exported.filter((name) => !placed.has(name));
    if (missing.length)
      throw new Error(`Exports missing from the API reference sections: ${missing.join(', ')}`);

    for (const section of SECTIONS)
      for (const name of section.names) {
        this.anchors.set(name, slug(name));
        const receiver = section.receivers?.[name];
        if (!receiver) continue;
        for (const member of this.members(name))
          this.anchors.set(
            `${name}.${member.name}`,
            slug(`${receiver}.${member.name}`.replaceAll('.', '-')),
          );
      }

    const intro = this.moduleDoc(ENTRY);
    const testing = this.moduleDoc(TESTING_ENTRY);
    const out: string[] = [
      '# Plugin API reference',
      '<!-- Generated from the TSDoc comments in packages/plugin-api by `pnpm --filter @tessera/plugin-api docs:api`. Don’t edit it by hand: a test fails when it is out of date. -->',
    ];
    if (intro) out.push(this.prose(tagline(intro.text)), ...intro.examples.map(fence));
    out.push(
      'Everything below is exported from `@tessera/plugin-api`, except the test harness, which is in [`@tessera/plugin-api/testing`](#testing). See [Getting started](./getting-started.md) for a walkthrough and [Permissions and security](./permissions.md) for what each permission allows.',
      '## Contents',
      SECTIONS.map((section) => `- [${section.title}](#${slug(section.title)})`).join('\n'),
    );
    for (const section of SECTIONS) {
      out.push(`## ${section.title}`);
      if (section.title === 'Testing' && testing)
        out.push(this.prose(tagline(testing.text)), ...testing.examples.map(fence));
      else if (section.intro) out.push(this.prose(section.intro));
      for (const name of section.names)
        out.push(...this.renderEntry(name, section.receivers?.[name]));
    }
    return `${out
      .join('\n\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim()}\n`;
  }

  /** Methods and properties of an interface, grouped by name (overloads together). */
  private members(name: string): Array<{ name: string; nodes: ts.TypeElement[] }> {
    const { node } = this.entry(name);
    if (!ts.isInterfaceDeclaration(node)) return [];
    const groups: Array<{ name: string; nodes: ts.TypeElement[] }> = [];
    for (const member of node.members) {
      const memberName = member.name?.getText();
      if (!memberName) continue;
      const group = groups.find((candidate) => candidate.name === memberName);
      if (group) group.nodes.push(member);
      else groups.push({ name: memberName, nodes: [member] });
    }
    return groups;
  }

  private renderEntry(name: string, receiver: string | undefined): string[] {
    const { node, source } = this.entry(name);
    const doc = docOf(node, source);
    // Description first, then the declaration, then examples.
    const out = [`### ${name}`];
    if (doc) out.push(this.prose(doc.text));
    if (!receiver) {
      out.push(fence(declarationText(node, source)));
      if (doc) out.push(...doc.examples.map(fence));
      return out;
    }
    if (doc) out.push(...doc.examples.map(fence));
    for (const member of this.members(name)) {
      const memberDoc = member.nodes
        .map((item) => docOf(item, source))
        .find((candidate): candidate is Doc => candidate !== null);
      out.push(
        `<a id="${this.anchors.get(`${name}.${member.name}`) ?? ''}"></a>`,
        `#### \`${receiver}.${member.name}\``,
      );
      if (memberDoc) out.push(this.prose(memberDoc.text));
      const signatures = member.nodes.map((item) => item.getText(source).replace(/;$/, ''));
      out.push(fence(signatures.join('\n')));
      if (memberDoc) out.push(...memberDoc.examples.map(fence));
    }
    return out;
  }

  /** Prose: `{@link X}` becomes a link, and `<` outside code can't be read as HTML. */
  private prose(text: string): string {
    return text
      .replace(/\{@link\s+([\w.]+)\s*\}/g, (_match, target: string) => {
        const anchor = this.anchors.get(target) ?? this.anchors.get(target.split('.')[0] ?? '');
        return anchor ? `[\`${target}\`](#${anchor})` : `\`${target}\``;
      })
      .split(/(`[^`]*`)/)
      .map((part, index) =>
        index % 2 === 1 ? part : part.replaceAll('<', '&lt;').replaceAll('>', '&gt;'),
      )
      .join('');
  }
}

/** A TypeScript code block (`{@link X}` in its comments becomes plain `X`). */
function fence(code: string): string {
  return `\`\`\`ts\n${code.replace(/\{@link\s+([\w.]+)\s*\}/g, '$1')}\n\`\`\``;
}

/** Puts the package name in a module's opening line in code: `` `@tessera/plugin-api` — … ``. */
function tagline(text: string): string {
  return text.replace(/^(@[\w/-]+) — /, '`$1` — ');
}

/** A declaration as source, without `export` and without function or method bodies. */
function declarationText(node: ts.Node, source: ts.SourceFile): string {
  const withoutExport = (text: string) => text.replace(/^export (declare )?/, '');
  if (ts.isFunctionDeclaration(node) && node.body)
    return withoutExport(
      source.text.slice(node.getStart(source), node.body.getStart(source)).trimEnd(),
    );
  if (ts.isClassDeclaration(node)) {
    const header = source.text
      .slice(node.getStart(source), node.members.pos)
      .trimEnd()
      .replace(/\{$/, '')
      .trimEnd();
    const members = node.members
      // Static members are implementation details (`Symbol.hasInstance`).
      .filter(
        (member) =>
          !(ts.getCombinedModifierFlags(member as ts.Declaration) & ts.ModifierFlags.Static),
      )
      .map((member) => {
        const body =
          ts.isConstructorDeclaration(member) || ts.isMethodDeclaration(member)
            ? member.body
            : undefined;
        const end = body ? body.getStart(source) : member.getEnd();
        const text = source.text
          .slice(member.getFullStart(), end)
          .replace(/^\s*\n/, '')
          .trimEnd();
        return body ? `${text};` : text;
      });
    return withoutExport(`${header} {\n${members.join('\n')}\n}`);
  }
  return withoutExport(node.getText(source));
}

/** The API reference as markdown. */
export function generateApiDocs(): string {
  return new Reference().build();
}
