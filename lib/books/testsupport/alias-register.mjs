// Test-only: lets `node --experimental-strip-types` load the app's server modules (`@/` alias, extensionless
// relative imports) so a DB-level test can run against a real SQLite file. Used by `npm run test:books-db`.
import { register } from 'node:module';
register('./alias-hooks.mjs', import.meta.url);
