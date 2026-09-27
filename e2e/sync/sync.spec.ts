import {
  appendParagraph,
  createLocalWorkspace,
  createPage,
  enableDebugHooks,
  expect,
  joinWorkspace,
  pageTree,
  readText,
  signIn,
  syncStatus,
  test,
  uploadWorkspace,
  workspaceIdOf,
} from './fixtures';

const ada = { email: 'ada@example.com', password: 'analytical engine' };

test.describe('local persistence', () => {
  test('keeps workspaces, pages and content across a reload', async ({ page }) => {
    await createLocalWorkspace(page, 'Apollo research');
    const pageId = await createPage(page, 'Launch checklist');
    await createPage(page, 'Crew roster');
    await appendParagraph(page, pageId, 'T-minus 10 minutes');
    await expect(syncStatus(page)).toHaveAttribute('data-sync-status', 'local');

    await page.reload();
    await expect(pageTree(page).getByRole('treeitem', { name: 'Launch checklist' })).toBeVisible();
    await expect(pageTree(page).getByRole('treeitem', { name: 'Crew roster' })).toBeVisible();
    expect(await readText(page, pageId)).toBe('T-minus 10 minutes');
    await expect(page.getByRole('button', { name: 'Switch workspace' })).toContainText(
      'Apollo research',
    );
  });

  test('keeps two tabs of a workspace in sync without a server', async ({ page, context }) => {
    await createLocalWorkspace(page, 'Two tabs');
    const pageId = await createPage(page, 'Shared notes');
    const second = await context.newPage();
    await second.goto(`/p/${pageId}`);
    await expect(pageTree(second).getByRole('treeitem', { name: 'Shared notes' })).toBeVisible();

    await createPage(second, 'Written in tab two');
    await expect(pageTree(page).getByRole('treeitem', { name: 'Written in tab two' })).toBeVisible({
      timeout: 2000,
    });
    await appendParagraph(page, pageId, 'From tab one');
    await expect.poll(() => readText(second, pageId), { timeout: 2000 }).toBe('From tab one');
  });

  test('shows an edit in another tab while its commit is still on disk', async ({
    page,
    context,
  }) => {
    // A saturated disk: once `__slowCommitMs` is set, this tab's IndexedDB writes complete late.
    await page.addInitScript(() => {
      const transaction = IDBDatabase.prototype.transaction;
      IDBDatabase.prototype.transaction = function (
        this: IDBDatabase,
        ...args: Parameters<IDBDatabase['transaction']>
      ) {
        const created = transaction.apply(this, args);
        const delay = (window as { __slowCommitMs?: number }).__slowCommitMs;
        if (!delay || args[1] !== 'readwrite') return created;
        let oncomplete: IDBTransaction['oncomplete'] = null;
        Object.defineProperty(created, 'oncomplete', {
          configurable: true,
          get: () => null,
          set: (handler: IDBTransaction['oncomplete']) => {
            oncomplete = handler;
          },
        });
        created.addEventListener('complete', (event) => {
          setTimeout(() => oncomplete?.call(created, event), delay);
        });
        return created;
      };
    });
    await createLocalWorkspace(page, 'Slow disk');
    const pageId = await createPage(page, 'Shared notes');
    const second = await context.newPage();
    await second.goto(`/p/${pageId}`);
    await expect(pageTree(second).getByRole('treeitem', { name: 'Shared notes' })).toBeVisible();

    await page.evaluate(() => {
      (window as { __slowCommitMs?: number }).__slowCommitMs = 3000;
    });
    await appendParagraph(page, pageId, 'Written on a slow disk');
    await expect
      .poll(() => readText(second, pageId), { timeout: 2000 })
      .toBe('Written on a slow disk');
  });
});

