import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { apiMeta } from '../contracts/common.js'
import { HealthResponseSchema } from '../contracts/health.js'

export const healthRoutes: FastifyPluginAsyncTypebox = async (app) => {
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
    }),
  )
}
