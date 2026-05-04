/*
 * SPDX-FileCopyrightText: 2026 The HedgeDoc developers (see AUTHORS file)
 *
 * SPDX-License-Identifier: AGPL-3.0-only
 */
import { MediaBackendType } from '@hedgedoc/commons';
import { HttpAdapterHost } from '@nestjs/core';
import { NestFastifyApplication } from '@nestjs/platform-fastify';
import { WsAdapter } from '@nestjs/platform-ws';
import fastifyMultipart from '@fastify/multipart';
import fastifyCsrfProtection from '@fastify/csrf-protection';
import fastifyRateLimit from '@fastify/rate-limit';

import { AppConfig } from './config/app.config';
import { AuthConfig } from './config/auth.config';
import { MediaConfig } from './config/media.config';
import { SecurityConfig } from './config/security.config';
import { ErrorExceptionMapping } from './errors/error-mapping';
import { ConsoleLoggerService } from './logger/console-logger.service';
import { runMigrations } from './migrate';
import { SessionService } from './sessions/session.service';
import { isDevMode } from './utils/dev-mode';
import { setupSessionMiddleware } from './utils/session';
import { setupValidationPipe } from './utils/setup-pipes';
import { setupPrivateApiDocs, setupPublicApiDocs } from './utils/swagger';
import { INestApplication } from '@nestjs/common';
import {
  buildRateLimitResponse,
  generateRateLimitKey,
  getMaxLimitByRequestWithSecurityConfig,
  getTimeWindowByRequestWithSecurityConfig,
  unlimitedEditors,
} from './security/rate-limiting';

/**
 * Common setup function which is called by main.ts and the E2E tests.
 */
