import { useCallback, useEffect, useMemo, useState } from 'react'
import { ArrowDown, ArrowUp, CheckCircle2, Copy, GitBranch, LogOut, Plus, RotateCcw, Save, ShieldCheck, Trash2, Upload, X } from 'lucide-react'
import { toast } from 'sonner'
import { PageHeader, Pill } from '../components/ui'
import {
  AdminApiError, SCORED_MODELS, adminLoginUrl, createDraft, fetchAdminSession, fetchCurrentRegistry,
  fetchDrafts, fetchRegistryVersions, logoutAdmin, publishDraft, saveDraft, validateDraft,
  type AdminSessionResponse, type ProviderRegistryDocument, type RegistryDraft, type RegistryProvider, type RegistryVersion,
} from '../api/adminRegistry'

function message(error: unknown): string {
  return error instanceof AdminApiError || error instanceof Error ? error.message : '操作失败'
}
function shortSha(value: string | null | undefined): string { return value ? value.slice(0, 10) : '—' }
function dateTime(value: string): string { return new Intl.DateTimeFormat('zh-CN', { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value)) }
function uniqueSlug(document: ProviderRegistryDocument, source = 'new-provider'): string {
  let slug = source
  for (let suffix = 2; document.providers.some((item) => item.slug === slug); suffix += 1) slug = `${source}-${suffix}`
  return slug
}
function diffSummary(current: ProviderRegistryDocument, next: ProviderRegistryDocument): string[] {
  const changes: string[] = []
  if (JSON.stringify(current.pricing) !== JSON.stringify(next.pricing)) changes.push('全局价格发生变化')
  const before = new Map(current.providers.map((item) => [item.slug, item]))
  const after = new Map(next.providers.map((item) => [item.slug, item]))
  for (const provider of next.providers) {
    if (!before.has(provider.slug)) changes.push(`新增供应商 ${provider.name || provider.slug}`)
    else if (JSON.stringify(before.get(provider.slug)) !== JSON.stringify(provider)) changes.push(`修改供应商 ${provider.name || provider.slug}`)
  }
  for (const provider of current.providers) if (!after.has(provider.slug)) changes.push(`移除供应商 ${provider.name || provider.slug}`)
  return changes
}

function IconButton({ label, onClick, disabled, children }: { label: string; onClick: () => void; disabled?: boolean; children: React.ReactNode }) {
  return <button type="button" className="btn-icon" title={label} aria-label={label} disabled={disabled} onClick={onClick}>{children}</button>
}

