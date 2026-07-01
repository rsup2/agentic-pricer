import { z } from 'zod';
import { execSync } from 'node:child_process';

/**
 * Validated environment. Fails fast at boot if a required secret is missing,
 * so a misconfigured Aptible app crashes loudly instead of pricing silently wrong.
 */
const EnvSchema = z.object({
  ANTHROPIC_API_KEY: z.string().min(1, 'ANTHROPIC_API_KEY is required'),
  STEDI_API_KEY: z.string().min(1, 'STEDI_API_KEY is required'),

  SNOWFLAKE_ACCOUNT: z.string().min(1),
  SNOWFLAKE_USER: z.string().min(1),
  SNOWFLAKE_PASSWORD: z.string().min(1),
  SNOWFLAKE_WAREHOUSE: z.string().default('COMPUTE_WH'),
  SNOWFLAKE_ROLE: z.string().default('ACCOUNTADMIN'),
  SNOWFLAKE_DATABASE: z.string().default('PROD_CORE'),
  SNOWFLAKE_SCHEMA: z.string().default('BASE_ATHENA'),

  RESULTS_DATABASE: z.string().default('ALE'),
  RESULTS_SCHEMA: z.string().default('ALE_DEV'),
  RESULTS_TABLE: z.string().default('AGENTIC_PRICER_RESULTS'),

  PORT: z.coerce.number().default(3000),
  MAX_CONCURRENT_RUNS: z.coerce.number().default(8),
  SYNTHESIS_MODEL: z.string().default('anthropic/claude-opus-4-8'),
  RESULTS_FLUSH_INTERVAL_MS: z.coerce.number().default(5000),
  RESULTS_FLUSH_MAX_ROWS: z.coerce.number().default(25),

  // Version provenance stamped on every result row (see pricerVersion below).
  // PRICER_LABEL is the human-readable name for this build/cut; bump it when a
  // change is meaningful for the eval (prompt/model/logic). The exact commit
  // (PRICER_VERSION) and its GitHub link come from Aptible's injected env vars.
  PRICER_LABEL: z.string().default('pnr-historicals'),
  APTIBLE_GIT_COMMIT_SHA: z.string().optional(),
  APTIBLE_GIT_COMMIT_URL: z.string().optional(),
});

export type Env = z.infer<typeof EnvSchema>;

export const env: Env = EnvSchema.parse(process.env);

export const resultsTableFqn = `${env.RESULTS_DATABASE}.${env.RESULTS_SCHEMA}.${env.RESULTS_TABLE}`;

/**
 * Version provenance stamped on every result row so a price is always traceable
 * to the exact code that produced it — frozen per row, never re-derived at query
 * time. On Aptible, APTIBLE_GIT_COMMIT_SHA/_URL are injected per deploy (ground
 * truth of what's running). Locally we fall back to the current git SHA, else 'dev'.
 *   - pricerVersion   : short commit SHA (the audit anchor; maps to a PR on GitHub)
 *   - pricerLabel     : human-readable build name (dashboard grouping)
 *   - pricerCommitUrl : direct link to the commit on GitHub (PR is one click away)
 */
function resolvePricerVersion(): string {
  const sha = env.APTIBLE_GIT_COMMIT_SHA?.trim();
  if (sha) return sha.slice(0, 12);
  try {
    return (
      execSync('git rev-parse --short=12 HEAD', { stdio: ['ignore', 'pipe', 'ignore'] })
        .toString()
        .trim() || 'dev'
    );
  } catch {
    return 'dev';
  }
}

export const pricerVersion = resolvePricerVersion();
export const pricerLabel = env.PRICER_LABEL;
export const pricerCommitUrl = env.APTIBLE_GIT_COMMIT_URL?.trim() || null;
