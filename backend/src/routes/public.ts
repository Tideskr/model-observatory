import { createHash } from 'node:crypto'
import type { FastifyPluginAsyncTypebox } from '@fastify/type-provider-typebox'
import { Type } from '@sinclair/typebox'
import { apiMeta } from '../contracts/common.js'
import { DashboardResponseSchema, ProviderResponseSchema, RegistryResponseSchema } from '../contracts/public.js'
import { AppError } from '../errors.js'
import type { PublicRepository } from '../store/public-repository.js'

interface PublicRouteOptions { repository: PublicRepository }

function cache(reply: { header(name: string, value: string): unknown }, value: unknown): void {
  const etag = `"${createHash('sha256').update(JSON.stringify(value)).digest('base64url')}"`
  reply.header('cache-control', 'public, max-age=60, stale-while-revalidate=300')
  reply.header('etag', etag)
}

export const publicRoutes: FastifyPluginAsyncTypebox<PublicRouteOptions> = async (app, options) => {
  app.get('/dashboard', { schema: { tags: ['public'], response: { 200: DashboardResponseSchema } } }, async (_request, reply) => {
    const providers = await options.repository.listProviders()
    const response = {
      ...apiMeta(), providers,
      source_policy: {
        headline_sources: ['donated', 'community'] as ['donated', 'community'],
        excluded_sources: ['vendor'] as ['vendor'],
      },
    }
    cache(reply, response)
    return response
  })

  app.get(
    '/providers/:slug',
    { schema: { tags: ['public'], params: Type.Object({ slug: Type.String({ minLength: 1, maxLength: 128 }) }), response: { 200: ProviderResponseSchema } } },
    async (request, reply) => {
      const provider = await options.repository.getProvider(request.params.slug)
      if (!provider) throw new AppError(404, 'provider_not_found', 'The provider does not exist.')
      const response = { ...apiMeta(), provider }
      cache(reply, response)
      return response
    },
  )

  app.get(
    '/registry',
    {
      schema: {
        tags: ['public'],
        querystring: Type.Object({ status: Type.Optional(Type.Union([Type.Literal('stable'), Type.Literal('beta')], { default: 'stable' })) }),
        response: { 200: RegistryResponseSchema },
      },
    },
    async (request, reply) => {
      const status = request.query.status ?? 'stable'
      const registry = await options.repository.listRegistry(status)
      const response = { ...apiMeta(), release_id: registry.releaseId, status, items: registry.items }
      cache(reply, response)
      return response
    },
  )
}
