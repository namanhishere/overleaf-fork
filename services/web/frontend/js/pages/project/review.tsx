import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'

type Thread = {
  threadId: string
  resolved: boolean
  messageCount: number
  firstMessage: string
  lastActivity: string | null
}

type Member = { _id: string; name: string; email: string | null }
type Reviewer = { _id: string; name: string; email: string | null }

type ReviewData = {
  threads: Thread[]
  total: number
  unresolved: number
  resolved: number
  summary: string
  reviewers: Reviewer[]
  members: Member[]
}

function ProjectReview({ projectId }: { projectId: string }) {
  const [data, setData] = useState<ReviewData | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [selectedMember, setSelectedMember] = useState('')
  const [summary, setSummary] = useState<string | null>(null)
  const [summarizing, setSummarizing] = useState(false)
  const [gitInfo, setGitInfo] = useState<{
    enabled: boolean
    cloneUrl: string | null
    authNote?: string
  } | null>(null)

  async function refresh() {
    setError(null)
    try {
      setData(await getJSON<ReviewData>(`/project/${projectId}/api/review`))
      getJSON<{ enabled: boolean; cloneUrl: string | null; authNote?: string }>(
        `/project/${projectId}/api/git`
      )
        .then(setGitInfo)
        .catch(() => {})
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  async function summarize() {
    setError(null)
    setSummarizing(true)
    try {
      const res = await postJSON(
        `/project/${projectId}/api/review/summarize`,
        { body: {} }
      )
      setSummary(res.summary)
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setSummarizing(false)
    }
  }

  useEffect(() => {
    refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId])

  async function resolve(threadId: string, action: 'resolve' | 'reopen') {
    await postJSON(`/project/${projectId}/api/review/threads/${threadId}/${action}`, {
      body: {},
    })
    refresh()
  }

  async function addReviewer(e: React.FormEvent) {
    e.preventDefault()
    if (!selectedMember) return
    setError(null)
    try {
      await postJSON(`/project/${projectId}/api/review/reviewers`, {
        body: { reviewerId: selectedMember },
      })
      setSelectedMember('')
      refresh()
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  async function removeReviewer(reviewerId: string) {
    const res = await fetch(
      `/project/${projectId}/api/review/reviewers/${reviewerId}`,
      { method: 'DELETE' }
    )
    if (!res.ok && res.status !== 204) {
      setError(`Remove failed (${res.status})`)
      return
    }
    refresh()
  }

  return (
    <div className="container">
      <h1>Review</h1>
      <p>
        <a href={`/project/${projectId}`}>Back to project</a>
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {!data ? (
        <p>Loading…</p>
      ) : (
        <>
          <p>
            <strong>{data.summary}</strong>{' '}
            <button
              className="btn btn-xs btn-default"
              disabled={summarizing}
              onClick={summarize}
            >
              {summarizing ? 'Summarizing…' : 'AI summarize'}
            </button>
          </p>
          {summary ? (
            <p style={{ maxWidth: 720, fontStyle: 'italic' }}>{summary}</p>
          ) : null}

          <h2>Comment threads</h2>
          {data.threads.length === 0 ? (
            <p>No review comments in this project.</p>
          ) : (
            <table className="table table-striped" style={{ maxWidth: 760 }}>
              <thead>
                <tr>
                  <th>Comment</th>
                  <th>Messages</th>
                  <th>Status</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {data.threads.map(t => (
                  <tr key={t.threadId} style={t.resolved ? { opacity: 0.6 } : {}}>
                    <td>{t.firstMessage}</td>
                    <td>{t.messageCount}</td>
                    <td>{t.resolved ? 'Resolved' : 'Unresolved'}</td>
                    <td>
                      <button
                        className="btn btn-xs btn-default"
                        onClick={() =>
                          resolve(t.threadId, t.resolved ? 'reopen' : 'resolve')
                        }
                      >
                        {t.resolved ? 'Reopen' : 'Resolve'}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}

          <h2>Reviewers</h2>
          <ul>
            {data.reviewers.map(r => (
              <li key={r._id}>
                {r.name} ({r.email}){' '}
                <button
                  className="btn btn-xs btn-default"
                  onClick={() => removeReviewer(r._id)}
                >
                  Remove
                </button>
              </li>
            ))}
            {data.reviewers.length === 0 ? <li>No reviewers assigned.</li> : null}
          </ul>
          <form onSubmit={addReviewer}>
            <select
              value={selectedMember}
              required
              onChange={e => setSelectedMember(e.target.value)}
            >
              <option value="">Assign a reviewer…</option>
              {data.members
                .filter(m => !data.reviewers.some(r => r._id === m._id))
                .map(m => (
                  <option key={m._id} value={m._id}>
                    {m.name} ({m.email})
                  </option>
                ))}
            </select>{' '}
            <button type="submit" className="btn btn-primary">
              Assign
            </button>
          </form>

          <h2>Git</h2>
          {gitInfo && gitInfo.enabled && gitInfo.cloneUrl ? (
            <p>
              Clone:{' '}
              <code>{gitInfo.cloneUrl}</code>
              <br />
              <small>{gitInfo.authNote}</small>
            </p>
          ) : (
            <p>Git integration is not available for this deployment.</p>
          )}
        </>
      )}
    </div>
  )
}

const element = document.getElementById('project-review-root')
if (element) {
  createRoot(element).render(
    <ProjectReview projectId={element.getAttribute('data-project-id') || ''} />
  )
}