export async function setupApp(
  app: NestFastifyApplication,
  appConfig: AppConfig,
  authConfig: AuthConfig,
  mediaConfig: MediaConfig,
  securityConfig: SecurityConfig,
  logger: ConsoleLoggerService,
): Promise<void> {
  // Setup OpenAPI documentation
  await setupPublicApiDocs(app as INestApplication);
  if (isDevMode()) {
    await setupPrivateApiDocs(app as INestApplication);
  }

  // Register multipart for file uploads
  await app.register(fastifyMultipart, {
    limits: {
      fileSize: mediaConfig.maxUploadSize,
    },
  });

  // Register content-type parser for text/markdown
  app
    .getHttpAdapter()
    .getInstance()
    .addContentTypeParser(
      'text/markdown',
      { parseAs: 'string' },
      (_req: unknown, body: unknown, done: (err: Error | null, body: unknown) => void) => {
        done(null, body);
      },
    );

  // Register content-type parsers for braid request types.
  // These capture raw bytes so braid-text can parse them itself.
  // The `/\/http-patches/` regex matches both `application/http-patches`
  // (current) and `message/http-patches` (older clients).
  for (const type of [/\/http-patches/, 'application/text-cursors+json']) {
    app
      .getHttpAdapter()
      .getInstance()
      .addContentTypeParser(
        type,
        { parseAs: 'buffer' },
        (_req: unknown, body: unknown, done: (err: Error | null, body: unknown) => void) => {
          done(null, body);
        },
      );
  }

  await runMigrations(app as INestApplication, logger);

  // Setup session handling
  await setupSessionMiddleware(
    app as INestApplication,
    authConfig,
    app.get(SessionService).getSessionStore(),
  );

  // Setup CSRF protection
  await app.register(fastifyCsrfProtection, {
    cookieKey: 'hedgedoc-csrf',
    sessionPlugin: '@fastify/session',
    getToken: (req) => req.headers['csrf-token'] as string | undefined,
  });
  logger.log('CSRF protection enabled', 'AppBootstrap');

  // Setup rate limiting
  await app.register(fastifyRateLimit, {
    global: true,
    hook: 'preHandler',
    cache: 10000,
    skipOnError: true,
    keyGenerator: generateRateLimitKey,
    max: getMaxLimitByRequestWithSecurityConfig(securityConfig),
    timeWindow: getTimeWindowByRequestWithSecurityConfig(securityConfig),
    errorResponseBuilder: buildRateLimitResponse,
    allowList: (req: import('fastify').FastifyRequest, key: string) => {
      // Skip rate-limiting for valid clients making text-edit PUTs,
      // similar to how WebSocket messages aren't rate-limited.
      if (req.method === 'PUT'
          && unlimitedEditors.has(generateRateLimitKey(req))) {

        // We allow any PUTs to text or cursor state
        var type = (req.headers['repr-type'] || '') as string;
        // Repr-Type is a new header that tells you the type of the selected
        // representation
        if (type.includes('text/plain')
            || type.includes('text/markdown')
            || type.includes('application/text-cursors+json'))
          return true;
      }

      // Otherwise, default to the securityConfig.
      return securityConfig.rateLimit.bypass.includes(key);
    },
    enableDraftSpec: true,
  });
  logger.log('Rate limiting enabled', 'AppBootstrap');

  // Enable web security aspects
  app.enableCors({
    origin: appConfig.rendererBaseUrl,
  });
  logger.log(`Enabling CORS for '${appConfig.rendererBaseUrl}'`, 'AppBootstrap');
  // TODO Add CSP (#1309)
  // TODO Add common security headers (#201)

  // Setup class-validator for incoming API request data
  app.useGlobalPipes(setupValidationPipe(logger));

  // Map URL paths to directories
  if (mediaConfig.backend.type === MediaBackendType.FILESYSTEM) {
    logger.log(
      `Serving the local folder '${mediaConfig.backend.filesystem.uploadPath}' under '/uploads'`,
      'AppBootstrap',
    );
    const path = await import('path');
    await app.register(import('@fastify/static'), {
      root: path.resolve(mediaConfig.backend.filesystem.uploadPath),
      prefix: '/uploads/',
    });
  }
  logger.log(`Serving the local folder 'public' under '/public'`, 'AppBootstrap');
  const path = await import('path');
  await app.register(import('@fastify/static'), {
    root: path.resolve('public'),
    prefix: '/public/',
    decorateReply: false,
  });

  // TODO Evaluate whether we really need this folder,
  //  only use-cases for now are intro.md and motd.md which could be API endpoints as well

  // Grab the HTTP server.  We want to give it Braid-HTTP support
  const server = app.getHttpAdapter().getInstance().server,
        // Get our braidifier ready
        { http_server: braidify } = await import('braid-http')

  // We want Braid-HTTP clients to be able to edit notes via their user-facing
  // URLs (formatted as /n/:alias), even though hedgedoc's backend
  // sees them as /api/v2/notes/:alias/content.
  //
  // So we have two names for the same resource:
  //   - /n/:alias                     the public name for a note
  //   - /api/v2/notes/:alias/content  the api's name for the note
  //
  // 
  // It would be cleaner to just have nest route both of these to the same
  // place, but it doesn't look like nest supports that type of routing, so
  // we're adding a URL rewrite here, for now.
  server.prependListener('request', (req: { url?: string }) => {
    const match = req.url?.match(/^\/n\/([^/?]+)(.*)$/);
    if (match) req.url = `/api/v2/notes/${match[1]}/content${match[2]}`;
  });


  // Extend the fastify web server with Braid-HTTP support
  braidify(server);

  // Configure WebSocket and error message handling
  const { httpAdapter } = app.get(HttpAdapterHost);
  app.useGlobalFilters(new ErrorExceptionMapping(logger, httpAdapter));
  app.useWebSocketAdapter(new WsAdapter(app));

  // Enable hooks on app shutdown, like saving notes into the database
  app.enableShutdownHooks();

  // Don't let idle keep-alive connections prevent shutdown.
  const origClose = server.close.bind(server);
  server.close = function(cb?: () => void) {
    server.closeAllConnections();
    return origClose(cb);
  };
}
