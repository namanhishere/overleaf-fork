import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'

type CollectionBackup = {
  name: string
  count: number
  file: string
  sizeBytes: number
}

type BackupRun = {
  runId: string
  label: string
  status: 'running' | 'complete' | 'failed'
  startedAt: string
  finishedAt: string | null
  collections: CollectionBackup[]
  error: string | null
  restoreTest: {
    at: string
    targetDb: string
    ok: boolean
    results: { name: string; expected: number; restored: number; ok: boolean }[]
  } | null
  onDisk: boolean
}

function formatBytes(n: number) {
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`
  return `${n} B`
}

function BackupsDashboard() {
  const [backups, setBackups] = useState<BackupRun[]>([])
  const [label, setLabel] = useState('')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [expanded, setExpanded] = useState<string | null>(null)

  async function refresh() {
    setError(null)
    try {
      const data = await getJSON<{ backups: BackupRun[] }>('/admin/api/backups')
      setBackups(data.backups)
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  async function runBackup(e: React.FormEvent) {
    e.preventDefault()
    setBusy(true)
    setError(null)
    setMessage(null)
    try {
      await postJSON('/admin/api/backups', { body: { label } })
      setMessage('Backup completed.')
      setLabel('')
      refresh()
    } catch (err) {
      setError(String((err as Error).message))
    } finally {
      setBusy(false)
    }
  }

  async function restoreTest(runId: string) {
    setError(null)
    setMessage(null)
    try {
      const res = await postJSON(`/admin/api/backups/${runId}/restore-test`, {
        body: {},
      })
      setMessage(
        `Restore test ${res.ok ? 'passed' : 'FAILED'} — restored into ${res.targetDb}.`
      )
      refresh()
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  return (
    <div>
      <h1>Backups</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/users">Users</a> ·{' '}
        <a href="/admin/jobs">Jobs</a> ·{' '}
        <a href="/admin/storage">Storage</a> ·{' '}
        <a href="/admin/audit">Audit</a>
      </p>
      <p>
        Logical backup of all database collections into gzip-compressed JSON
        archives. Run a restore test to verify a backup can be replayed into a
        scratch database with document counts verified against the manifest.
        For very large deployments, binary <code>mongodump</code> remains the
        recommended production path.
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}

      <form onSubmit={runBackup}>
        <input
          type="text"
          value={label}
          placeholder="Label (optional)"
          onChange={e => setLabel(e.target.value)}
        />{' '}
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Running…' : 'Run backup now'}
        </button>
      </form>

      <h2>Backup runs</h2>
      <table className="table table-striped">
        <thead>
          <tr>
            <th>Run</th>
            <th>Label</th>
            <th>Status</th>
            <th>Started</th>
            <th>Collections</th>
            <th>Restore test</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {backups.map(b => (
            <tr key={b.runId}>
              <td>
                <a
                  href="#"
                  onClick={e => {
                    e.preventDefault()
                    setExpanded(expanded === b.runId ? null : b.runId)
                  }}
                >
                  {b.runId.slice(7, 31)}
                </a>
                {!b.onDisk ? ' (files missing)' : ''}
              </td>
              <td>{b.label || '—'}</td>
              <td>{b.status}</td>
              <td>{new Date(b.startedAt).toLocaleString()}</td>
              <td>{b.collections.length}</td>
              <td>
                {b.restoreTest
                  ? b.restoreTest.ok
                    ? `✓ passed`
                    : '✗ failed'
                  : '—'}
              </td>
              <td>
                {b.status === 'complete' && b.onDisk ? (
                  <button
                    className="btn btn-xs btn-default"
                    onClick={() => restoreTest(b.runId)}
                  >
                    Restore test
                  </button>
                ) : null}
              </td>
            </tr>
          ))}
          {backups.length === 0 ? (
            <tr>
              <td colSpan={7}>No backups yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {expanded
        ? backups
            .filter(b => b.runId === expanded)
            .map(b => (
              <div key={b.runId}>
                <h3>Collections — {b.runId.slice(7, 31)}</h3>
                <table className="table table-condensed" style={{ maxWidth: 640 }}>
                  <thead>
                    <tr>
                      <th>Collection</th>
                      <th>Documents</th>
                      <th>Size</th>
                      <th>Download</th>
                    </tr>
                  </thead>
                  <tbody>
                    {b.collections.map(c => (
                      <tr key={c.name}>
                        <td>
                          <code>{c.name}</code>
                        </td>
                        <td>{c.count}</td>
                        <td>{formatBytes(c.sizeBytes)}</td>
                        <td>
                          <a
                            className="btn btn-xs btn-default"
                            href={`/admin/api/backups/${b.runId}/file/${c.name}`}
                          >
                            .json.gz
                          </a>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {b.restoreTest ? (
                  <p>
                    Last restore test: {b.restoreTest.ok ? 'passed' : 'failed'}{' '}
                    at {new Date(b.restoreTest.at).toLocaleString()} into{' '}
                    <code>{b.restoreTest.targetDb}</code>.
                  </p>
                ) : null}
              </div>
            ))
        : null}
    </div>
  )
}

const element = document.getElementById('admin-backups-root')
if (element) {
  createRoot(element).render(<BackupsDashboard />)
}
