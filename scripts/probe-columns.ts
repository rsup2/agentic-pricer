/**
 * Throwaway: introspect default_provider columns + a sample row for org 6.
 * Run: npm run probe:columns   (uses --env-file=.env)
 */
import { executeQuery, drainPool } from '../src/tools/snowflake.js';

async function main() {
  const cols = await executeQuery(
    `SELECT column_name, data_type
     FROM prod_core.information_schema.columns
     WHERE table_schema = 'BASE_HEX_PRICING' AND table_name = 'DEFAULT_PROVIDER'
     ORDER BY ordinal_position`,
  );
  console.log('=== default_provider columns ===');
  for (const c of cols as Array<Record<string, unknown>>) {
    console.log(c.COLUMN_NAME, '\t', c.DATA_TYPE);
  }

  console.log('\n=== sample rows (LIMIT 3) ===');
  const sample = await executeQuery('SELECT * FROM prod_core.base_hex_pricing.default_provider LIMIT 3');
  console.log(JSON.stringify(sample, null, 2));
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void drainPool());
