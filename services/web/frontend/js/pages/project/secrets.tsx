import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getJSON, postJSON } from "@/infrastructure/fetch-json";

type SecretMeta = {
  key: string;
  createdAt: string;
  updatedAt: string;
};

function ProjectSecrets({ projectId }: { projectId: string }) {
  const [secrets, setSecrets] = useState<SecretMeta[]>([]);
  const [key, setKey] = useState("");
  const [value, setValue] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      const data = await getJSON<{ secrets: SecretMeta[] }>(
        `/project/${projectId}/api/secrets`,
      );
      setSecrets(data.secrets);
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      await postJSON(`/project/${projectId}/api/secrets`, {
        body: { key, value },
      });
      setMessage(`Secret ${key.toUpperCase()} saved (write-only).`);
      setKey("");
      setValue("");
      refresh();
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  async function remove(key: string) {
    setError(null);
    setMessage(null);
    try {
      const res = await fetch(`/project/${projectId}/api/secrets/${key}`, {
        method: "DELETE",
      });
      if (!res.ok && res.status !== 204) {
        throw new Error(`Delete failed (${res.status})`);
      }
      setMessage(`Secret ${key} deleted.`);
      refresh();
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  return (
    <div className="container">
      <h1>Project secrets</h1>
      <p>
        <a href={`/project/${projectId}`}>Back to project</a> ·{" "}
        <a href={`/project/${projectId}/ai`}>AI assistant</a>
      </p>
      <p>
        Secrets are encrypted at rest and are never returned by any API — only
        names are listed. They are injected into trusted runtime contexts
        (compilation, agents) and never appear in logs or source history.
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}

      <form onSubmit={save}>
        <input
          type="text"
          value={key}
          placeholder="NAME (e.g. ZENODO_TOKEN)"
          required
          onChange={(e) => setKey(e.target.value.toUpperCase())}
        />{" "}
        <input
          type="password"
          value={value}
          placeholder="Value"
          required
          size={36}
          onChange={(e) => setValue(e.target.value)}
        />{" "}
        <button type="submit" className="btn btn-primary">
          Save
        </button>
      </form>

      <h2>Secrets</h2>
      <table className="table table-striped" style={{ maxWidth: 640 }}>
        <thead>
          <tr>
            <th>Name</th>
            <th>Updated</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {secrets.map((s) => (
            <tr key={s.key}>
              <td>
                <code>{s.key}</code>
              </td>
              <td>{new Date(s.updatedAt).toLocaleString()}</td>
              <td>
                <button
                  className="btn btn-xs btn-danger"
                  onClick={() => remove(s.key)}
                >
                  Delete
                </button>
              </td>
            </tr>
          ))}
          {secrets.length === 0 ? (
            <tr>
              <td colSpan={3}>No secrets configured.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
    </div>
  );
}

const element = document.getElementById("project-secrets-root");
if (element) {
  createRoot(element).render(
    <ProjectSecrets
      projectId={element.getAttribute("data-project-id") || ""}
    />,
  );
}
