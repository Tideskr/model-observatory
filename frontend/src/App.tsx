import { lazy, Suspense } from 'react'
import { Navigate, Route, Routes } from 'react-router'
import { AppShell } from './components/AppShell'
import { TooltipProvider } from './components/ui-kit/tooltip'
import { Toaster } from './components/ui-kit/sonner'
import { DashboardPage } from './pages/DashboardPage'
import { DonatePage } from './pages/DonatePage'
import { PrivateCheckPage } from './pages/PrivateCheckPage'
import { ProviderPage } from './pages/ProviderPage'
import { RegistryPage } from './pages/RegistryPage'
import { PublicDataProvider } from './api/publicData'

/* The docs page pulls in the markdown renderer and the docs themselves, which
 * together are larger than the rest of the app. Split so the observatory does
 * not pay for them on first load. */
const DocsPage = lazy(() =>
  import('./pages/DocsPage').then((module) => ({ default: module.DocsPage })),
)
const AdminRegistryPage = lazy(() =>
  import('./pages/AdminRegistryPage').then((module) => ({ default: module.AdminRegistryPage })),
)

export default function App() {
  return (
    <TooltipProvider delayDuration={120}>
      <PublicDataProvider>
        <Routes>
          <Route element={<AppShell />}>
            <Route index element={<DashboardPage />} />
            <Route path="providers/:slug" element={<ProviderPage />} />
            <Route path="private" element={<PrivateCheckPage />} />
            <Route path="donate" element={<DonatePage />} />
            <Route path="registry" element={<RegistryPage />} />
            <Route
              path="admin/registry"
              element={<Suspense fallback={<div className="admin-loading">正在加载管理界面…</div>}><AdminRegistryPage /></Suspense>}
            />
            <Route
              path="docs"
              element={
                <Suspense fallback={<div className="docs-loading">正在载入文档…</div>}>
                  <DocsPage />
                </Suspense>
              }
            />
            <Route path="methodology" element={<Navigate to="/docs" replace />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Route>
        </Routes>
      </PublicDataProvider>
      <Toaster position="bottom-right" />
    </TooltipProvider>
  )
}
