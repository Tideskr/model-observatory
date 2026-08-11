import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import cookie from '@fastify/cookie'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import fastifyStatic from '@fastify/static'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify'
import { loadConfig, type AppConfig } from './config.js'
import { errorHandler } from './errors.js'
import { healthRoutes } from './routes/health.js'
import { privateRunRoutes } from './routes/private-runs.js'
import { publicRoutes } from './routes/public.js'
import { contributionRoutes } from './routes/contributions.js'
import { adminRoutes } from './routes/admin.js'
import { createServices, type AppServices } from './services.js'
import { loadProviderRegistry } from './registry/catalog.js'
import { resolve } from 'node:path'

export interface BuildAppOptions {
  config?: AppConfig
  logger?: boolean
  services?: AppServices
}

function sendFrontendIndex(reply: FastifyReply) {
  void reply.header('cache-control', 'no-store')
  return reply.sendFile('index.html', { cacheControl: false })
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig()
  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: {
              paths: [
                'req.headers.authorization',
                'req.headers.cookie',
                'req.body.api_key',
                'req.body.apiKey',
                'res.headers.set-cookie',
              ],
              censor: '[REDACTED]',
            },
          },
    bodyLimit: 64 * 1024,
    trustProxy: config.trustProxy,
    genReqId: () => randomUUID(),
  }).withTypeProvider<TypeBoxTypeProvider>()
  const services = options.services ?? await createServices(
    config,
    config.databaseUrl === 'memory:'
      ? await loadProviderRegistry(resolve(process.cwd(), config.providerRegistryPath))
      : undefined,
    app.log,
  )

  await app.register(cookie)
  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cors, {
    origin: config.publicOrigin,
    credentials: false,
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'last-event-id', 'x-csrf-token'],
  })
  await app.register(rateLimit, {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request) => request.ip,
  })
  await app.register(swagger, {
    openapi: {
      info: {
        title: 'Model Observatory API',
        version: '1.0.0',
        description: 'Versioned API for observations, private runs, donations, and registry review.',
      },
      servers: [{ url: '/api/v1' }],
    },
  })
  if (config.enableApiDocs) {
    await app.register(swaggerUi, { routePrefix: '/api/docs' })
  }

  app.addHook('onSend', async (request, reply, payload) => {
    void reply.header('x-request-id', request.id)
    if (!reply.hasHeader('cache-control')) void reply.header('cache-control', 'no-store')
    return payload
  })
  app.setErrorHandler(errorHandler)
  app.setNotFoundHandler((request, reply) => {
    void reply.status(404).type('application/problem+json').send({
      type: 'urn:model-observatory:problem:not_found',
      title: 'Not Found',
      status: 404,
      detail: 'The requested resource does not exist.',
      code: 'not_found',
      request_id: request.id,
    })
  })

  const credentialCleanup = setInterval(() => {
    void Promise.all([services.credentialVault.purgeExpired(), services.runStore.purgeExpired(), services.adminService?.purgeExpiredSessions()])
      .catch((error: unknown) => app.log.error({ err: error }, 'retention cleanup failed'))
  }, 60_000)
  credentialCleanup.unref()
  app.addHook('onClose', async () => {
    clearInterval(credentialCleanup)
    await services.close()
  })

  await app.register(healthRoutes, { prefix: '/api/v1', providerRegistry: services.providerRegistry })
  await app.register(publicRoutes, { prefix: '/api/v1', repository: services.publicRepository })
  await app.register(privateRunRoutes, { prefix: '/api/v1', config, services })
  await app.register(contributionRoutes, { prefix: '/api/v1', config, services })
  await app.register(adminRoutes, { prefix: '/api/v1', config, services })
  if (config.frontendDistDir) {
    await app.register(fastifyStatic, {
      root: config.frontendDistDir,
      wildcard: false,
      cacheControl: false,
      setHeaders(reply, path) {
        void reply.header(
          'cache-control',
          path.endsWith('index.html') ? 'no-store' : 'public, max-age=2592000, immutable',
        )
      },
    })
    app.get('/*', async (request, reply) => {
      if (request.url.startsWith('/api/')) return reply.callNotFound()
      return sendFrontendIndex(reply)
    })
  }
  return app
}
