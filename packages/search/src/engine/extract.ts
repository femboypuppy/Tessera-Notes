import {
  extractLinks,
  extractTags,
  extractTasks,
  extractTextBlocks,
  getPageProps,
  isStoredPropertyType,
  listProperties,
  listRows,
  nodeAtPath,
  normalizeTagName,
  readDocJSON,
  tagKey,
  validatePropertyValue,
  type AnyNodeJSON,
  type DocJSON,
  type JsonValue,
  type PropertyDefinition,
} from '@tessera/core';
import * as Y from 'yjs';
import type { BlockEntry, ContentRecord, LinkEntry, Segment } from './types';

/** A fresh Y.Doc holding `bytes` (a merged update), or an empty doc. */
export function docFromBytes(bytes: Uint8Array | null): Y.Doc {
  const doc = new Y.Doc();
  if (bytes && bytes.byteLength > 0) Y.applyUpdate(doc, bytes);
  return doc;
}

/** The inline content of a text block as segments (links keep their target for live titles). */
export function segmentsOf(node: AnyNodeJSON | undefined): Segment[] {
  const segments: Segment[] = [];
  for (const child of node?.content ?? []) {
    switch (child.type) {
      case 'text': {
        const text = child.text ?? '';
        const last = segments[segments.length - 1];
        if (last?.t === 'text') last.v += text;
        else if (text) segments.push({ t: 'text', v: text });
        break;
      }
      case 'pageLink': {
        const id = child.attrs?.pageId;
        const label = child.attrs?.label;
        if (typeof id === 'string')
          segments.push({
            t: 'link',
            id,
            label: typeof label === 'string' && label ? label : null,
          });
        break;
      }
      case 'tag': {
        const name = child.attrs?.name;
        if (typeof name === 'string') segments.push({ t: 'tag', v: name });
        break;
      }
      case 'hardBreak':
        segments.push({ t: 'br' });
        break;
      default:
        break;
    }
  }
  return segments;
}

/** Renders segments as display text with the given titles (the same text `inlineText` produces). */
export function segmentsText(
  segments: readonly Segment[],
  resolveTitle: (pageId: string) => string | undefined,
): string {
  let text = '';
  for (const segment of segments) {
    if (segment.t === 'text') text += segment.v;
    else if (segment.t === 'link') text += segment.label ?? resolveTitle(segment.id) ?? '';
    else if (segment.t === 'tag') text += `#${segment.v}`;
    else text += '\n';
  }
  return text;
}

/** Page tags from inline `#tags` and the `tags` page prop, unique by key, first spelling kept. */
function collectTags(doc: DocJSON, propTags: readonly string[]): string[] {
  const byKey = new Map<string, string>();
  for (const tag of extractTags(doc)) if (!byKey.has(tag.key)) byKey.set(tag.key, tag.name);
  for (const raw of propTags) {
    const name = normalizeTagName(raw);
    if (name && !byKey.has(tagKey(name))) byKey.set(tagKey(name), name);
  }
  return [...byKey.values()];
}

/**
 * Reads what the index needs from a page doc: text blocks, tags, aliases, tasks and links (with
 * the inline content of each link's block).
 */
export function readContent(
  ydoc: Y.Doc,
  fingerprint: number,
  resolveTitle: (pageId: string) => string | undefined,
): ContentRecord {
  const doc = readDocJSON(ydoc);
  const props = getPageProps(ydoc);
  const options = { resolveTitle };
  const blocks: BlockEntry[] = extractTextBlocks(doc, options).map((block) => {
    const entry: BlockEntry = { text: block.text, blockId: block.blockId };
    if (block.type === 'heading') entry.level = block.level ?? 1;
    if (block.type === 'codeBlock') entry.code = true;
    return entry;
  });
  const segmentCache = new Map<string, Segment[]>();
  const links: LinkEntry[] = extractLinks(doc).map((link) => {
    const key = link.path.join('.');
    let segments = segmentCache.get(key);
    if (!segments) {
      segments = segmentsOf(nodeAtPath(doc, link.path));
      segmentCache.set(key, segments);
    }
    return {
      targetPageId: link.targetPageId,
      label: link.label,
      heading: link.heading,
      blockRef: link.blockRef,
      path: link.path,
      offset: link.offset,
      blockId: link.blockId,
      segments,
    };
  });
  const aliases = (props.aliases ?? []).map((alias) => alias.trim()).filter(Boolean);
  return {
    blocks,
    tags: collectTags(doc, props.tags ?? []),
    aliases: [...new Set(aliases)],
    hasTasks: extractTasks(doc).length > 0,
    links,
    fingerprint,
  };
}

function valueText(
  property: PropertyDefinition,
  raw: JsonValue,
  resolveTitle: (pageId: string) => string | undefined,
): string {
  if (!isStoredPropertyType(property.type)) return '';
  const type = property.type;
  const result = validatePropertyValue(type, raw);
  if (!result.success) return '';
  const value: unknown = result.value;
  const optionName = (id: unknown) =>
    property.options?.find((option) => option.id === id)?.name ?? '';
  switch (type) {
    case 'text':
    case 'url':
    case 'email':
      return typeof value === 'string' ? value : '';
    case 'number':
      return typeof value === 'number' ? String(value) : '';
    case 'checkbox':
      return value === true ? property.name : '';
    case 'select':
      return optionName(value);
    case 'multiSelect':
      return Array.isArray(value) ? value.map(optionName).filter(Boolean).join(' ') : '';
    case 'date': {
      const date = value as { start?: unknown; end?: unknown };
      return [date.start, date.end].filter((part) => typeof part === 'string').join(' ');
    }
    case 'relation':
      return Array.isArray(value)
        ? value
            .map((id) => (typeof id === 'string' ? (resolveTitle(id) ?? '') : ''))
            .filter(Boolean)
            .join(' ')
        : '';
    default:
      return '';
  }
}

/** The searchable values of a database row. */
export interface RowValues {
  text: string;
  /** Pages its relation cells point to: `text` holds their titles. */
  relations: string[];
}

/**
 * Text of every row's stored values in a database doc (select option names, dates, relation
 * titles…), by row ID, for full-text search of database rows.
 */
export function readRowValues(
  dbDoc: Y.Doc,
  resolveTitle: (pageId: string) => string | undefined,
): Map<string, RowValues> {
  const properties = listProperties(dbDoc);
  const result = new Map<string, RowValues>();
  for (const row of listRows(dbDoc)) {
    const parts: string[] = [];
    const relations = new Set<string>();
    for (const property of properties) {
      const raw = row.values[property.id];
      if (raw === undefined || raw === null) continue;
      const text = valueText(property, raw, resolveTitle).trim();
      if (text) parts.push(text);
      if (property.type === 'relation') for (const id of relationTargets(raw)) relations.add(id);
    }
    result.set(row.id, { text: parts.join('\n'), relations: [...relations] });
  }
  return result;
}

/** The pages a relation value points to (none when it is not a valid relation value). */
function relationTargets(raw: JsonValue): string[] {
  const result = validatePropertyValue('relation', raw);
  const value: unknown = result.success ? result.value : null;
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
}
