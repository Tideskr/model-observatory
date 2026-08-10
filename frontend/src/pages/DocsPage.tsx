import { useMemo, useState } from 'react'
import Markdown from 'react-markdown'
import remarkGfm from 'remark-gfm'
import { PageHeader } from '../components/ui'

/* Docs are rendered straight from the repository's own markdown so this page
 * cannot drift out of sync with docs/. The glob is eager because there are
 * five small files and a loading state would be more machinery than content. */
const modules = import.meta.glob('../../../docs/*.md', {
  query: '?raw',
  import: 'default',
  eager: true,
}) as Record<string, string>

const TITLES: Record<string, string> = {
  'PRODUCT_SPEC.md': '产品规格',
  'TRUST_AND_ANTI_POISONING.md': '信任与抗投毒',
  'CREDENTIAL_AND_NATIVE_DISCLOSURE.md': '凭据与 Native 披露',
  'COMMUNITY_REGISTRY.md': '社区模型数据库',
  'API_CONTRACT.md': '后端 API 草案',
}

const ORDER = Object.keys(TITLES)

interface Doc {
  file: string
  title: string
  content: string
}

const docs: Doc[] = Object.entries(modules)
  .map(([path, content]) => {
    const file = path.split('/').pop() ?? path
    return { file, title: TITLES[file] ?? file.replace('.md', ''), content }
  })
  .sort((a, b) => {
    const ai = ORDER.indexOf(a.file)
    const bi = ORDER.indexOf(b.file)
    return (ai === -1 ? ORDER.length : ai) - (bi === -1 ? ORDER.length : bi)
  })

export function DocsPage() {
  const [activeFile, setActiveFile] = useState(docs[0]?.file ?? '')
  const active = useMemo(
    () => docs.find((doc) => doc.file === activeFile) ?? docs[0],
    [activeFile],
  )

  if (!active) {
    return (
      <div className="stack">
        <PageHeader title="文档" description="未找到 docs/ 下的 markdown 文件。" />
      </div>
    )
  }

  return (
    <div className="stack">
      <PageHeader
        title="文档"
        description="方法论、信任边界与治理规则。内容直接来自仓库的 docs/ 目录。"
      />

      <div className="docs-layout">
        <nav className="docs-nav" aria-label="文档目录">
          {docs.map((doc) => (
            <button
              key={doc.file}
              type="button"
              className={doc.file === active.file ? 'docs-nav-item is-active' : 'docs-nav-item'}
              onClick={() => setActiveFile(doc.file)}
              aria-current={doc.file === active.file}
            >
              {doc.title}
              <code>{doc.file}</code>
            </button>
          ))}
        </nav>

        <article className="card card-pad prose">
          <Markdown remarkPlugins={[remarkGfm]}>{active.content}</Markdown>
        </article>
      </div>
    </div>
  )
}
