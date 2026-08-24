import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getJSON, putJSON } from "@/infrastructure/fetch-json";

type AiSettings = {
  enabled: boolean;
  baseUrl: string | null;
  model: string | null;
  maxIterations: number;
  apiKeySaved: boolean;
};

function AdminAi() {
  const [settings, setSettings] = useState<AiSettings | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getJSON<{ settings: AiSettings }>("/admin/api/ai")
      .then((data) =>
        setSettings({ ...data.settings, apiKeySaved: !!data.settings.apiKey }),
      )
      .catch((err) => setError(String(err.message)));
  }, []);

  async function save(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const body: Record<string, unknown> = {
        enabled: settings!.enabled,
        baseUrl: settings!.baseUrl,
        model: settings!.model,
        maxIterations: settings!.maxIterations,
      };
      if (apiKey) body.apiKey = apiKey;
      await putJSON("/admin/api/ai", { body });
      setMessage("Settings saved.");
      setApiKey("");
      const data = await getJSON<{ settings: AiSettings }>("/admin/api/ai");
      setSettings({ ...data.settings, apiKeySaved: !!data.settings.apiKey });
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  if (!settings) return <p>Loading…</p>;

  return (
    <div className="container">
      <h1>AI settings</h1>
      <p>
        <a href="/admin">Back to admin</a>
      </p>
      <p>
        Any OpenAI-compatible chat-completions endpoint works. The API key is
        write-only and never shown again.
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}
      <form onSubmit={save}>
        <label>
          <input
            type="checkbox"
            checked={settings.enabled}
            onChange={(e) =>
              setSettings({ ...settings, enabled: e.target.checked })
            }
          />{" "}
          Enabled
        </label>
        <br />
        <br />
        <input
          type="text"
          value={settings.baseUrl || ""}
          placeholder="Base URL (https://api.openai.com/v1)"
          size={44}
          onChange={(e) =>
            setSettings({ ...settings, baseUrl: e.target.value })
          }
        />
        <br />
        <br />
        <input
          type="text"
          value={settings.model || ""}
          placeholder="Model"
          onChange={(e) => setSettings({ ...settings, model: e.target.value })}
        />
        <br />
        <br />
        <input
          type="password"
          value={apiKey}
          placeholder={settings.apiKeySaved ? "API key saved" : "API key"}
          size={44}
          onChange={(e) => setApiKey(e.target.value)}
        />
        <br />
        <br />
        <label>
          Max agent iterations:{" "}
          <input
            type="number"
            min={1}
            max={10}
            value={settings.maxIterations}
            onChange={(e) =>
              setSettings({
                ...settings,
                maxIterations: parseInt(e.target.value, 10) || 3,
              })
            }
          />
        </label>
        <br />
        <br />
        <button type="submit" className="btn btn-primary">
          Save
        </button>
      </form>
    </div>
  );
}

const element = document.getElementById("admin-ai-root");
if (element) {
  createRoot(element).render(<AdminAi />);
}
