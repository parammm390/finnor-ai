/** Trusted migration process for an owned disposable database only. */
import { migrate } from '../../packages/db/migrate';
if (process.env.FINNOR_TEST_MANAGED_EXTENSIONS !== 'omit' || process.env.NODE_ENV !== 'test')
  throw Error('Explicit disposable migration test profile required');
await migrate();
