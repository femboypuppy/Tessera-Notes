import type { BlockContext, ThemeInfo } from '@tessera/plugin-api';
import type { DiagramInput, RenderResult } from './render';
import { TEMPLATES } from './templates';

/** The data a Mermaid block stores in the page. */
export type DiagramData = { code: string };

/** Longest diagram source (block data is limited to 64 KB). */
export const MAX_CODE_LENGTH = 60_000;

export function readCode(data: unknown): string {
  return data && typeof data === 'object' && typeof (data as DiagramData).code === 'string'
    ? (data as DiagramData).code.slice(0, MAX_CODE_LENGTH)
    : '';
}

const STYLE = `
.mm { position: relative; border: 1px solid var(--tess-border); border-radius: var(--tess-radius-xl); background: var(--tess-surface); overflow: hidden; }
.mm:focus-within, .mm[data-selected] { border-color: var(--tess-border-strong); }
.mm-view { display: flex; justify-content: center; padding: 28px 24px; min-height: 96px; }
.mm-view svg { max-width: 100%; height: auto; }
.mm-toolbar { position: absolute; top: 8px; right: 8px; display: flex; gap: 4px; opacity: 0; transition: opacity var(--tess-duration-fast) var(--tess-ease-out); }
.mm:hover .mm-toolbar, .mm:focus-within .mm-toolbar, .mm[data-selected] .mm-toolbar { opacity: 1; }
.mm-toolbar button, .mm-head button { height: 28px; padding: 0 10px; font-size: 13px; }
.mm-head { display: flex; align-items: center; gap: 8px; padding: 8px 10px 8px 14px; border-bottom: 1px solid var(--tess-border); background: var(--tess-bg-subtle); }
.mm-title { flex: 1; font-size: 13px; font-weight: 600; color: var(--tess-fg-muted); display: flex; align-items: center; gap: 6px; }
.mm-head select { width: auto; height: 28px; font-size: 13px; padding: 0 8px; }
.mm-edit { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); min-height: 260px; }
.mm-code { border: 0; border-right: 1px solid var(--tess-border); border-radius: 0; resize: none; min-height: 260px; padding: 14px 16px; font-family: var(--tess-font-mono); font-size: 13px; line-height: 1.6; tab-size: 2; background: var(--tess-bg); }
.mm-code:focus-visible { outline: none; box-shadow: inset 0 0 0 2px var(--tess-focus); border-color: var(--tess-border); }
.mm-preview { display: flex; align-items: center; justify-content: center; padding: 20px; overflow: auto; }
.mm-preview svg { max-width: 100%; height: auto; }
.mm-preview[data-stale] { opacity: .45; }
.mm-error { display: flex; gap: 8px; align-items: flex-start; margin: 0; padding: 10px 14px; border-top: 1px solid var(--tess-border); background: var(--tess-danger-subtle); color: var(--tess-danger-text); font-size: 12px; font-family: var(--tess-font-mono); white-space: pre-wrap; }
.mm-empty { display: flex; flex-direction: column; align-items: center; gap: 12px; padding: 28px 20px; color: var(--tess-fg-muted); font-size: 13px; }
.mm-chips { display: flex; flex-wrap: wrap; justify-content: center; gap: 6px; }
.mm-chips button { height: 28px; padding: 0 10px; border-radius: 999px; font-size: 13px; }
.mm-hint { font-size: 11px; color: var(--tess-fg-subtle); }
@media (max-width: 560px) {
  .mm-edit { grid-template-columns: 1fr; }
  .mm-code { border-right: 0; border-bottom: 1px solid var(--tess-border); }
}
`;

const SHORTCUT = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘↩' : 'Ctrl+Enter';

