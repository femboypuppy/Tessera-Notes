/**
 * Robustness (agents/12-polish.md §3): two people in the same block, the server dying in the
 * middle of a sync, fast typing on a long page, a corrupted zip. Nothing may crash or lose data.
 * Phone width, offline and back, and a 5,000-page workspace are covered elsewhere (the first-run
 * audit at 390 px, `e2e/architect/offline.spec.ts`, journey 8, `e2e/ci/testkit.spec.ts`).
 */
import type { Browser, Page } from '@playwright/test';
import { expect, startSyncServer, test, TesseraApp, type SyncServer } from '../support';
import {
  connectAndUpload,
  createInviteLink,
  editor,
  joinWithInvite,
  syncStatus,
  writeInBody,
} from '../support/journeys';

const ada = { email: 'ada@example.com', name: 'Ada Lovelace', password: 'analytical engine' };
const charles = { email: 'charles@example.com', name: 'Charles Babbage', password: 'difference' };

/** Fails the test on any uncaught error in the page (the app must never crash). */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  return errors;
}

/** Two people in one workspace on `server`, both on the page "Field notes". */
async function shareAPage(
  browser: Browser,
  baseURL: string,
  server: SyncServer,
): Promise<{ first: TesseraApp; second: TesseraApp; close(): Promise<void> }> {
  const contexts = await Promise.all([
    browser.newContext({ baseURL }),
    browser.newContext({ baseURL }),
  ]);
  const [firstPage, secondPage] = await Promise.all(contexts.map((context) => context.newPage()));
  if (!firstPage || !secondPage) throw new Error('Could not open two pages');
  const first = new TesseraApp(firstPage);
  const second = new TesseraApp(secondPage);
  await first.createWorkspace('Engine room');
  await first.expectFeatures('sync', 'editor');
  await server.createOwner(ada);
  await first.newPage('Field notes');
  await writeInBody(first, ['Notes: ']);
  await connectAndUpload(first, server.url, ada);
  const invite = await createInviteLink(first);
  await joinWithInvite(second, server.url, invite, charles, 'Engine room');
  await first.openPage('Field notes');
  await second.openPage('Field notes');
  await expect(editor(second.page)).toContainText('Notes');
  return { first, second, close: () => Promise.all(contexts.map((c) => c.close())).then() };
}

/** Puts the caret at the end of the first line (the paragraph "Notes: "). */
async function caretAfterNotes(app: TesseraApp): Promise<void> {
  await editor(app.page).click();
  await app.page.keyboard.press('ControlOrMeta+Home');
  await app.page.keyboard.press('End');
}

/** The first block's text, from the editor's document (remote carets' labels aren't text). */
function firstBlockText(app: TesseraApp): Promise<string> {
  return editor(app.page).evaluate((element) => {
    const instance = (
      element as HTMLElement & {
        editor?: { state: { doc: { firstChild: { textContent: string } } } };
      }
    ).editor;
    return instance?.state.doc.firstChild.textContent ?? '';
  });
}

