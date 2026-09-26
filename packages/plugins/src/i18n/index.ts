// The translator alone (no components), so Node scripts can use the registry code too.
import { createTranslator } from '@tessera/ui/i18n';
import { en } from './en';

/** Translates `plugins:` strings. Light enough for the startup bundle. */
export const t = createTranslator('plugins', en);
