import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'

type Proposal = {
  _id: string
  path: string
  status: string
  summary: string
  diff: string[]
}

function ProjectAi({ projectId }: { projectId: string }) {
  const [task, setTask] = useState('')
  const [running, setRunning] = useState(false)
  const [transcript, setTranscript] = useState<
    { tool?: string; assistant?: string; result?: string }[]
  >([])
  const [error, setError] = useState<string | null>(null)
  const [proposals, setProposals] = useState<Proposal[]>([])
  const [message, setMessage] = useState<string | null>(null)

  async function refreshProposals() {
    try {
      const data = await getJSON<{ proposals: Proposal[] }>(
        `/project/${projectId}/api/ai/proposals`
      )
      setProposals(data.proposals)
    } catch {
      /* ignore */
    }
  }

  useEffect(() => {
    refreshProposals()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function run(e: React.FormEvent) {
    e.preventDefault()
    if (!task.trim()) return
    setRunning(true)
    setError(null)
    setMessage(null)
    try {
      const result = await postJSON(`/project/${projectId}/api/ai/run`, {
        body: { task },
      })
      setTranscript(result.transcript || [])
      setTask('')
      refreshProposals()
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setRunning(false)
    }
  }

  async function resolve(id: string, action: 'apply' | 'reject') {
    setError(null)
    setMessage(null)
    try {
      await postJSON(`/project/${projectId}/api/ai/proposals/${id}/${action}`, {
        body: {},
      })
      setMessage(action === 'apply' ? 'Change applied.' : 'Change rejected.')
      refreshProposals()
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  async function runInit() {
    setError(null)
    setMessage(null)
    try {
      const res = await postJSON(`/project/${projectId}/api/ai/init`, {
        body: {},
      })
      setMessage(`Generated ${res.path}`)
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  return (
    <div className="container">
      <h1>AI assistant</h1>
      <p>
        <a href={`/project/${projectId}`}>Back to project</a> ·{' '}
        <button className="btn btn-default btn-sm" onClick={runInit}>
          /init — generate agents.md
        </button>
      </p>
      <p>
        The agent can read files, propose file changes, compile and read logs.
        Proposed changes are applied only after you approve them.
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}

      <form onSubmit={run}>
        <textarea
          value={task}
          placeholder="Describe a task, e.g. 'Fix the LaTeX errors in main.tex'"
          rows={3}
          style={{ width: '100%', maxWidth: 720 }}
          onChange={e => setTask(e.target.value)}
        />
        <br />
        <button type="submit" className="btn btn-primary" disabled={running}>
          {running ? 'Running…' : 'Run agent'}
        </button>
      </form>

      {transcript.length > 0 ? (
        <>
          <h2>Agent transcript</h2>
          <pre style={{ maxWidth: 760, whiteSpace: 'pre-wrap' }}>
            {transcript
              .map(t =>
                t.assistant
                  ? `AI: ${t.assistant}`
                  : `[tool] ${t.tool} → ${String(t.result).slice(0, 200)}`
              )
              .join('\n\n')}
          </pre>
        </>
      ) : null}

      <h2>Pending proposals</h2>
      {proposals.length === 0 ? (
        <p>No pending proposals.</p>
      ) : (
        proposals.map(p => (
          <div
            key={p._id}
            style={{
              border: '1px solid #ddd',
              padding: 12,
              marginBottom: 16,
              maxWidth: 760,
            }}
          >
            <div>
              <code>{p.path}</code> — {p.summary || 'file change'}
            </div>
            <pre
              style={{
                background: '#f6f6f6',
                padding: 8,
                fontSize: 12,
                maxHeight: 240,
                overflow: 'auto',
              }}
            >
              {p.diff.join('\n')}
            </pre>
            <button
              className="btn btn-xs btn-primary"
              onClick={() => resolve(p._id, 'apply')}
            >
              Accept
            </button>{' '}
            <button
              className="btn btn-xs btn-default"
              onClick={() => resolve(p._id, 'reject')}
            >
              Reject
            </button>
          </div>
        ))
      )}
    </div>
  )
}

const element = document.getElementById('project-ai-root')
if (element) {
  createRoot(element).render(
    <ProjectAi projectId={element.getAttribute('data-project-id') || ''} />
  )
}
