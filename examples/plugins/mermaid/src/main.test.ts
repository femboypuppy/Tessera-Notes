// @vitest-environment jsdom
import { defineRenderer } from '@tessera/plugin-api';
import { createTestHarness } from '@tessera/plugin-api/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readCode, type DiagramData } from './block';
import plugin from './main';
import type * as RenderModule from './render';
import renderer from './renderer';
import { DEFAULT_CODE, TEMPLATES } from './templates';

// jsdom can't lay out SVG, so the real mermaid renderer is replaced; its theme mapping is tested
// separately below.
vi.mock('./render', async (importOriginal) => {
  const original = await importOriginal<typeof RenderModule>();
  return {
    ...original,
    renderDiagram: vi.fn(async (code: string, theme: { mode: string }) =>
      code.includes('oops')
        ? { error: 'Parse error on line 2: unexpected token' }
        : { svg: `<svg data-theme="${theme.mode}" data-code="${code.split('\n')[0]}"></svg>` },
    ),
  };
});

const { renderDiagram, solidColor, themeVariables } = await import('./render');

beforeEach(() => {
  vi.mocked(renderDiagram).mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('Mermaid plugin', () => {
  it('adds the diagram block to the slash menu with a starting diagram', async () => {
    const harness = createTestHarness(plugin, { permissions: ['ui:blocks'], renderer });
    await harness.activate();
    expect(harness.blocks).toEqual([
      expect.objectContaining({
        type: 'diagram',
        title: 'Mermaid diagram',
        icon: '🧜',
        initialData: { code: DEFAULT_CODE },
      }),
    ]);
  });

  it('renders the diagram in the current theme and re-renders when the theme changes', async () => {
    const harness = createTestHarness(plugin, { renderer });
    const block = await harness.renderBlock<DiagramData>('diagram', {
      data: { code: 'graph TD\n  A-->B' },
    });
    await settle();
    expect(block.root.querySelector('svg')?.getAttribute('data-code')).toBe('graph TD');
    expect(block.root.querySelector('svg')?.getAttribute('data-theme')).toBe('light');
    harness.setTheme({ mode: 'dark' });
    await settle();
    expect(block.root.querySelector('svg')?.getAttribute('data-theme')).toBe('dark');
    expect(block.root.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe(
      'Mermaid diagram: graph TD',
    );
  });

  it('edits with a live preview, saves, and closes with Mod+Enter', async () => {
    const harness = createTestHarness(plugin, { renderer });
    const block = await harness.renderBlock<DiagramData>('diagram', {
      data: { code: 'graph TD\n  A-->B' },
    });
    await settle();
    block.root.querySelector<HTMLButtonElement>('[aria-label="Edit diagram"]')?.click();
    const textarea = block.root.querySelector('textarea');
    expect(textarea?.value).toBe('graph TD\n  A-->B');
    if (!textarea) throw new Error('no editor');
    textarea.value = 'sequenceDiagram\n  A->>B: Hi';
    textarea.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 700));
    expect(block.root.querySelector('.mm-preview svg')?.getAttribute('data-code')).toBe(
      'sequenceDiagram',
    );
    expect(block.data).toEqual({ code: 'sequenceDiagram\n  A->>B: Hi' });
    textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }));
    await settle();
    expect(block.root.querySelector('textarea')).toBeNull();
    expect(block.root.querySelector('.mm-view svg')?.getAttribute('data-code')).toBe(
      'sequenceDiagram',
    );
  });

  it('shows syntax errors while editing and keeps the last good diagram', async () => {
    const harness = createTestHarness(plugin, { renderer });
    const block = await harness.renderBlock<DiagramData>('diagram', { data: { code: 'graph TD' } });
    await settle();
    block.root.querySelector<HTMLButtonElement>('[aria-label="Edit diagram"]')?.click();
    await settle();
    const textarea = block.root.querySelector('textarea');
    if (!textarea) throw new Error('no editor');
    textarea.value = 'graph TD\n  oops';
    textarea.dispatchEvent(new Event('input'));
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(block.root.querySelector('.mm-error')?.textContent).toContain('Parse error on line 2');
    expect(block.root.querySelector('.mm-preview')?.hasAttribute('data-stale')).toBe(true);
  });

  it('draws through the plugin’s renderer, with the theme and the block’s width', async () => {
    const harness = createTestHarness(plugin, { renderer, theme: { mode: 'dark' } });
    await harness.renderBlock<DiagramData>('diagram', { data: { code: 'graph TD' } });
    await settle();
    expect(renderDiagram).toHaveBeenCalledWith(
      'graph TD',
      expect.objectContaining({ mode: 'dark' }),
      document,
      // jsdom lays nothing out; in Tessera this is the block's width.
      0,
    );
  });

  it('shows in its place why the renderer couldn’t draw', async () => {
    const failing = defineRenderer({
      diagram: () => {
        throw new Error('Mermaid diagrams’s renderer stopped responding and was closed.');
      },
    });
    const harness = createTestHarness(plugin, { renderer: failing });
    const block = await harness.renderBlock<DiagramData>('diagram', { data: { code: 'graph TD' } });
    await settle();
    expect(block.root.querySelector('.mm-error')?.textContent).toBe(
      '⚠ Mermaid diagrams’s renderer stopped responding and was closed.',
    );
  });

  it('offers templates for an empty block and inserts one', async () => {
    const harness = createTestHarness(plugin, { renderer });
    const block = await harness.renderBlock<DiagramData>('diagram', { data: null });
    const chips = [...block.root.querySelectorAll<HTMLButtonElement>('.mm-chips button')];
    expect(chips.map((chip) => chip.textContent)).toEqual(
      TEMPLATES.map((template) => template.label),
    );
    chips.find((chip) => chip.textContent === 'Pie chart')?.click();
    await settle();
    expect(readCode(block.data)).toContain('pie title');
    expect(block.root.querySelector('textarea')).not.toBeNull();
  });

  it('is view-only when the block is read-only, and follows data changed elsewhere', async () => {
    const harness = createTestHarness(plugin, { renderer });
    const block = await harness.renderBlock<DiagramData>('diagram', {
      data: { code: 'graph LR' },
      readOnly: true,
    });
    await settle();
    expect(block.root.querySelector('[aria-label="Edit diagram"]')).toBeNull();
    block.update({ data: { code: 'pie title Undo' } });
    await settle();
    expect(block.root.querySelector('svg')?.getAttribute('data-code')).toBe('pie title Undo');
  });
});

describe('theme mapping', () => {
  it('turns translucent tokens into solid colors over the surface', () => {
    expect(solidColor('#5b5bd6', '#ffffff', document)).toBe('#5b5bd6');
    expect(solidColor('rgb(0 0 0 / 0.5)', '#ffffff', document)).toBe('#808080');
    expect(solidColor('not a color', '#ffffff', document)).toBeUndefined();
  });

  it('maps the design tokens to mermaid theme variables', () => {
    const variables = themeVariables(
      {
        mode: 'dark',
        reducedMotion: false,
        tokens: {
          surface: '#252525',
          bg: '#191919',
          accent: '#5b5bd6',
          fg: '#ebebea',
          'font-sans': 'Inter',
        },
      },
      document,
    );
    expect(variables).toMatchObject({
      darkMode: true,
      background: '#252525',
      primaryBorderColor: '#5b5bd6',
      textColor: '#ebebea',
      fontFamily: 'Inter',
    });
  });
});