function ProviderEditor({ provider, onChange, onDelete }: { provider: RegistryProvider; onChange: (value: RegistryProvider) => void; onDelete: () => void }) {
  const updateDomain = (index: number, values: Partial<RegistryProvider['domains'][number]>) => {
    const domains = provider.domains.map((domain, itemIndex) => {
      const updated = itemIndex === index ? { ...domain, ...values } : domain
      return values.role === 'primary' && itemIndex !== index ? { ...updated, role: 'alias' as const } : updated
    })
    onChange({ ...provider, domains })
  }
  const removeDomain = (index: number) => {
    const removedPrimary = provider.domains[index]?.role === 'primary'
    const domains = provider.domains.filter((_, itemIndex) => itemIndex !== index)
    if (removedPrimary && domains[0]) domains[0] = { ...domains[0], role: 'primary' }
    onChange({ ...provider, domains })
  }
  const updateGroup = (index: number, values: Partial<RegistryProvider['groups'][number]>) => {
    onChange({ ...provider, groups: provider.groups.map((group, itemIndex) => itemIndex === index ? { ...group, ...values } : group) })
  }

  return <div className="admin-editor-fields">
    <div className="admin-section-head">
      <div><h2>供应商信息</h2><p>slug 和 hostname 会参与精确匹配，请谨慎修改。</p></div>
      <button type="button" className="btn btn-sm admin-danger" onClick={onDelete}><Trash2 size={14} />删除供应商</button>
    </div>
    <div className="field-grid">
      <label className="field"><span>名称</span><input value={provider.name} onChange={(event) => onChange({ ...provider, name: event.target.value })} /></label>
      <label className="field"><span>slug</span><input value={provider.slug} onChange={(event) => onChange({ ...provider, slug: event.target.value.toLowerCase() })} /></label>
      <label className="field"><span>类型</span><select value={provider.kind} onChange={(event) => onChange({ ...provider, kind: event.target.value as RegistryProvider['kind'] })}><option value="relay">中转商</option><option value="official">官方</option><option value="official_proxy">官方代理</option></select></label>
      <label className="field"><span>分组探测模型</span><input value={provider.group_detection.probe_model} onChange={(event) => onChange({ ...provider, group_detection: { probe_model: event.target.value } })} /></label>
    </div>

    <div className="admin-section-head is-subsection">
      <div><h3>域名</h3><p>每个供应商必须且只能有一个主域名。</p></div>
      <button type="button" className="btn btn-sm" onClick={() => onChange({ ...provider, domains: [...provider.domains, { hostname: '', role: 'alias', default_base_path: '/v1', status: 'active' }] })}><Plus size={14} />添加域名</button>
    </div>
    <div className="admin-table-wrap"><table className="admin-edit-table"><thead><tr><th>hostname</th><th>角色</th><th>base path</th><th>状态</th><th><span className="sr-only">操作</span></th></tr></thead>
      <tbody>{provider.domains.map((domain, index) => <tr key={index}>
        <td><input aria-label={`域名 ${index + 1}`} value={domain.hostname} onChange={(event) => updateDomain(index, { hostname: event.target.value.toLowerCase() })} /></td>
        <td><select aria-label={`域名角色 ${index + 1}`} value={domain.role} onChange={(event) => updateDomain(index, { role: event.target.value as 'primary' | 'alias' })}><option value="primary">主域名</option><option value="alias">别名</option></select></td>
        <td><input aria-label={`基础路径 ${index + 1}`} value={domain.default_base_path} onChange={(event) => updateDomain(index, { default_base_path: event.target.value })} /></td>
        <td><select aria-label={`域名状态 ${index + 1}`} value={domain.status} onChange={(event) => updateDomain(index, { status: event.target.value as 'active' | 'retired' })}><option value="active">启用</option><option value="retired">停用</option></select></td>
        <td><IconButton label="删除域名" onClick={() => removeDomain(index)}><Trash2 size={15} /></IconButton></td>
      </tr>)}</tbody></table></div>

    <div className="admin-section-head is-subsection">
      <div><h3>模型组</h3><p>倍率必须大于 0；每组至少选择一个评分模型。</p></div>
      <button type="button" className="btn btn-sm" onClick={() => onChange({ ...provider, groups: [...provider.groups, { id: 'default', name: '默认', aliases: [], multiplier: 1, models: ['gpt-5.6-sol'] }] })}><Plus size={14} />添加模型组</button>
    </div>
    <div className="admin-groups">
      {provider.groups.length === 0 && <p className="admin-empty-inline">尚未配置模型组。</p>}
      {provider.groups.map((group, index) => <section className="admin-group-row" key={index}>
        <div className="admin-group-toolbar"><strong>{group.name || group.id || `模型组 ${index + 1}`}</strong><IconButton label="删除模型组" onClick={() => onChange({ ...provider, groups: provider.groups.filter((_, itemIndex) => itemIndex !== index) })}><Trash2 size={15} /></IconButton></div>
        <div className="field-grid">
          <label className="field"><span>组 ID</span><input value={group.id} onChange={(event) => updateGroup(index, { id: event.target.value.toLowerCase() })} /></label>
          <label className="field"><span>显示名称</span><input value={group.name} onChange={(event) => updateGroup(index, { name: event.target.value })} /></label>
          <label className="field"><span>倍率</span><input type="number" min="0.000001" step="0.01" value={group.multiplier} onChange={(event) => updateGroup(index, { multiplier: Number(event.target.value) })} /></label>
          <label className="field"><span>别名（逗号分隔）</span><input value={group.aliases.join(', ')} onChange={(event) => updateGroup(index, { aliases: event.target.value.split(',').map((item) => item.trim()).filter(Boolean) })} /></label>
        </div>
        <div className="admin-model-options" role="group" aria-label={`${group.name || group.id} 支持模型`}>
          {SCORED_MODELS.map((model) => <label className="check" key={model}><input type="checkbox" checked={group.models.includes(model)} onChange={(event) => updateGroup(index, { models: event.target.checked ? [...group.models, model] : group.models.filter((item) => item !== model) })} /><code>{model}</code></label>)}
        </div>
      </section>)}
    </div>
  </div>
}

