// A plugin whose panel and block never give the app its thread back, for the watchdog tests in
// e2e/plugins/sandbox.spec.ts. Firefox and headless Chromium run panel and block frames on the
// app's main thread: without the host's guard, each of these would freeze the app for good.
export default {
  __tesseraPlugin: 1,
  activate(api) {
    api.ui.addPanel({ id: 'loops', title: 'Loops', icon: '🌀' });
    api.ui.addBlock({ type: 'loop', title: 'Loop block', icon: '🌀' });
  },
  panels: {
    loops({ root }) {
      root.textContent = 'Looping…';
      for (;;) {
        // Never yields.
      }
    },
  },
  blocks: {
    loop({ root }) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Spin';
      button.addEventListener('click', () => {
        // A promise chain: no loop statement, and the event loop never turns.
        const next = () => Promise.resolve().then(next);
        next();
      });
      root.append(button);
    },
  },
};