test.describe('syncing with a server', () => {
  test('two people see each other’s changes and presence within a second', async ({
    browser,
    page,
    context,
    syncServer,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? '').origin;
    await signIn(context, syncServer, origin, ada);
    await createLocalWorkspace(page, 'Mission control');
    const pageId = await createPage(page, 'Launch plan');
    await appendParagraph(page, pageId, 'Go for launch');
    await uploadWorkspace(page, syncServer);

    // Grace joins from her own browser (another context: separate storage and cookies).
    const graceContext = await browser.newContext();
    await enableDebugHooks(graceContext);
    await signIn(graceContext, syncServer, origin, {
      email: 'grace@example.com',
      password: 'compiler pioneer',
      name: 'Grace Hopper',
    });
    const invite = await context.request.post(
      `${syncServer.url}/api/workspaces/${await workspaceIdOf(page)}/invites`,
      { data: { role: 'editor' }, headers: { origin } },
    );
    const { token } = (await invite.json()) as { token: string };
    await graceContext.request.post(`${syncServer.url}/api/invites/${token}/accept`, {
      headers: { origin },
    });
    const grace = await graceContext.newPage();
    await joinWorkspace(grace, syncServer, 'Mission control');
    await expect(pageTree(grace).getByRole('treeitem', { name: 'Launch plan' })).toBeVisible();

    // Both on the same page.
    await page.goto(`/p/${pageId}`);
    await grace.goto(`/p/${pageId}`);
    await expect(syncStatus(page)).toHaveAttribute('data-sync-status', 'synced');
    await expect(syncStatus(grace)).toHaveAttribute('data-sync-status', 'synced');
    expect(await readText(grace, pageId)).toBe('Go for launch');

    // Presence: each sees the other in the page's header.
    await expect(page.getByTestId('presence')).toHaveAccessibleName(/Grace Hopper/, {
      timeout: 1000,
    });
    await expect(grace.getByTestId('presence')).toHaveAccessibleName(/Ada Lovelace/, {
      timeout: 1000,
    });

    // Content and page changes arrive within a second, both ways.
    await appendParagraph(grace, pageId, 'Weather is go');
    await expect.poll(() => readText(page, pageId), { timeout: 1000 }).toContain('Weather is go');
    await appendParagraph(page, pageId, 'Crew is go');
    await expect.poll(() => readText(grace, pageId), { timeout: 1000 }).toContain('Crew is go');
    await page.getByRole('textbox', { name: 'Page title' }).fill('Launch plan (final)');
    await expect(
      pageTree(grace).getByRole('treeitem', { name: 'Launch plan (final)' }),
    ).toBeVisible({
      timeout: 1000,
    });

    await graceContext.close();
  });

  test('keeps working offline and syncs when back online', async ({
    browser,
    page,
    context,
    syncServer,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? '').origin;
    await signIn(context, syncServer, origin, ada);
    await createLocalWorkspace(page, 'Field notes');
    const pageId = await createPage(page, 'Observations');
    await uploadWorkspace(page, syncServer);

    const phoneContext = await browser.newContext();
    await enableDebugHooks(phoneContext);
    await signIn(phoneContext, syncServer, origin, ada);
    const phone = await phoneContext.newPage();
    await joinWorkspace(phone, syncServer, 'Field notes');
    await phone.goto(`/p/${pageId}`);

    await context.setOffline(true);
    await expect(syncStatus(page)).toHaveAttribute('data-sync-status', 'offline');
    await appendParagraph(page, pageId, 'Written offline');
    const offlinePage = await createPage(page, 'Created offline');
    await page.waitForTimeout(500);
    expect(await readText(phone, pageId)).not.toContain('Written offline');
    await expect(pageTree(phone).getByRole('treeitem', { name: 'Created offline' })).toHaveCount(0);

    await context.setOffline(false);
    await expect(syncStatus(page)).toHaveAttribute('data-sync-status', 'synced', {
      timeout: 15_000,
    });
    await expect(pageTree(phone).getByRole('treeitem', { name: 'Created offline' })).toBeVisible({
      timeout: 10_000,
    });
    await expect.poll(() => readText(phone, pageId), { timeout: 10_000 }).toBe('Written offline');
    expect(offlinePage).toBeTruthy();
    await phoneContext.close();
  });

  test('shows the connection in the status popover', async ({
    page,
    context,
    syncServer,
    baseURL,
  }) => {
    const origin = new URL(baseURL ?? '').origin;
    await signIn(context, syncServer, origin, ada);
    await createLocalWorkspace(page, 'Status check');
    await uploadWorkspace(page, syncServer);
    await syncStatus(page).click();
    const popover = page.getByRole('dialog');
    await expect(popover.getByText('Synced', { exact: true })).toBeVisible();
    await expect(
      popover.locator('dd', { hasText: syncServer.url.replace('http://', '') }),
    ).toBeVisible();
    await popover.getByRole('button', { name: 'Sync settings' }).click();
    await expect(page).toHaveURL(/\/settings\/sync$/);
    await expect(page.getByRole('heading', { name: /Synced with/ })).toBeVisible();
  });
});

test.describe('version history', () => {
  test('saves, previews and restores a version, and the restore can be undone', async ({
    page,
  }) => {
    await createLocalWorkspace(page, 'History');
    const pageId = await createPage(page, 'Draft');
    await appendParagraph(page, pageId, 'First draft');
    await page.getByRole('button', { name: 'Version history' }).click();
    const panel = page.getByRole('complementary', { name: 'Version history' });
    await expect(panel.getByText('No versions yet')).toBeVisible();
    await panel.getByRole('button', { name: 'Save version' }).click();
    await panel.getByLabel('Name (optional)').fill('Before the rewrite');
    await panel.getByRole('button', { name: 'Save version' }).click();
    await expect(panel.getByText('Before the rewrite')).toBeVisible();

    await appendParagraph(page, pageId, 'A risky rewrite');
    await panel.getByRole('button', { name: /Before the rewrite/ }).click();
    await expect(panel.getByRole('region', { name: 'Preview' })).toContainText('First draft');
    await expect(panel.getByRole('region', { name: 'Preview' })).not.toContainText('risky');
    await panel.getByRole('button', { name: 'Restore' }).click();
    await page.getByRole('alertdialog').getByRole('button', { name: 'Restore' }).click();
    await expect.poll(() => readText(page, pageId)).toBe('First draft');
    // The content before the restore was kept as a version.
    await expect(panel.getByText('Before restore')).toBeVisible();

    await page.getByRole('button', { name: 'Undo' }).click();
    await expect.poll(() => readText(page, pageId)).toBe('First draft\nA risky rewrite');
  });
});

test.describe('at phone width', () => {
  test.use({ viewport: { width: 390, height: 844 } });

  test('the sync settings and status fit and work with the keyboard', async ({ page }) => {
    await createLocalWorkspace(page, 'Pocket notes');
    await page.goto('/settings/sync');
    await expect(page.getByRole('button', { name: 'Connect to a server' })).toBeVisible();
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
    await page.getByRole('button', { name: 'Connect to a server' }).click();
    await expect(page.getByLabel('Server address')).toBeVisible();

    // The status popover opens from the keyboard and closes with Escape.
    await syncStatus(page).focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog').getByText(/lives on this device/)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(syncStatus(page)).toBeFocused();
  });
});
