import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getJSON, postJSON } from "@/infrastructure/fetch-json";

type WorkerHealth = {
  id: string;
  url: string;
  ok: boolean;
  error?: string;
  concurrency?: { used: number; limit: number } | null;
  diskFreePct?: number | null;
  uptimeS?: number | null;
  versions?: Record<string, string>;
};

function WorkersDashboard() {
  const [data, setData] = useState<{
    workers: WorkerHealth[];
    checkedAt: string;
  } | null>(null);

  async function refresh() {
    setData(await getJSON("/admin/api/workers"));
  }

  useEffect(() => {
    refresh();
    const timer = setInterval(refresh, 15000);
    return () => clearInterval(timer);
  }, []);

  const [pinProjectId, setPinProjectId] = useState("");
  const [pinWorkerId, setPinWorkerId] = useState("");
  const [pinMessage, setPinMessage] = useState<string | null>(null);
  const [pinError, setPinError] = useState<string | null>(null);

  async function submitPin(e: React.FormEvent) {
    e.preventDefault();
    setPinError(null);
    setPinMessage(null);
    try {
      const body = await postJSON("/admin/api/workers/pin", {
        body: { projectId: pinProjectId.trim(), workerId: pinWorkerId || null },
      });
      setPinMessage(
        body.workerId
          ? `Project pinned to ${body.workerId}.`
          : "Pin cleared — project uses automatic placement.",
      );
      setPinProjectId("");
      setPinWorkerId("");
    } catch (err) {
      setPinError(String((err as Error).message));
    }
  }

  return (
    <div>
      <h1>Compile workers</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/users">Users</a> ·{" "}
        <a href="/admin/jobs">Jobs</a> · <a href="/admin/audit">Audit</a>
        {data
          ? ` · last checked ${new Date(data.checkedAt).toLocaleTimeString()}`
          : null}
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
            {data.workers.map((worker) => (
              <tr key={worker.id}>
                <td>{worker.id}</td>
                <td>{worker.ok ? "✓" : "✗"}</td>
                <td>
                  {worker.concurrency
                    ? `${worker.concurrency.used} / ${worker.concurrency.limit}`
                    : "—"}
                </td>
                <td>
                  {worker.diskFreePct != null
                    ? `${worker.diskFreePct.toFixed(1)}%`
                    : "—"}
                </td>
                <td>
                  {worker.uptimeS != null
                    ? `${Math.floor(worker.uptimeS / 3600)}h ${Math.floor(
                        (worker.uptimeS % 3600) / 60,
                      )}m`
                    : "—"}
                </td>
                <td className="text-danger">{worker.error || ""}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>Pin a project to a worker</h2>
      <form onSubmit={submitPin}>
        <select
          value={pinWorkerId}
          onChange={(e) => setPinWorkerId(e.target.value)}
        >
          <option value="">Automatic placement</option>
          {(data ? data.workers : []).map((w) => (
            <option key={w.id} value={w.id}>
              {w.id} {w.ok ? "" : "(unhealthy)"}
            </option>
          ))}
        </select>{" "}
        <input
          type="text"
          value={pinProjectId}
          placeholder="Project ID (24 hex chars)"
          required
          size={30}
          onChange={(e) => setPinProjectId(e.target.value)}
        />{" "}
        <button type="submit" className="btn btn-primary">
          Pin
        </button>
      </form>
      {pinError ? <p className="text-danger">{pinError}</p> : null}
      {pinMessage ? <p className="text-success">{pinMessage}</p> : null}
    </div>
  );
}

const element = document.getElementById("admin-workers-root");
if (element) {
  createRoot(element).render(<WorkersDashboard />);
}
