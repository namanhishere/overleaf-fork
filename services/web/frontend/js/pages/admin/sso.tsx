import { createRoot } from 'react-dom/client'
import { useEffect, useState } from 'react'
import { getJSON, postJSON } from '@/infrastructure/fetch-json'

type SsoProvider = {
  slug: string
  name: string
  type: 'oidc' | 'ldap'
  enabled: boolean
  issuerUrl: string | null
  clientId: string | null
  scopes: string
  autoRegister: boolean
  ldapUrl: string | null
  baseDn: string | null
}

const EMPTY_FORM = {
  slug: '',
  name: '',
  type: 'oidc',
  issuerUrl: '',
  clientId: '',
  clientSecret: '',
  scopes: 'openid email profile',
  ldapUrl: '',
  adminDn: '',
  adminPassword: '',
  baseDn: '',
  searchFilter: '(mail={{username}})',
  autoRegister: true,
  enabled: true,
}

async function patchJSON(url: string, body: unknown) {
  const res = await fetch(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  if (!res.ok) throw new Error(`Request failed (${res.status})`)
  return res.json()
}

async function deleteJSON(url: string) {
  const res = await fetch(url, { method: 'DELETE' })
  if (!res.ok && res.status !== 204)
    throw new Error(`Delete failed (${res.status})`)
}

function SsoDashboard() {
  const [providers, setProviders] = useState<SsoProvider[]>([])
  const [form, setForm] = useState({ ...EMPTY_FORM })
  const [message, setMessage] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function refresh() {
    try {
      const data = await getJSON<{ providers: SsoProvider[] }>('/admin/api/sso')
      setProviders(data.providers)
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  useEffect(() => {
    refresh()
  }, [])

  function set(field: keyof typeof EMPTY_FORM, value: string | boolean) {
    setForm(prev => ({ ...prev, [field]: value }))
  }

  async function createProvider(e: React.FormEvent) {
    e.preventDefault()
    setError(null)
    setMessage(null)
    try {
      await postJSON('/admin/api/sso', {
        body: {
          ...form,
          // Only send fields relevant to the selected type.
          ...(form.type === 'oidc'
            ? { ldapUrl: undefined, adminDn: undefined, adminPassword: undefined, baseDn: undefined, searchFilter: undefined }
            : { issuerUrl: undefined, clientId: undefined, clientSecret: undefined, scopes: undefined }),
        },
      })
      setForm({ ...EMPTY_FORM })
      setMessage('Provider created.')
      refresh()
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  async function toggleEnabled(p: SsoProvider) {
    setError(null)
    setMessage(null)
    try {
      await patchJSON(`/admin/api/sso/${p.slug}`, { enabled: !p.enabled })
      setMessage(`${p.slug} ${p.enabled ? 'disabled' : 'enabled'}.`)
      refresh()
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  async function removeProvider(slug: string) {
    setError(null)
    setMessage(null)
    try {
      await deleteJSON(`/admin/api/sso/${slug}`)
      setMessage(`${slug} deleted.`)
      refresh()
    } catch (err) {
      setError(String((err as Error).message))
    }
  }

  return (
    <div>
      <h1>SSO providers</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/users">Users</a> ·{' '}
        <a href="/admin/jobs">Jobs</a> · <a href="/admin/workers">Workers</a> ·{' '}
        <a href="/admin/storage">Storage</a> ·{' '}
        <a href="/admin/audit">Audit</a>
      </p>
      <p>
        OIDC identity providers are matched to local accounts by verified
        email. Enabled providers appear as login buttons on the login page.
        The client secret is write-only and never shown again.
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}

      <h2>New provider</h2>
      <form onSubmit={createProvider}>
        <select value={form.type} onChange={e => set('type', e.target.value)}>
          <option value="oidc">OIDC / OAuth2</option>
          <option value="ldap">LDAP</option>
        </select>{' '}
        <input
          type="text"
          value={form.slug}
          placeholder="slug (e.g. university-sso)"
          required
          onChange={e => set('slug', e.target.value)}
        />{' '}
        <input
          type="text"
          value={form.name}
          placeholder="Display name"
          required
          onChange={e => set('name', e.target.value)}
        />{' '}
        {form.type === 'oidc' ? (
          <>
            <input
              type="text"
              value={form.issuerUrl}
              placeholder="Issuer URL"
              required
              size={36}
              onChange={e => set('issuerUrl', e.target.value)}
            />{' '}
            <input
              type="text"
              value={form.clientId}
              placeholder="Client ID"
              required
              onChange={e => set('clientId', e.target.value)}
            />{' '}
            <input
              type="password"
              value={form.clientSecret}
              placeholder="Client secret"
              required
              onChange={e => set('clientSecret', e.target.value)}
            />{' '}
          </>
        ) : (
          <>
            <input
              type="text"
              value={form.ldapUrl}
              placeholder="LDAP URL (ldap://host:389)"
              required
              size={30}
              onChange={e => set('ldapUrl', e.target.value)}
            />{' '}
            <input
              type="text"
              value={form.baseDn}
              placeholder="Search base DN"
              required
              size={30}
              onChange={e => set('baseDn', e.target.value)}
            />{' '}
            <input
              type="text"
              value={form.adminDn}
              placeholder="Admin DN (optional)"
              size={28}
              onChange={e => set('adminDn', e.target.value)}
            />{' '}
            <input
              type="password"
              value={form.adminPassword}
              placeholder="Admin password"
              onChange={e => set('adminPassword', e.target.value)}
            />{' '}
            <input
              type="text"
              value={form.searchFilter}
              placeholder='Filter ({{username}})'
              size={24}
              onChange={e => set('searchFilter', e.target.value)}
            />{' '}
          </>
        )}
        <label>
          <input
            type="checkbox"
            checked={form.autoRegister}
            onChange={e => set('autoRegister', e.target.checked)}
          />{' '}
          Auto-register new users
        </label>{' '}
        <label>
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={e => set('enabled', e.target.checked)}
          />{' '}
          Enabled
        </label>{' '}
        <button type="submit" className="btn btn-primary">
          Create
        </button>
      </form>

      <h2>Providers</h2>
      <table className="table table-striped">
        <thead>
          <tr>
            <th>Slug</th>
            <th>Type</th>
            <th>Name</th>
            <th>Issuer / LDAP URL</th>
            <th>Auto-register</th>
            <th>Status</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {providers.map(p => (
            <tr key={p.slug}>
              <td>
                <code>{p.slug}</code>
              </td>
              <td>{p.type}</td>
              <td>{p.name}</td>
              <td>{p.type === 'ldap' ? p.ldapUrl : p.issuerUrl}</td>
              <td>{p.autoRegister ? 'yes' : 'no'}</td>
              <td>{p.enabled ? 'Enabled' : 'Disabled'}</td>
              <td>
                <button
                  className="btn btn-xs btn-default"
                  onClick={() => toggleEnabled(p)}
                >
                  {p.enabled ? 'Disable' : 'Enable'}
                </button>{' '}
                <button
                  className="btn btn-xs btn-danger"
                  onClick={() => removeProvider(p.slug)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {providers.length === 0 ? (
            <tr>
              <td colSpan={7}>No providers configured yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  )
}

const element = document.getElementById('admin-sso-root')
if (element) {
  createRoot(element).render(<SsoDashboard />)
}
