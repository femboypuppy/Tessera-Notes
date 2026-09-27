import { Hono } from 'hono';
import { HttpError, notFound } from '../errors';
import type { AppEnv, AppServices } from './context';
import { authenticate, cors, csrf, requestLog, securityHeaders } from './middleware';
import { assetRoutes } from './routes/assets';
import { authRoutes } from './routes/auth';
import { inviteRoutes } from './routes/invites';
import { workspaceRoutes } from './routes/workspaces';
import { serveWebApp } from './static';

/** Server version reported by the health endpoint. */
export const SERVER_VERSION = '0.1.2';

/**
 * The HTTP app: the JSON API under `/api` and, when a web build is available, the web app.
 *
 * `GET /api/health` → `{ ok, name, version, setupRequired, signupMode }`.
 */
export function createHttpApp(services: AppServices, options: { webDir?: string | null } = {}) {
  const app = new Hono<AppEnv>();
  app.use('*', requestLog(services));
  app.use('*', securityHeaders(services));
  app.use('/api/*', cors(services));
  app.use('/api/*', authenticate(services));
  app.use('/api/*', csrf(services));

  app.get('/api/health', (c) =>
    c.json({
      ok: true,
      name: 'tessera',
      version: services.version,
      setupRequired: !services.auth.hasUsers(),
      signupMode: services.config.signupMode,
      maxUploadBytes: services.config.maxUploadBytes,
    }),
  );
  app.route('/api/auth', authRoutes(services));
  app.route('/api/workspaces', workspaceRoutes(services));
  app.route('/api/invites', inviteRoutes(services));
  app.route('/api/assets', assetRoutes(services));
  app.all('/api/*', () => {
    throw notFound('No such API endpoint.');
  });

  if (options.webDir) app.use('*', serveWebApp(options.webDir));

  app.notFound((c) =>
    c.req.path.startsWith('/api/')
      ? c.json({ error: { code: 'not_found', message: 'Not found.' } }, 404)
      : c.text(
          options.webDir
            ? 'Not found'
            : 'Tessera server is running. The web app is not built: run `pnpm --filter @tessera/web build`, or set WEB_DIR.',
          404,
        ),
  );

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      const retryAfter = (error.details as { retryAfter?: number } | undefined)?.retryAfter;
      if (error.status === 429 && retryAfter) c.header('Retry-After', String(retryAfter));
      return c.json(
        {
          error: {
            code: error.code,
            message: error.message,
            ...(error.details !== undefined && error.status !== 429
              ? { details: error.details }
              : {}),
          },
        },
        error.status,
      );
    }
    services.logger.error({ err: error, requestId: c.get('requestId') }, 'unhandled error');
    return c.json(
      { error: { code: 'internal', message: 'Something went wrong on the server.' } },
      500,
    );
  });

  return app;
}
