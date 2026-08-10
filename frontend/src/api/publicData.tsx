/* oxlint-disable react/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { providers as mockProviders } from '../data'
import type { Provider } from '../data'
import type { ProbeDefinition } from '../probes'

interface ApiMeta {
  generated_at: string
  data_version: string
  method_version: string
}

interface DashboardResponse extends ApiMeta {
  providers: Provider[]
}

interface RegistryItem {
  id: string
  category: ProbeDefinition['category']
  prompt_template: string
  developer_message?: string
  prompt_rewrite_allowed: boolean
  metadata: Record<string, unknown>
}

interface RegistryResponse extends ApiMeta {
  release_id: string
  items: RegistryItem[]
}

type DataMode = 'loading' | 'live' | 'mock'

interface PublicDataState {
  providers: Provider[]
  mode: DataMode
  dataVersion: string
  methodVersion: string
}

const PublicDataContext = createContext<PublicDataState | null>(null)
const API_ORIGIN = import.meta.env.VITE_API_ORIGIN ?? ''

async function requestJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(`${API_ORIGIN}${path}`, { headers: { accept: 'application/json' }, signal })
  if (!response.ok) throw new Error(`API request failed with ${response.status}`)
  return (await response.json()) as T
}

export function PublicDataProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PublicDataState>({
    providers: mockProviders,
    mode: 'loading',
    dataVersion: 'demo-2026.08',
    methodVersion: 'prototype',
  })

  useEffect(() => {
    const controller = new AbortController()
    requestJson<DashboardResponse>('/api/v1/dashboard', controller.signal)
      .then((response) => {
        if (!response.providers.length) {
          setState((current) => ({ ...current, mode: 'mock' }))
          return
        }
        setState({
          providers: response.providers,
          mode: 'live',
          dataVersion: response.data_version,
          methodVersion: response.method_version,
        })
      })
      .catch(() => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, mode: 'mock' }))
      })
    return () => controller.abort()
  }, [])

  const value = useMemo(() => state, [state])
  return <PublicDataContext.Provider value={value}>{children}</PublicDataContext.Provider>
}

export function usePublicData(): PublicDataState {
  const value = useContext(PublicDataContext)
  if (!value) throw new Error('usePublicData must be used inside PublicDataProvider')
  return value
}

export async function fetchRegistry(signal: AbortSignal): Promise<RegistryResponse> {
  return requestJson<RegistryResponse>('/api/v1/registry?status=stable', signal)
}