/** Renders a Mermaid block: the diagram, and an editor with a live preview. */
export async function renderBlock(ctx: BlockContext<DiagramData>): Promise<() => void> {
  const doc = ctx.root.ownerDocument;
  const style = doc.createElement('style');
  style.textContent = STYLE;
  const shell = doc.createElement('div');
  shell.className = 'mm';
  ctx.root.append(style, shell);

  let code = readCode(ctx.data);
  let editing = false;
  let theme: ThemeInfo = ctx.api.theme.get();
  let renderRun = 0;
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  let previewTimer: ReturnType<typeof setTimeout> | undefined;

  const button = (label: string, className = '', aria?: string) => {
    const element = doc.createElement('button');
    element.type = 'button';
    element.textContent = label;
    if (className) element.className = className;
    if (aria) element.setAttribute('aria-label', aria);
    return element;
  };

  const save = (next: string) => {
    clearTimeout(saveTimer);
    if (ctx.readOnly || next === readCode(ctx.data)) return;
    ctx.setData({ code: next }).catch((error: unknown) => console.error(error));
  };

  /**
   * Draws `source` with the plugin's renderer (`renderer.ts`, where Mermaid lives: one frame
   * draws for every block, so blocks don't each load it).
   */
  const render = async (source: string, target: HTMLElement): Promise<RenderResult> => {
    const input: DiagramInput = { code: source, theme, width: target.clientWidth };
    try {
      return await ctx.api.ui.render<RenderResult>('diagram', input);
    } catch (failure) {
      return { error: failure instanceof Error ? failure.message : String(failure) };
    }
  };

  /** Renders `source` into `target`, keeping the last good diagram (dimmed) on errors. */
  const draw = async (target: HTMLElement, source: string, error: HTMLElement | null) => {
    const run = (renderRun += 1);
    const result: RenderResult = source.trim()
      ? await render(source, target)
      : { error: 'Write a diagram, or pick a template.' };
    if (run !== renderRun) return;
    if ('svg' in result) {
      target.innerHTML = result.svg;
      target.removeAttribute('data-stale');
      error?.remove();
    } else if (error) {
      error.textContent = `⚠ ${result.error}`;
      if (!error.isConnected) shell.append(error);
      if (target.childElementCount) target.setAttribute('data-stale', '');
    } else {
      target.replaceChildren(errorBox(result.error));
    }
  };

  const errorBox = (message: string) => {
    const box = doc.createElement('p');
    box.className = 'mm-error';
    box.style.borderTop = '0';
    box.textContent = `⚠ ${message}`;
    return box;
  };

  const showEmpty = () => {
    const empty = doc.createElement('div');
    empty.className = 'mm-empty';
    const text = doc.createElement('span');
    text.textContent = ctx.readOnly ? 'This diagram is empty.' : 'Start a diagram from a template';
    empty.append(text);
    if (!ctx.readOnly) {
      const chips = doc.createElement('div');
      chips.className = 'mm-chips';
      for (const template of TEMPLATES) {
        const chip = button(template.label);
        chip.addEventListener('click', () => {
          code = template.code;
          save(code);
          openEditor();
        });
        chips.append(chip);
      }
      empty.append(chips);
    }
    shell.replaceChildren(empty);
  };

  const showView = (): Promise<void> => {
    editing = false;
    shell.removeAttribute('data-editing');
    if (!code.trim()) {
      showEmpty();
      return Promise.resolve();
    }
    const label = `Mermaid diagram: ${code.split('\n')[0]?.trim() ?? ''}`;
    // Redraws (theme changes, undo) keep the current diagram until the new one is ready, so the
    // block never collapses and jumps while Mermaid lays out.
    const existing = shell.querySelector<HTMLElement>(':scope > .mm-view');
    const hasToolbar = shell.querySelector(':scope > .mm-toolbar') !== null;
    if (existing && hasToolbar === !ctx.readOnly) {
      existing.setAttribute('aria-label', label);
      return draw(existing, code, null);
    }
    const view = doc.createElement('div');
    view.className = 'mm-view';
    view.setAttribute('role', 'img');
    view.setAttribute('aria-label', label);
    shell.replaceChildren(view);
    if (!ctx.readOnly) {
      const toolbar = doc.createElement('div');
      toolbar.className = 'mm-toolbar';
      const edit = button('Edit', '', 'Edit diagram');
      edit.addEventListener('click', openEditor);
      toolbar.append(edit);
      shell.append(toolbar);
    }
    return draw(view, code, null);
  };

  function openEditor() {
    if (ctx.readOnly) return;
    editing = true;
    shell.setAttribute('data-editing', '');
    const head = doc.createElement('div');
    head.className = 'mm-head';
    const title = doc.createElement('span');
    title.className = 'mm-title';
    title.textContent = '🧜 Mermaid diagram';
    const templates = doc.createElement('select');
    templates.setAttribute('aria-label', 'Insert a template');
    templates.append(new Option('Templates…', ''));
    for (const template of TEMPLATES) templates.append(new Option(template.label, template.id));
    const done = button('Done', 'primary');
    const hint = doc.createElement('span');
    hint.className = 'mm-hint';
    hint.textContent = SHORTCUT;
    head.append(title, templates, hint, done);

    const edit = doc.createElement('div');
    edit.className = 'mm-edit';
    const textarea = doc.createElement('textarea');
    textarea.className = 'mm-code';
    textarea.value = code;
    textarea.spellcheck = false;
    textarea.maxLength = MAX_CODE_LENGTH;
    textarea.setAttribute('aria-label', 'Diagram source (Mermaid)');
    const preview = doc.createElement('div');
    preview.className = 'mm-preview';
    preview.setAttribute('aria-hidden', 'true');
    edit.append(textarea, preview);
    const error = doc.createElement('p');
    error.className = 'mm-error';
    error.setAttribute('role', 'status');
    shell.replaceChildren(head, edit);

    const close = () => {
      code = textarea.value;
      save(code);
      void showView();
    };
    textarea.addEventListener('input', () => {
      code = textarea.value;
      clearTimeout(previewTimer);
      previewTimer = setTimeout(() => void draw(preview, code, error), 200);
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => save(code), 600);
    });
    textarea.addEventListener('keydown', (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
        event.preventDefault();
        close();
      } else if (event.key === 'Escape') {
        event.preventDefault();
        close();
      } else if (
        event.key === 'Tab' &&
        !event.shiftKey &&
        textarea.selectionStart !== textarea.selectionEnd
      ) {
        // Keep Tab for moving focus unless text is selected (then it indents the selection).
        event.preventDefault();
        const start = textarea.value.lastIndexOf('\n', textarea.selectionStart - 1) + 1;
        const end = textarea.selectionEnd;
        const indented = textarea.value.slice(start, end).replace(/^/gm, '  ');
        textarea.setRangeText(indented, start, end, 'select');
        textarea.dispatchEvent(new Event('input'));
      }
    });
    templates.addEventListener('change', () => {
      const template = TEMPLATES.find((candidate) => candidate.id === templates.value);
      templates.value = '';
      if (!template) return;
      textarea.value = template.code;
      textarea.dispatchEvent(new Event('input'));
      textarea.focus();
    });
    done.addEventListener('click', close);
    void draw(preview, code, error);
    textarea.focus();
  }

  const stops = [
    ctx.onChange((state) => {
      shell.toggleAttribute('data-selected', state.selected);
      const next = readCode(state.data);
      if (state.readOnly && editing) void showView();
      else if (next !== code && !editing) {
        code = next;
        void showView();
      }
    }),
    ctx.api.theme.onChange((next) => {
      theme = next;
      if (editing) {
        const preview = shell.querySelector<HTMLElement>('.mm-preview');
        if (preview) void draw(preview, code, null);
      } else void showView();
    }),
  ];
  shell.toggleAttribute('data-selected', ctx.selected);
  // Resolving after the first drawing tells Tessera the block is ready, so it never flashes empty.
  await showView();
  return () => {
    clearTimeout(saveTimer);
    clearTimeout(previewTimer);
    if (editing) save(code);
    for (const stop of stops) stop();
  };
}
