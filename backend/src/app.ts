import { randomUUID } from 'node:crypto'
import cors from '@fastify/cors'
import helmet from '@fastify/helmet'
import rateLimit from '@fastify/rate-limit'
import swagger from '@fastify/swagger'
import swaggerUi from '@fastify/swagger-ui'
import { TypeBoxTypeProvider } from '@fastify/type-provider-typebox'
import Fastify, { type FastifyInstance } from 'fastify'
import { loadConfig, type AppConfig } from './config.js'
import { errorHandler } from './errors.js'
import { healthRoutes } from './routes/health.js'
import { privateRunRoutes } from './routes/private-runs.js'
import { publicRoutes } from './routes/public.js'
import { contributionRoutes } from './routes/contributions.js'
import { createServices, type AppServices } from './services.js'

export interface BuildAppOptions {
  config?: AppConfig
  logger?: boolean
  services?: AppServices
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig()
  const services = options.services ?? createServices(config)
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

  await app.register(helmet, { contentSecurityPolicy: false })
  await app.register(cors, {
    origin: config.publicOrigin,
    credentials: false,
    allowedHeaders: ['content-type', 'authorization', 'idempotency-key', 'last-event-id'],
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
    void Promise.all([services.credentialVault.purgeExpired(), services.runStore.purgeExpired()])
      .catch((error: unknown) => app.log.error({ err: error }, 'retention cleanup failed'))
  }, 60_000)
  credentialCleanup.unref()
  app.addHook('onClose', async () => {
    clearInterval(credentialCleanup)
    await services.close()
  })

  await app.register(healthRoutes, { prefix: '/api/v1' })
  await app.register(publicRoutes, { prefix: '/api/v1', repository: services.publicRepository })
  await app.register(privateRunRoutes, { prefix: '/api/v1', config, services })
  await app.register(contributionRoutes, { prefix: '/api/v1', config, services })
  return app
}
