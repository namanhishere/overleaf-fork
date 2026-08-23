import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { getJSON } from '@/infrastructure/fetch-json'

type WorkerHealth = {
  id: string
  url: string
  ok: boolean
  error?: string
  concurrency?: { used: number; limit: number } | null
  diskFreePct?: number | null
  uptimeS?: number | null
  versions?: Record<string, string>
}

function WorkersDashboard() {
  const [data, setData] = useState<{ workers: WorkerHealth[]; checkedAt: string } | null>(
    null
  )

  async function refresh() {
    setData(await getJSON('/admin/api/workers'))
  }

  useEffect(() => {
    refresh()
    const timer = setInterval(refresh, 15000)
    return () => clearInterval(timer)
  }, [])

  return (
    <div>
      <h1>Compile workers</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/users">Users</a> ·{' '}
        <a href="/admin/jobs">Jobs</a> ·{' '}
        <a href="/admin/audit">Audit</a>
        {data ? ` · last checked ${new Date(data.checkedAt).toLocaleTimeString()}` : null}
      </p>
      {!data ? (
        <p>Loading…</p>
      ) : (
        <table className="table table-striped">
          <thead>
            <tr>
              <th>Worker</th>
              <th>Health</th>
              <th>Concurrency</th>
              <th>Disk free</th>
              <th>Uptime</th>
              <th>Error</th>
            </tr>
          </thead>
          <tbody>
            {data.workers.map(worker => (
              <tr key={worker.id}>
                <td>{worker.id}</td>
                <td>{worker.ok ? '✓' : '✗'}</td>
                <td>
                  {worker.concurrency
                    ? `${worker.concurrency.used} / ${worker.concurrency.limit}`
                    : '—'}
                </td>
                <td>
                  {worker.diskFreePct != null
                    ? `${worker.diskFreePct.toFixed(1)}%`
                    : '—'}
                </td>
                <td>
                  {worker.uptimeS != null
                    ? `${Math.floor(worker.uptimeS / 3600)}h ${Math.floor(
                        (worker.uptimeS % 3600) / 60
                      )}m`
                    : '—'}
                </td>
                <td className="text-danger">{worker.error || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  )
}

const element = document.getElementById('admin-workers-root')
if (element) {
  createRoot(element).render(<WorkersDashboard />)
}
