import { serve } from '@hono/node-server';
import { Hono } from 'hono';
import { env } from './env.js';
import { PriceRequestSchema } from './pricing/types.js';
import { enqueuePricingRun, queueDepth } from './concurrency.js';
import { resultsWriter } from './persistence/results-writer.js';

/**
 * Shadow agentic-pricer server.
 *
 * POST /price        -> { requestId, dto }; returns 202 immediately, prices in
 *                       the background, persists to Snowflake keyed by requestId.
 * GET  /healthcheck  -> Aptible health probe.
 *
 * The Mastra agent is constructed lazily inside the pricing run (synthesisAgent),
 * so this file only owns HTTP + lifecycle. We run a minimal Hono server rather
 * than the Mastra CLI server so the deploy doesn't depend on the bundler.
 */
const app = new Hono();

app.get('/healthcheck', (c) => c.json({ status: 'ok', queueDepth: queueDepth() }));
app.get('/', (c) => c.json({ service: 'agentic-pricer-shadow', status: 'ok' }));

app.post('/price', async (c) => {
  let body: unknown;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'invalid JSON body' }, 400);
  }

  const parsed = PriceRequestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'validation failed', issues: parsed.error.issues }, 400);
  }

  const { requestId, dto } = parsed.data;
  // fire-and-forget: enqueue behind the concurrency gate, return immediately.
  enqueuePricingRun(requestId, dto);

  return c.json({ requestId, status: 'accepted', queueDepth: queueDepth() }, 202);
});

const server = serve({ fetch: app.fetch, port: env.PORT }, (info) => {
  // eslint-disable-next-line no-console
  console.log(`[agentic-pricer-shadow] listening on :${info.port} (max ${env.MAX_CONCURRENT_RUNS} concurrent runs)`);
});

// Graceful shutdown: flush any buffered results so we don't lose prices on deploy.
async function shutdown(signal: string) {
  // eslint-disable-next-line no-console
  console.log(`[agentic-pricer-shadow] ${signal} received, flushing results...`);
  try {
    await resultsWriter.flush();
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error('[agentic-pricer-shadow] flush on shutdown failed:', (e as Error).message);
  }
  server.close(() => process.exit(0));
  // hard exit if close hangs
  setTimeout(() => process.exit(0), 8000).unref();
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));
