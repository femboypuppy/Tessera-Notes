import { defineRenderer } from '@tessera/plugin-api';
import { renderDiagram, type DiagramInput } from './render';

/**
 * The plugin's renderer (`renderer.js`): Mermaid lives here, and only here. Tessera loads it once,
 * in one hidden frame, and every diagram block on every page draws through it
 * (`ctx.api.ui.render('diagram', …)`), so blocks stay light instead of each loading Mermaid.
 */
export default defineRenderer({
  diagram: (input: DiagramInput) => renderDiagram(input.code, input.theme, document, input.width),
});
