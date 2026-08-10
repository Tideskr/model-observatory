import { BookOpen, Database, FlaskConical, HeartHandshake, LayoutDashboard, Menu, Telescope, X } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  end?: boolean
}

/* Five destinations — few enough that grouping them would add structure
 * without adding clarity. */
const navigation: NavItem[] = [
  { to: '/', label: '观测面板', icon: LayoutDashboard, end: true },
  { to: '/private', label: '私有检测', icon: FlaskConical },
  { to: '/donate', label: '捐赠节点', icon: HeartHandshake },
  { to: '/registry', label: '模型数据库', icon: Database },
  { to: '/docs', label: '文档', icon: BookOpen },
]

function usePageLabel() {
  const { pathname } = useLocation()
  if (pathname.startsWith('/providers/')) return '提供商详情'
  return (
    navigation.find((item) => (item.end ? pathname === item.to : pathname.startsWith(item.to)))
      ?.label ?? ''
  )
}

export function AppShell() {
  const [mobileOpen, setMobileOpen] = useState(false)
  const pageLabel = usePageLabel()

  return (
    <div className="shell">
      <aside className={mobileOpen ? 'sidebar is-open' : 'sidebar'}>
        <div className="sidebar-brand">
          <span className="brand-mark" aria-hidden="true">
            <Telescope size={18} />
          </span>
          <span className="brand-text">
            <strong>Model Observatory</strong>
            <span>模型观测站</span>
          </span>
          <button
            className="btn-icon sidebar-close"
            type="button"
            onClick={() => setMobileOpen(false)}
            aria-label="关闭导航"
          >
            <X size={18} />
          </button>
        </div>

        <nav className="sidebar-nav" aria-label="主导航">
          {navigation.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              onClick={() => setMobileOpen(false)}
              className={({ isActive }) => (isActive ? 'nav-link is-active' : 'nav-link')}
            >
              <Icon size={17} aria-hidden="true" />
              <span>{label}</span>
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-foot">
          <div className="sidebar-status">
            <small>数据版本 demo-2026.08</small>
            <small>当前全部为模拟数据</small>
          </div>
        </div>
      </aside>

      {mobileOpen && (
        <button className="scrim" type="button" aria-label="关闭导航" onClick={() => setMobileOpen(false)} />
      )}

      <div className="workspace">
        <header className="topbar">
          <button
            className="btn-icon topbar-menu"
            type="button"
            onClick={() => setMobileOpen(true)}
            aria-label="打开导航"
          >
            <Menu size={18} />
          </button>
          <span className="topbar-brand">
            <Telescope size={17} aria-hidden="true" />
            Model Observatory
          </span>
          <span className="topbar-context">
            Model Observatory <span aria-hidden="true">/</span> <strong>{pageLabel}</strong>
          </span>
          <div className="topbar-meta">
            <span className="pill pill-warn pill-sm">
              <span className="dot" aria-hidden="true" />
              原型数据
            </span>
          </div>
        </header>
        <main className="main">
          <Outlet />
        </main>
      </div>
    </div>
  )
}
