import {
  defineFeature,
  defineService,
  SERVICE_PRIORITY,
  type AnyServiceRegistration,
  type FileToSave,
  type SavedFile,
} from '@tessera/core';
import { createTestAppContext } from '@tessera/core/testing';
import { describe, expect, it } from 'vitest';
import { inferColumns, parseCsv } from '../csv/csv';
import { importCsvAsDatabase } from '../model/csv-import';
import { testContext } from '../test/fixtures';
import { exportDatabaseCsv } from './actions';

/** A platform file saver (like the desktop app's save dialog) that answers with `answer`. */
function fakeSaver(answer: (file: FileToSave) => SavedFile | null) {
  const saved: Array<{ name: string; text: string }> = [];
  const saver = {
    mode: 'dialog' as const,
    async save(file: FileToSave) {
      saved.push({ name: file.name, text: await file.data.text() });
      return answer(file);
    },
    async print() {},
  };
  const feature = defineFeature({
    id: 'platform',
    services: [
      defineService({
        provides: 'fileSaver',
        id: 'fake-dialog',
        priority: SERVICE_PRIORITY.desktop,
        create: () => saver,
      }) as AnyServiceRegistration,
    ],
  });
  return { saved, feature };
}

async function crewDatabase(test: Awaited<ReturnType<typeof createTestAppContext>>) {
  const table = parseCsv('Name,Role\nNeil Armstrong,Commander\nBuzz Aldrin,Pilot');
  const { page } = await importCsvAsDatabase(
    test.ctx,
    table,
    inferColumns(table, testContext()),
    { title: 'Crew' },
    testContext(),
  );
  return page.id;
}

describe('exportDatabaseCsv', () => {
  it('saves the active view as CSV through the platform file saver', async () => {
    const { saved, feature } = fakeSaver((file) => ({
      name: file.name,
      path: `/home/ada/${file.name}`,
    }));
    const test = await createTestAppContext({ features: [feature] });
    try {
      await exportDatabaseCsv(test.ctx, await crewDatabase(test));
      expect(saved).toHaveLength(1);
      expect(saved[0]?.name).toBe('Crew - Table.csv');
      expect(saved[0]?.text).toContain('Neil Armstrong');
      expect(saved[0]?.text).toContain('Buzz Aldrin');
      expect(test.shell.toasts).toMatchObject([{ variant: 'success', title: 'Exported 2 rows' }]);
    } finally {
      await test.dispose();
    }
  });

  it('says nothing when the save dialog is cancelled', async () => {
    const { saved, feature } = fakeSaver(() => null);
    const test = await createTestAppContext({ features: [feature] });
    try {
      await exportDatabaseCsv(test.ctx, await crewDatabase(test));
      expect(saved).toHaveLength(1);
      expect(test.shell.toasts).toEqual([]);
    } finally {
      await test.dispose();
    }
  });
});
