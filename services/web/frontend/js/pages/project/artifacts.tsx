import { createRoot } from 'react-dom/client'
import { useEffect, useRef, useState } from 'react'
import { getJSON } from '@/infrastructure/fetch-json'

type Artifact = {
  path: string
  id: string
  category: string
  created?: string
  linked?: boolean
}

const CATEGORY_LABELS: Record<string, string> = {
  data: 'Data (CSV, JSON, …)',
  figure: 'Figures (PNG, PDF, …)',
  code: 'Code (Python, R, …)',
  other: 'Other',
}

function ProjectArtifacts({ projectId }: { projectId: string }) {
  const [byCategory, setByCategory] = useState<Record<string, Artifact[]>>({})
  const [total, setTotal] = useState(0)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const fileInput = useRef<HTMLInputElement | null>(null)
  const [uploading, setUploading] = useState(false)

  async function refresh() {
    setError(null)
    try {
      const data = await getJSON<{
        byCategory: Record<string, Artifact[]>
        total: number
      }>(`/project/${projectId}/api/artifacts`)
      setByCategory(data.byCategory)
      setTotal(data.total)
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function upload(files: FileList | null) {
    if (!files || files.length === 0) return
    setUploading(true)
    setError(null)
    setMessage(null)
    try {
      for (const file of files) {
        const form = new FormData()
        form.append('name', file.name)
        form.append('qqfile', file, file.name)
        const res = await fetch(
          `/project/${projectId}/api/artifacts/upload`,
          { method: 'POST', body: form }
        )
        if (!res.ok) throw new Error(`Upload failed (${res.status})`)
      }
      setMessage('Upload complete.')
      refresh()
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setUploading(false)
      if (fileInput.current) fileInput.current.value = ''
    }
  }

  return (
    <div className="container">
      <h1>Research artifacts</h1>
      <p>
        <a href={`/project/${projectId}`}>Back to project</a> ·{' '}
        <a href={`/project/${projectId}/secrets`}>Secrets</a> ·{' '}
        <a href={`/project/${projectId}/ai`}>AI assistant</a>
      </p>
      <p>
        Non-source files of the project — data, figures, code and other
        research outputs — grouped by category. Uploads land in the{' '}
        <code>artifacts/</code> folder.
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}

      <p>
        <input
          ref={fileInput}
          type="file"
          multiple
          onChange={e => upload(e.target.files)}
        />{' '}
        {uploading ? 'Uploading…' : ''}
      </p>

      <p>{total} artifact{total === 1 ? '' : 's'}</p>
      {total === 0 ? (
        <p>
          No artifacts yet. Upload CSV/JSON data files, figures or analysis
          scripts — everything that is not a source document appears here.
        </p>
      ) : (
        Object.entries(byCategory).map(([category, files]) => (
          <div key={category} style={{ marginBottom: 24 }}>
            <h2>{CATEGORY_LABELS[category] || category}</h2>
            <table className="table table-striped" style={{ maxWidth: 720 }}>
              <thead>
                <tr>
                  <th>File</th>
                  <th>Added</th>
                  <th>Download</th>
                </tr>
              </thead>
              <tbody>
                {files.map(f => (
                  <tr key={f.id}>
                    <td>{f.path}</td>
                    <td>
                      {f.created
                        ? new Date(f.created).toLocaleDateString()
                        : '—'}
                    </td>
                    <td>
                      <a
                        className="btn btn-xs btn-default"
                        href={`/project/${projectId}/file/${f.id}`}
                      >
                        Download
                      </a>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))
      )}
    </div>
  )
}

const element = document.getElementById('project-artifacts-root')
if (element) {
  createRoot(element).render(
    <ProjectArtifacts projectId={element.getAttribute('data-project-id') || ''} />
  )
}
