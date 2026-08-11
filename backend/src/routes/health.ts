import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { apiMeta } from '../contracts/common.js'
import { HealthResponseSchema } from '../contracts/health.js'
import type { ProviderRegistry } from '../registry/catalog.js'

interface HealthRouteOptions { providerRegistry: ProviderRegistry }

export const healthRoutes: FastifyPluginAsyncTypebox<HealthRouteOptions> = async (app, options) => {
  app.get(
    '/health',
    {
      schema: {
        tags: ['system'],
        response: { 200: HealthResponseSchema },
      },
      config: { rateLimit: false },
    },
    async () => ({
      ...apiMeta(),
      status: 'ok' as const,
      service: 'model-observatory-api' as const,
      version: '0.1.0',
      registry_sha256: options.providerRegistry.contentSha256,
    }),
  )
}