test.describe('robustness', () => {
  test('two people typing in the same block both keep every character', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(240_000);
    const server = await startSyncServer({ corsOrigins: [new URL(baseURL ?? '').origin] });
    const people = await shareAPage(browser, baseURL ?? '', server);
    try {
      const errors = [...watchErrors(people.first.page), ...watchErrors(people.second.page)];
      await caretAfterNotes(people.first);
      await caretAfterNotes(people.second);
      // At a typing speed people have, both at once, from the same spot, with words that start
      // with the same letter.
      await Promise.all([
        people.first.page.keyboard.type('engine room', { delay: 90 }),
        people.second.page.keyboard.type('east wing', { delay: 90 }),
      ]);
      // Both browsers converge, and each person's words stay whole and in order.
      await expect
        .poll(
          async () =>
            (await firstBlockText(people.first)) === (await firstBlockText(people.second)),
          { timeout: 20_000 },
        )
        .toBe(true);
      expect(['Notes: engine roomeast wing', 'Notes: east wingengine room']).toContain(
        await firstBlockText(people.first),
      );
      expect(errors).toEqual([]);
    } finally {
      await people.close();
      await server.stop();
    }
  });

  test('the server dies in the middle of a sync: nothing is lost, sync resumes', async ({
    browser,
    baseURL,
  }) => {
    test.setTimeout(300_000);
    const corsOrigins = [new URL(baseURL ?? '').origin];
    let server = await startSyncServer({ corsOrigins });
    const { dataDir } = server;
    const port = Number(new URL(server.url).port);
    const people = await shareAPage(browser, baseURL ?? '', server);
    try {
      const errors = [...watchErrors(people.first.page), ...watchErrors(people.second.page)];
      const { first, second } = people;
      await editor(first.page).click();
      await first.page.keyboard.press('ControlOrMeta+End');
      await first.page.keyboard.press('Enter');
      await first.page.keyboard.type('Saved before the crash.');
      await expect(editor(second.page)).toContainText('Saved before the crash.', {
        timeout: 20_000,
      });

      await test.step('the server is killed while one person types', async () => {
        await first.page.keyboard.press('Enter');
        const typing = first.page.keyboard.type('Typed while the server went down.', {
          delay: 15,
        });
        await server.kill();
        await typing;
        await first.page.keyboard.press('Enter');
        await first.page.keyboard.type('Typed with no server at all.');
        await expect(syncStatus(first)).not.toHaveAttribute('data-sync-status', 'synced', {
          timeout: 30_000,
        });
        // The words are on this device: a reload while the server is down keeps them.
        await first.page.reload();
        await expect(editor(first.page)).toContainText('Typed with no server at all.', {
          timeout: 30_000,
        });
        await expect(editor(first.page)).toContainText('Typed while the server went down.');
      });

      await test.step('the server comes back with its data, and both catch up', async () => {
        server = await startSyncServer({ corsOrigins, port, dataDir });
        for (const app of [first, second]) {
          await expect(syncStatus(app)).toHaveAttribute('data-sync-status', 'synced', {
            timeout: 60_000,
          });
        }
        for (const text of [
          'Saved before the crash.',
          'Typed while the server went down.',
          'Typed with no server at all.',
        ]) {
          await expect(editor(second.page)).toContainText(text, { timeout: 30_000 });
        }
        // And the server itself has everything: a fresh load of the page on the other side.
        await second.page.reload();
        await expect(editor(second.page)).toContainText('Typed with no server at all.', {
          timeout: 30_000,
        });
      });
      expect(errors).toEqual([]);
    } finally {
      await people.close();
      await server.stop();
      const { rmSync } = await import('node:fs');
      rmSync(dataDir, { recursive: true, force: true });
    }
  });

  test('fast typing on a long page loses no keystroke', async ({ freshWorkspace: app }) => {
    test.setTimeout(180_000);
    const errors = watchErrors(app.page);
    await app.newPage('Mission log');
    await writeInBody(app, ['Start of the log.']);
    // A long page: 1,500 paragraphs, written through the editor like any edit.
    await editor(app.page).evaluate((element) => {
      const instance = (
        element as HTMLElement & {
          editor?: { commands: { insertContentAt(at: number, value: unknown): boolean } };
        }
      ).editor;
      const blocks = Array.from({ length: 1500 }, (_, index) => ({
        type: 'paragraph',
        content: [{ type: 'text', text: `Entry ${index + 1}: telemetry nominal.` }],
      }));
      instance?.commands.insertContentAt(1, blocks);
    });
    await expect(editor(app.page)).toContainText('Entry 1500: telemetry nominal.');
    await editor(app.page).click();
    await app.page.keyboard.press('ControlOrMeta+End');
    await app.page.keyboard.press('Enter');
    // No delay between keys: faster than anyone types.
    const burst = 'The quick brown fox jumps over the lazy dog 0123456789. '.repeat(6).trim();
    await app.page.keyboard.type(burst);
    await expect(editor(app.page).locator('p').last()).toHaveText(burst);
    await app.page.reload();
    await expect(editor(app.page).locator('p').last()).toHaveText(burst, { timeout: 30_000 });
    await expect(editor(app.page)).toContainText('Entry 750: telemetry nominal.');
    expect(errors).toEqual([]);
  });

  test('a corrupted zip is refused with a message, and nothing else changes', async ({
    freshWorkspace: app,
  }) => {
    const errors = watchErrors(app.page);
    await app.newPage('Before the import');
    // A zip's signature and a few entries' worth of garbage, cut short.
    const corrupted = Buffer.concat([
      Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x14, 0x00, 0x00, 0x00, 0x08, 0x00]),
      Buffer.from('this is not deflate data'.repeat(20)),
    ]);
    await app.sidebar().getByRole('button', { name: 'Import', exact: true }).click();
    const dialog = app.page.getByRole('dialog', { name: 'Import' });
    await dialog.getByTestId('import-files-input').setInputFiles({
      name: 'Notes export.zip',
      mimeType: 'application/zip',
      buffer: corrupted,
    });
    await expect(dialog.getByText('These files could not be read')).toBeVisible({
      timeout: 20_000,
    });
    await expect(
      dialog.getByText('“Notes export.zip” is damaged or isn’t a zip file.', { exact: false }),
    ).toBeVisible();
    await app.page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    // The workspace is as it was, and the app still works.
    await expect(app.pageTree().getByRole('treeitem')).toHaveCount(1);
    await app.newPage('After the import');
    await expect(app.treeItem('After the import')).toBeVisible();
    await expect(app.page.getByRole('alert')).toHaveCount(0);
    expect(errors).toEqual([]);
  });
});
