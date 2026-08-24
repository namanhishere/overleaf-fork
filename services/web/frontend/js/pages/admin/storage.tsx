import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getJSON } from "@/infrastructure/fetch-json";

type MongoMember = { name: string; state: string; healthy: boolean };
type MongoHealth = {
  replicaSet: boolean | null;
  setName?: string | null;
  healthy: boolean;
  standalone?: boolean;
  members?: MongoMember[];
  error?: string;
};
type ServiceHealth = {
  name: string;
  url?: string;
  configured?: boolean;
  healthy: boolean | null;
  error?: string;
};
type StorageHealth = {
  mongo: MongoHealth;
  services: ServiceHealth[];
  checkedAt: string;
};

function StorageDashboard() {
  const [data, setData] = useState<StorageHealth | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      setData(await getJSON<StorageHealth>("/admin/api/storage"));
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 30000);
    return () => clearInterval(timer);
  }, []);

  return (
    <div>
      <h1>Storage health</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/users">Users</a> ·{" "}
        <a href="/admin/jobs">Jobs</a> · <a href="/admin/workers">Workers</a> ·{" "}
        <a href="/admin/audit">Audit</a>
        {data
          ? ` · last checked ${new Date(data.checkedAt).toLocaleTimeString()}`
          : null}
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {!data && !error ? <p>Loading…</p> : null}
      {data ? (
        <>
          <h2>MongoDB</h2>
          {data.mongo.replicaSet ? (
            <table className="table table-striped" style={{ maxWidth: 560 }}>
              <thead>
                <tr>
                  <th>Member</th>
                  <th>State</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {data.mongo.members!.map((m) => (
                  <tr key={m.name}>
                    <td>{m.name}</td>
                    <td>{m.state}</td>
                    <td>{m.healthy ? "✓" : "✗"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : data.mongo.standalone ? (
            <p>Standalone MongoDB (no replication) — single-node deployment.</p>
          ) : (
            <p className="text-danger">
              MongoDB status unavailable: {data.mongo.error || "unknown error"}
            </p>
          )}
          <h2>Storage services</h2>
          <table className="table table-striped" style={{ maxWidth: 720 }}>
            <thead>
              <tr>
                <th>Service</th>
                <th>URL</th>
                <th>Health</th>
              </tr>
            </thead>
            <tbody>
              {data.services.map((s) => (
                <tr key={s.name}>
                  <td>{s.name}</td>
                  <td>{s.url || "not configured"}</td>
                  <td>
                    {s.healthy == null
                      ? "—"
                      : s.healthy
                        ? "✓"
                        : `✗ ${s.error || ""}`}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      ) : null}
    </div>
  );
}

const element = document.getElementById("admin-storage-root");
if (element) {
  createRoot(element).render(<StorageDashboard />);
}
