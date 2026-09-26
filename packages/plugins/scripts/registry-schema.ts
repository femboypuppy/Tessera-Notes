/**
 * Checks a registry document against `examples/plugins/registry.schema.json` (JSON Schema 2020-12,
 * the format published for anyone hosting a registry). The app itself parses registries with zod
 * (`src/registry.ts`); checking both keeps the published schema and the app in agreement.
 */
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { REGISTRY_SCHEMA } from './registry-files';

let validate: ReturnType<Ajv2020['compile']> | null = null;

/** Problems with `document` against the schema, as readable lines; empty when it matches. */
export function validateRegistrySchema(document: unknown): string[] {
  if (!validate) {
    const ajv = new Ajv2020({
      allErrors: true,
      // The schema's only format; URL.canParse is what the app's zod `url()` relies on too.
      formats: { uri: (value: string) => URL.canParse(value) },
    });
    validate = ajv.compile(JSON.parse(readFileSync(REGISTRY_SCHEMA, 'utf8')) as object);
  }
  if (validate(document)) return [];
  return (validate.errors ?? []).map(
    (error) => `${error.instancePath || '(root)'} ${error.message ?? 'is invalid'}`,
  );
}
