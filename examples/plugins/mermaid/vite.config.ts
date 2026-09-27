import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

const file = (name: string) => fileURLToPath(new URL(name, import.meta.url));

/**
 * Builds the plugin into two ES modules next to a copy of its manifest and README: the folder
 * Tessera installs (zip it, or point Tessera at it).
 *
 * - `vite build`: `dist/main.js`, the plugin (its block), without Mermaid, so every block frame
 *   stays light.
 * - `vite build --mode renderer`: `dist/renderer.js`, the renderer, with Mermaid. Tessera loads it
 *   once, in one hidden frame that draws for every block.
 */
export default defineConfig(({ mode }) => {
  const renderer = mode === 'renderer';
  const name = renderer ? 'renderer' : 'main';
  return {
    build: {
      lib: { entry: file(`src/${name}.ts`), formats: ['es'], fileName: () => `${name}.js` },
      target: 'es2022',
      outDir: file('dist'),
      // The renderer is built second, into the same folder.
      emptyOutDir: !renderer,
      // Each module loads from a single file, so lazy imports are bundled in. Library builds keep
      // whitespace in ES output, so the output minifier is on explicitly.
      rolldownOptions: { output: { codeSplitting: false, minify: true } },
    },
    plugins: [
      {
        name: 'tessera-plugin-files',
        generateBundle() {
          if (renderer) return;
          for (const fileName of ['manifest.json', 'README.md']) {
            if (existsSync(file(fileName)))
              this.emitFile({
                type: 'asset',
                fileName,
                source: readFileSync(file(fileName), 'utf8'),
              });
          }
        },
      },
    ],
  };
});
