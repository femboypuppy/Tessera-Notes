import { docJSONEqual, normalizeDocJSON, validateDocJSON, type DocJSON } from '@tessera/core';
import { kitchenSinkDoc } from '@tessera/core/testing';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { createMarkdownCodec } from './codec';
import { docArbitrary, markdownArbitrary, resolvers } from './test/arbitraries';

const codec = createMarkdownCodec();

/** Property tests run hundreds of cases; busy CI machines need the room. */
const PROPERTY_TIMEOUT = 180_000;

function firstDifference(actual: DocJSON, expected: DocJSON): string {
  const a = JSON.stringify(actual, null, 1).split('\n');
  const b = JSON.stringify(expected, null, 1).split('\n');
  const index = a.findIndex((line, i) => line !== b[i]);
  return `got:\n${a.slice(Math.max(0, index - 6), index + 8).join('\n')}\nwanted:\n${b.slice(Math.max(0, index - 6), index + 8).join('\n')}`;
}

describe('round trips (property-based)', () => {
  it(
    'parse(serialize(doc)) equals doc for every schema feature',
    () => {
      fc.assert(
        fc.property(docArbitrary, (doc) => {
          const markdown = codec.serialize(doc, { resolvePage: resolvers.resolvePage });
          const parsed = codec.parse(markdown, { resolvePageLink: resolvers.resolvePageLink }).doc;
          if (!docJSONEqual(parsed, doc)) {
            throw new Error(
              `Round trip changed the document.\nmarkdown:\n${markdown}\n${firstDifference(normalizeDocJSON(parsed), normalizeDocJSON(doc))}`,
            );
          }
        }),
        { numRuns: 300 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    'serialize(parse(md)) is stable after one normalization pass',
    () => {
      fc.assert(
        fc.property(markdownArbitrary, (source) => {
          const once = codec.serialize(
            codec.parse(source, { resolvePageLink: resolvers.resolvePageLink }).doc,
            {
              resolvePage: resolvers.resolvePage,
            },
          );
          const twice = codec.serialize(
            codec.parse(once, { resolvePageLink: resolvers.resolvePageLink }).doc,
            {
              resolvePage: resolvers.resolvePage,
            },
          );
          expect(twice).toBe(once);
        }),
        { numRuns: 300 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    'always produces valid documents, whatever the input',
    () => {
      fc.assert(
        fc.property(fc.oneof(markdownArbitrary, fc.string({ maxLength: 200 })), (source) => {
          const { doc } = codec.parse(source, { resolvePageLink: resolvers.resolvePageLink });
          expect(validateDocJSON(doc).ok).toBe(true);
        }),
        { numRuns: 300 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  it(
    'is deterministic',
    () => {
      fc.assert(
        fc.property(docArbitrary, (doc) => {
          const a = codec.serialize(doc, { resolvePage: resolvers.resolvePage });
          const b = createMarkdownCodec().serialize(structuredClone(doc), {
            resolvePage: resolvers.resolvePage,
          });
          expect(b).toBe(a);
          expect(JSON.stringify(codec.parse(a).doc)).toBe(
            JSON.stringify(createMarkdownCodec().parse(a).doc),
          );
        }),
        { numRuns: 100 },
      );
    },
    PROPERTY_TIMEOUT,
  );

  it('keeps a link GFM finds in looser text stable, instead of adding brackets on every save', () => {
    // Found by the property above (seed 180555762): `+@.a` became `<+@.a>`, then `<<+@.a>>`…
    // CommonMark doesn't read `<+@.a>` as a link, so such links are written `[text](url)`.
    for (const source of ['+@.a', 'a@.b', '-@.a', 'x@a-.b', `${'a'.repeat(33)}:b`]) {
      const once = codec.serialize(codec.parse(source).doc);
      expect(codec.serialize(codec.parse(once).doc), source).toBe(once);
    }
    expect(codec.serialize(codec.parse('+@.a').doc)).toBe('[+@.a](mailto:+@.a)\n');
    // Addresses and URLs CommonMark accepts keep the short form.
    expect(codec.serialize(codec.parse('ada@example.com').doc)).toBe('<ada@example.com>\n');
    expect(codec.serialize(codec.parse('<https://example.com/a>').doc)).toBe(
      '<https://example.com/a>\n',
    );
  });

  it('round trips the kitchen-sink document', () => {
    const doc = kitchenSinkDoc();
    const titles: Record<string, string> = {
      'spec-page-000000000001': 'Spec',
      'roadmap-page-00000002': 'Roadmap',
      'apollo-page-000000003': 'Apollo 11',
    };
    const markdown = codec.serialize(doc, {
      resolvePage: (id) => (titles[id] ? { title: titles[id] } : null),
    });
    const parsed = codec.parse(markdown, {
      resolvePageLink: (target) => Object.keys(titles).find((id) => titles[id] === target) ?? null,
    });
    const expected = normalizeDocJSON(doc);
    // The trailing empty paragraph is the editor's caret line, not content.
    expected.content.pop();
    expect(parsed.warnings).toEqual([]);
    expect(docJSONEqual(parsed.doc, expected)).toBe(true);
  });
});