function AdminWorkspace({ session, onSessionChange }: { session: AdminSessionResponse; onSessionChange: (value: AdminSessionResponse) => void }) {
  const csrf = session.csrf_token!
  const [current, setCurrent] = useState<Awaited<ReturnType<typeof fetchCurrentRegistry>> | null>(null)
  const [drafts, setDrafts] = useState<RegistryDraft[]>([])
  const [versions, setVersions] = useState<RegistryVersion[]>([])
  const [draft, setDraft] = useState<RegistryDraft | null>(null)
  const [document, setDocument] = useState<ProviderRegistryDocument | null>(null)
  const [selectedProvider, setSelectedProvider] = useState(0)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [confirmPublish, setConfirmPublish] = useState(false)

  const refresh = useCallback(async () => {
    const [nextCurrent, nextDrafts, nextVersions] = await Promise.all([fetchCurrentRegistry(), fetchDrafts(), fetchRegistryVersions()])
    setCurrent(nextCurrent); setDrafts(nextDrafts); setVersions(nextVersions)
  }, [])
  useEffect(() => { refresh().catch((reason) => setError(message(reason))).finally(() => setLoading(false)) }, [refresh])

  const changes = useMemo(() => current && document ? diffSummary(current.document, document) : [], [current, document])
  const editableDrafts = useMemo(() => drafts.filter((item) => item.status === 'draft'), [drafts])
  const pendingDraft = useMemo(() => drafts.find((item) => item.status === 'publishing' || item.status === 'committed_pending_activation'), [drafts])
  const selectDraft = (value: RegistryDraft) => {
    setDraft(value); setDocument(structuredClone(value.document)); setSelectedProvider(0); setDirty(false); setConfirmPublish(false)
  }
  const mutateDocument = (next: ProviderRegistryDocument) => { setDocument(next); setDirty(true); setConfirmPublish(false) }

  const newDraft = async (source?: string) => {
    setBusy(true); setError(null)
    try {
      const created = await createDraft(csrf, source)
      selectDraft(created); setDrafts((items) => [created, ...items]); toast.success(source ? '已从历史版本创建草稿' : '草稿已创建')
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const save = async (): Promise<RegistryDraft | null> => {
    if (!draft || !document) return null
    setBusy(true); setError(null)
    try {
      const saved = await saveDraft(draft.id, draft.revision, document, csrf)
      setDraft(saved); setDocument(structuredClone(saved.document)); setDirty(false)
      setDrafts((items) => items.map((item) => item.id === saved.id ? saved : item)); toast.success('草稿已保存')
      return saved
    } catch (reason) { setError(message(reason)); return null } finally { setBusy(false) }
  }
  const validate = async () => {
    if (!draft || !document) return
    setBusy(true); setError(null)
    try { const result = await validateDraft(draft.id, document, csrf); toast.success(`校验通过 · ${shortSha(result.content_sha256)}`) }
    catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const publish = async () => {
    if (!draft || !document) return
    setBusy(true); setError(null)
    try {
      let target = draft
      if (dirty) { target = await saveDraft(draft.id, draft.revision, document, csrf); setDraft(target); setDirty(false) }
      const published = await publishDraft(target.id, target.revision, csrf)
      setDraft(null); setDocument(null); setConfirmPublish(false); await refresh()
      toast.success(published.status === 'published' ? 'Registry 已发布并激活' : 'Git 已提交，等待自动激活')
    } catch (reason) { setError(message(reason)) } finally { setBusy(false) }
  }
  const replaceProvider = (index: number, provider: RegistryProvider) => {
    if (document) mutateDocument({ ...document, providers: document.providers.map((item, itemIndex) => itemIndex === index ? provider : item) })
  }
  const addProvider = () => {
    if (!document) return
    const slug = uniqueSlug(document)
    const next: RegistryProvider = { slug, name: '新供应商', kind: 'relay', group_detection: { probe_model: '__api_authenticator_group_probe__' }, groups: [], domains: [{ hostname: `${slug}.invalid`, role: 'primary', default_base_path: '/v1', status: 'active' }] }
    mutateDocument({ ...document, providers: [...document.providers, next] }); setSelectedProvider(document.providers.length)
  }
  const duplicateProvider = (index: number) => {
    if (!document) return
    const source = document.providers[index]!
    const slug = uniqueSlug(document, `${source.slug}-copy`)
    const copy = structuredClone(source); copy.slug = slug; copy.name = `${source.name} 副本`
    copy.domains = copy.domains.map((item, itemIndex) => ({ ...item, hostname: `${slug}-${itemIndex + 1}.invalid` }))
    mutateDocument({ ...document, providers: [...document.providers, copy] }); setSelectedProvider(document.providers.length)
  }
  const moveProvider = (index: number, delta: number) => {
    if (!document) return
    const target = index + delta
    if (target < 0 || target >= document.providers.length) return
    const providers = [...document.providers]; const [item] = providers.splice(index, 1); providers.splice(target, 0, item!)
    mutateDocument({ ...document, providers }); setSelectedProvider(target)
  }
  const removeProvider = (index: number) => {
    if (!document || !window.confirm(`确认删除 ${document.providers[index]?.name ?? '该供应商'}？`)) return
    mutateDocument({ ...document, providers: document.providers.filter((_, itemIndex) => itemIndex !== index) })
    setSelectedProvider(Math.max(0, Math.min(index, document.providers.length - 2)))
  }
  const logout = async () => {
    try { await logoutAdmin(csrf); onSessionChange({ enabled: true, authenticated: false, user: null, csrf_token: null }) }
    catch (reason) { setError(message(reason)) }
  }

  if (loading) return <div className="admin-loading">正在加载 Registry 管理数据…</div>
  return <div className="stack admin-page">
    <PageHeader title="Registry 管理" description="编辑经过校验后提交到 GitHub，并在运行中的 API 与 worker 内原子生效。" actions={<><span className="admin-user"><span className="admin-avatar" aria-hidden="true"><ShieldCheck size={16} /><img src={session.user!.avatar_url} alt="" onError={(event) => { event.currentTarget.hidden = true }} /></span><strong>@{session.user!.login}</strong></span><button type="button" className="btn btn-sm" onClick={() => void logout()}><LogOut size={14} />退出</button></>} />
    {error && <div className="notice notice-bad admin-alert" role="alert"><span>{error}</span><button type="button" className="btn-icon" aria-label="关闭错误" onClick={() => setError(null)}><X size={15} /></button></div>}
    {current && !current.synchronized && <div className="notice notice-warn">数据库快照与 GitHub 文件尚未同步。发布前请等待轻量发布流程完成。</div>}
    {pendingDraft && <div className="notice notice-warn">提交 {shortSha(pendingDraft.commit_sha)} 正在等待 Registry 激活；自动部署完成后该状态会关闭。</div>}
    <section className="admin-status-strip" aria-label="Registry 状态">
      <div><span>当前快照</span><code>{shortSha(current?.content_sha256)}</code></div><div><span>Git blob</span><code>{shortSha(current?.git_blob_sha)}</code></div>
      <div><span>供应商</span><strong>{current?.document.providers.length ?? 0}</strong></div><div><span>同步状态</span><Pill tone={current?.synchronized ? 'good' : 'warn'} dot size="sm">{current?.synchronized ? '一致' : '等待同步'}</Pill></div>
    </section>

    {!draft || !document ? <div className="admin-start">
      <ShieldCheck size={32} aria-hidden="true" /><div><h2>选择或创建草稿</h2><p>线上版本不会因草稿编辑而变化，只有确认发布后才会提交并激活。</p></div>
      <button type="button" className="btn btn-primary" disabled={busy} onClick={() => void newDraft()}><Plus size={16} />新建草稿</button>
      {editableDrafts.length > 0 && <div className="admin-draft-list">{editableDrafts.map((item) => <button type="button" key={item.id} onClick={() => selectDraft(item)}><span><strong>未发布草稿</strong><small>@{item.updated_by_login} · {dateTime(item.updated_at)}</small></span><code>r{item.revision}</code></button>)}</div>}
    </div> : <>
      <div className="admin-toolbar"><div className="admin-toolbar-meta"><strong>草稿 r{draft.revision}</strong><span>基于 {shortSha(draft.base_content_sha256)}</span>{dirty && <Pill tone="warn" size="sm">未保存</Pill>}</div><div className="admin-toolbar-actions"><button type="button" className="btn btn-sm" disabled={busy || !dirty} onClick={() => selectDraft(draft)}><RotateCcw size={14} />放弃修改</button><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void validate()}><CheckCircle2 size={14} />验证</button><button type="button" className="btn btn-sm" disabled={busy || !dirty} onClick={() => void save()}><Save size={14} />保存草稿</button><button type="button" className="btn btn-primary btn-sm" disabled={busy || draft.status !== 'draft'} onClick={() => setConfirmPublish(true)}><Upload size={14} />发布</button></div></div>
      {confirmPublish && <div className="admin-publish-confirm" role="alert"><div><strong>确认发布到 main？</strong><span>{changes.length ? `本次包含 ${changes.length} 项配置变化。` : '当前草稿与线上版本没有结构变化。'}</span></div><button type="button" className="btn btn-sm" onClick={() => setConfirmPublish(false)}>取消</button><button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => void publish()}><Upload size={14} />确认发布</button></div>}
      <div className="admin-workbench">
        <aside className="admin-provider-list"><div className="admin-provider-list-head"><strong>供应商</strong><button type="button" className="btn-icon" aria-label="添加供应商" title="添加供应商" onClick={addProvider}><Plus size={16} /></button></div><div className="admin-provider-items">{document.providers.map((provider, index) => <div className={selectedProvider === index ? 'admin-provider-item is-active' : 'admin-provider-item'} key={index}><button type="button" className="admin-provider-select" onClick={() => setSelectedProvider(index)}><strong>{provider.name || '未命名供应商'}</strong><code>{provider.slug || 'missing-slug'}</code></button><div className="admin-provider-actions"><IconButton label="上移" disabled={index === 0} onClick={() => moveProvider(index, -1)}><ArrowUp size={13} /></IconButton><IconButton label="下移" disabled={index === document.providers.length - 1} onClick={() => moveProvider(index, 1)}><ArrowDown size={13} /></IconButton><IconButton label="复制" onClick={() => duplicateProvider(index)}><Copy size={13} /></IconButton></div></div>)}</div></aside>
        <main className="admin-provider-editor"><div className="admin-pricing"><label className="field"><span>输入价格 / 百万 token（USD）</span><input type="number" min="0.000001" step="0.01" value={document.pricing.input_per_million_usd} onChange={(event) => mutateDocument({ ...document, pricing: { ...document.pricing, input_per_million_usd: Number(event.target.value) } })} /></label><label className="field"><span>输出价格 / 百万 token（USD）</span><input type="number" min="0.000001" step="0.01" value={document.pricing.output_per_million_usd} onChange={(event) => mutateDocument({ ...document, pricing: { ...document.pricing, output_per_million_usd: Number(event.target.value) } })} /></label></div>
          {document.providers[selectedProvider] ? <ProviderEditor provider={document.providers[selectedProvider]} onChange={(provider) => replaceProvider(selectedProvider, provider)} onDelete={() => removeProvider(selectedProvider)} /> : <div className="admin-empty-inline">添加供应商后即可开始编辑。</div>}
        </main>
      </div>
      <section className="admin-review-band"><div className="admin-section-head"><div><h2>发布差异</h2><p>与当前数据库快照比较。</p></div><code>{changes.length} changes</code></div>{changes.length ? <ul>{changes.map((item) => <li key={item}>{item}</li>)}</ul> : <p className="admin-empty-inline">没有检测到结构变化。</p>}</section>
    </>}
    <section className="admin-history"><div className="admin-section-head"><div><h2>版本历史</h2><p>恢复操作会创建新草稿，不会直接覆盖线上。</p></div></div><div className="admin-history-list">{versions.map((version) => <div key={version.content_sha256}><span><code>{shortSha(version.content_sha256)}</code>{version.active && <Pill tone="good" size="sm">当前</Pill>}</span><span>{dateTime(version.imported_at)}</span><span>{version.activated_by ?? 'gitops'}</span><button type="button" className="btn btn-sm" disabled={busy} onClick={() => void newDraft(version.content_sha256)}><RotateCcw size={13} />恢复为草稿</button></div>)}</div></section>
  </div>
}

export function AdminRegistryPage() {
  const [session, setSession] = useState<AdminSessionResponse | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { fetchAdminSession().then(setSession).catch((reason) => setError(message(reason))) }, [])
  if (error) return <div className="stack"><PageHeader title="Registry 管理" /><div className="notice notice-bad">{error}</div></div>
  if (!session) return <div className="admin-loading">正在检查管理员会话…</div>
  if (!session.enabled) return <div className="stack"><PageHeader title="Registry 管理" description="当前部署尚未配置 GitHub 管理应用。" /><div className="notice notice-warn">请先配置 GitHub App 与管理员用户 ID，再重新加载此页面。</div></div>
  if (!session.authenticated) return <div className="admin-login"><ShieldCheck size={38} aria-hidden="true" /><div><h1>Registry 管理</h1><p>仅允许白名单中的 GitHub 管理员访问。登录不会授权应用读取你的其他仓库。</p></div><a className="btn btn-primary" href={adminLoginUrl()}><GitBranch size={17} />使用 GitHub 登录</a></div>
  return <AdminWorkspace session={session} onSessionChange={setSession} />
}
