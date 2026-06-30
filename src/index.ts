import { serve } from '@hono/node-server';
import { OpenAPIHono, createRoute, z } from '@hono/zod-openapi';
import { swaggerUI } from '@hono/swagger-ui';
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
 * GET  /doc          -> OpenAPI 3.1 spec (generated from the Zod schemas).
 * GET  /ui           -> Swagger UI rendering /doc.
 *
 * The Mastra agent is constructed lazily inside the pricing run (synthesisAgent),
 * so this file only owns HTTP + lifecycle. We run a minimal Hono server rather
 * than the Mastra CLI server so the deploy doesn't depend on the bundler.
 */
const app = new OpenAPIHono({
  // Preserve the previous 400 shape: { error, issues } on validation failure.
  defaultHook: (result, c) => {
    if (!result.success) {
      return c.json({ error: 'validation failed', issues: result.error.issues }, 400);
    }
  },
});

const healthRoute = createRoute({
  method: 'get',
  path: '/healthcheck',
  summary: 'Aptible health probe',
  responses: {
    200: {
      description: 'Service is healthy',
      content: {
        'application/json': {
          schema: z.object({ status: z.literal('ok'), queueDepth: z.number() }),
        },
      },
    },
  },
});
app.openapi(healthRoute, (c) => c.json({ status: 'ok' as const, queueDepth: queueDepth() }));

const rootRoute = createRoute({
  method: 'get',
  path: '/',
  summary: 'Service banner',
  responses: {
    200: {
      description: 'Service identity',
      content: {
        'application/json': {
          schema: z.object({ service: z.string(), status: z.literal('ok') }),
        },
      },
    },
  },
});
app.openapi(rootRoute, (c) => c.json({ service: 'agentic-pricer-shadow', status: 'ok' as const }));

const priceRoute = createRoute({
  method: 'post',
  path: '/price',
  summary: 'Enqueue a shadow pricing run',
  description:
    'Validates the request and enqueues it behind the concurrency gate. Returns 202 ' +
    'immediately; the result (or an error row) is persisted to Snowflake keyed by requestId.',
  request: {
    body: {
      content: { 'application/json': { schema: PriceRequestSchema } },
      required: true,
    },
  },
  responses: {
    202: {
      description: 'Accepted for background pricing',
      content: {
        'application/json': {
          schema: z.object({
            requestId: z.string(),
            status: z.literal('accepted'),
            queueDepth: z.number(),
          }),
        },
      },
    },
    400: {
      description: 'Invalid JSON body or schema validation failure',
      content: {
        'application/json': {
          schema: z.object({ error: z.string(), issues: z.array(z.unknown()).optional() }),
        },
      },
    },
  },
});
app.openapi(priceRoute, (c) => {
  // Optional shared-secret gate (defence-in-depth for the PHI in the body). When
  // SHADOW_API_KEY is unset, no auth is enforced (relies on network isolation);
  // when set, the caller (AIR) must send a matching Bearer token.
  const expected = process.env.SHADOW_API_KEY;
  if (expected && c.req.header('authorization') !== `Bearer ${expected}`) {
    return c.json({ error: 'unauthorized' }, 401);
  }
  // Body is already validated against PriceRequestSchema by the OpenAPI route.
  const { requestId, dto, sampling } = c.req.valid('json');
  // fire-and-forget: enqueue behind the concurrency gate, return immediately.
  enqueuePricingRun(requestId, dto, sampling);
  return c.json({ requestId, status: 'accepted' as const, queueDepth: queueDepth() }, 202);
});

// On validation failure, mirror the previous { error, issues } 400 shape.
app.onError((err, c) => {
  // eslint-disable-next-line no-console
  console.error('[agentic-pricer-shadow] request error:', err.message);
  return c.json({ error: err.message }, 500);
});

// OpenAPI spec (3.1) + Swagger UI. doc31() emits an OpenAPI 3.1 document;
// the version is implied by the method, so no `openapi` field is passed.
app.doc31('/doc', {
  openapi: '3.1.0',
  info: { version: '0.1.0', title: 'agentic-pricer-shadow' },
});
app.get('/ui', swaggerUI({ url: '/doc' }));

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
