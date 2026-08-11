/* oxlint-disable react/only-export-components */
import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { Provider } from '../data'
import type { ProbeDefinition } from '../probes'
import { apiUrl } from '../config'

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

type DataMode = 'loading' | 'live' | 'error'

interface PublicDataState {
  providers: Provider[]
  mode: DataMode
  dataVersion: string
  methodVersion: string
  error: string | null
}

const PublicDataContext = createContext<PublicDataState | null>(null)
async function requestJson<T>(path: string, signal: AbortSignal): Promise<T> {
  const response = await fetch(apiUrl(path), { headers: { accept: 'application/json' }, signal })
  if (!response.ok) throw new Error(`API request failed with ${response.status}`)
  return (await response.json()) as T
}

export function PublicDataProvider({ children }: { children: React.ReactNode }) {
  const [state, setState] = useState<PublicDataState>({
    providers: [],
    mode: 'loading',
    dataVersion: '',
    methodVersion: '',
    error: null,
  })

  useEffect(() => {
    const controller = new AbortController()
    requestJson<DashboardResponse>('/api/v1/dashboard', controller.signal)
      .then((response) => {
        setState({
          providers: response.providers,
          mode: 'live',
          dataVersion: response.data_version,
          methodVersion: response.method_version,
          error: null,
        })
      })
      .catch((error) => {
        if (!controller.signal.aborted) setState((current) => ({ ...current, providers: [], mode: 'error', error: error instanceof Error ? error.message : '公开数据加载失败' }))
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
