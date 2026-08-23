import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'

type Profile = {
  slug: string
  label: string
  imageName: string | null
  compiler: string | null
  texLiveVersion: string | null
  timeoutMinutes: number | null
  description: string
}

const EMPTY_FORM = {
  slug: '',
  label: '',
  imageName: '',
  compiler: '',
  texLiveVersion: '',
  timeoutMinutes: '',
  description: '',
}

function ProfilesDashboard() {
  const [profiles, setProfiles] = useState<Profile[]>([])
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [applySlug, setApplySlug] = useState('')
  const [applyProjectId, setApplyProjectId] = useState('')
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      const data = await getJSON<{ profiles: Profile[] }>(
        '/admin/api/profiles'
      )
      setProfiles(data.profiles)
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  function set(field: keyof typeof EMPTY_FORM, value: string) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function createProfile(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    try {
      await postJSON('/admin/api/profiles', { body: form })
      setForm({ ...EMPTY_FORM })
      setMessage(`Profile created.`)
      refresh()
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  async function removeProfile(slug: string) {
    setError(null)
    setMessage(null)
    try {
      const res = await fetch(`/admin/api/profiles/${slug}`, {
        method: 'DELETE',
      })
      if (!res.ok && res.status !== 204) {
        throw new Error(`Delete failed (${res.status})`)
      }
      setMessage(`Profile ${slug} deleted.`)
      refresh()
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  async function applyProfile(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    try {
      const res = await fetch(`/admin/api/profiles/${applySlug}/apply`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectId: applyProjectId.trim() }),
      })
      const body = await res.json()
      if (!res.ok) throw new Error(body.error || `Apply failed (${res.status})`)
      setMessage(
        `Applied ${applySlug} to project (compiler: ${
          body.applied.compiler || 'unchanged'
        }, image: ${body.applied.imageName || 'default'}).`
      )
      setApplyProjectId('')
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  return (
    <div>
      <h1>Compilation profiles</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/users">Users</a> ·{' '}
        <a href="/admin/jobs">Jobs</a> · <a href="/admin/workers">Workers</a> ·{' '}
        <a href="/admin/audit">Audit</a>
      </p>
      <p>
        A profile pins a compile environment (image, compiler, TeX Live
        version, timeout). Applying a profile to a project sets its compiler
        and image; every compile job and release then records what was used.
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}

      <h2>New profile</h2>
      <form onSubmit={createProfile}>
        <input
          type="text"
          value={form.slug}
          placeholder="slug (e.g. texlive-2026)"
          required
          onChange={e => set('slug', e.target.value)}
        />{' '}
        <input
          type="text"
          value={form.label}
          placeholder="Label"
          required
          onChange={e => set('label', e.target.value)}
        />{' '}
        <input
          type="text"
          value={form.imageName}
          placeholder="Image (blank = default)"
          onChange={e => set('imageName', e.target.value)}
        />{' '}
        <select
          value={form.compiler}
          onChange={e => set('compiler', e.target.value)}
        >
          <option value="">Compiler (project choice)</option>
          <option value="pdflatex">pdflatex</option>
          <option value="xelatex">xelatex</option>
          <option value="lualatex">lualatex</option>
          <option value="latex">latex</option>
        </select>{' '}
        <input
          type="text"
          value={form.texLiveVersion}
          placeholder="TeX Live version"
          onChange={e => set('texLiveVersion', e.target.value)}
        />{' '}
        <input
          type="number"
          min={1}
          max={30}
          value={form.timeoutMinutes}
          placeholder="Timeout (min)"
          onChange={e => set('timeoutMinutes', e.target.value)}
        />{' '}
        <button type="submit" className="btn btn-primary">
          Create
        </button>
      </form>

      <h2>Profiles</h2>
      <table className="table table-striped">
        <thead>
          <tr>
            <th>Slug</th>
            <th>Label</th>
            <th>Image</th>
            <th>Compiler</th>
            <th>TeX Live</th>
            <th>Timeout</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {profiles.map(p => (
            <tr key={p.slug}>
              <td>
                <code>{p.slug}</code>
              </td>
              <td>{p.label}</td>
              <td>{p.imageName || 'default'}</td>
              <td>{p.compiler || '—'}</td>
              <td>{p.texLiveVersion || '—'}</td>
              <td>{p.timeoutMinutes ? `${p.timeoutMinutes}m` : '—'}</td>
              <td>
                <button
                  className="btn btn-xs btn-danger"
                  onClick={() => removeProfile(p.slug)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {profiles.length === 0 ? (
            <tr>
              <td colSpan={7}>No profiles defined yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      <h2>Apply profile to project</h2>
      <form onSubmit={applyProfile}>
        <select
          value={applySlug}
          required
          onChange={e => setApplySlug(e.target.value)}
        >
          <option value="">Choose profile…</option>
          {profiles.map(p => (
            <option key={p.slug} value={p.slug}>
              {p.label} ({p.slug})
            </option>
          ))}
        </select>{' '}
        <input
          type="text"
          value={applyProjectId}
          placeholder="Project ID (24 hex chars)"
          required
          size={30}
          onChange={e => setApplyProjectId(e.target.value)}
        />{' '}
        <button type="submit" className="btn btn-primary">
          Apply
        </button>
      </form>
    </div>
  )
}

const element = document.getElementById('admin-profiles-root')
if (element) {
  createRoot(element).render(<ProfilesDashboard />)
}
