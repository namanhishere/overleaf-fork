import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getJSON, postJSON } from "@/infrastructure/fetch-json";

type CompileJob = {
  jobId: string;
  projectId: string;
  userId?: string;
  status: string;
  workerId?: string;
  pid?: number;
  queuedAt: string;
  startedAt?: string;
  finishedAt?: string;
  runtimeMs?: number;
  peakCpuPercent?: number;
  peakRssBytes?: number;
  peakDiskBytes?: number;
  imageName?: string;
  compiler?: string;
  error?: string;
};

function formatBytes(bytes?: number) {
  if (bytes == null) return "—";
  const mb = bytes / (1024 * 1024);
  if (mb >= 1024) return `${(mb / 1024).toFixed(2)} GB`;
  return `${mb.toFixed(0)} MB`;
}

function JobsDashboard() {
  const [jobs, setJobs] = useState<CompileJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [logText, setLogText] = useState<string | null>(null);

  async function refresh() {
    const data = await getJSON<{ jobs: CompileJob[] }>(
      "/admin/api/jobs?limit=50",
    );
    setJobs(data.jobs);
    return data.jobs;
  }

  useEffect(() => {
    let timer: NodeJS.Timeout | undefined;
    let stopped = false;
    async function tick() {
      try {
        const current = await refresh();
        // Poll faster while anything is running.
        if (!stopped) {
          timer = setTimeout(
            tick,
            current.some((j) => j.status === "running") ? 5000 : 15000,
          );
        }
      } catch {
        // Back off on errors (e.g. rate limits) instead of retrying hot.
        if (!stopped) {
          timer = setTimeout(tick, 30000);
        }
      }
    }
    tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  async function kill(jobId: string) {
    await postJSON(`/admin/api/jobs/${jobId}/kill`);
    refresh();
  }

  async function retry(jobId: string) {
    setError(null);
    setMessage(null);
    try {
      const res = await postJSON(`/admin/api/jobs/${jobId}/retry`);
      setMessage(`Retry started (${res.result}).`);
      refresh();
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  async function showLog(jobId: string) {
    const data = await getJSON<{ logExcerpt: string | null }>(
      `/admin/api/jobs/${jobId}/log`,
    );
    setLogText(data.logExcerpt || "(no log captured)");
  }

  return (
    <div>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}
      <h1>Compile jobs</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/users">Users</a> ·{" "}
        <a href="/admin/workers">Workers</a> · <a href="/admin/audit">Audit</a>
      </p>
      {logText ? (
        <div className="alert alert-default">
          <pre style={{ whiteSpace: "pre-wrap" }}>{logText}</pre>
          <button
            className="btn btn-xs btn-default"
            onClick={() => setLogText(null)}
          >
            Close log
          </button>
        </div>
      ) : null}
      <table className="table table-striped">
        <thead>
          <tr>
            <th>Job</th>
            <th>Project</th>
            <th>User</th>
            <th>Worker</th>
            <th>Status</th>
            <th>Runtime</th>
            <th>CPU</th>
            <th>RAM</th>
            <th>Disk</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {jobs.map((job) => (
            <tr key={job.jobId}>
              <td>{job.jobId.slice(0, 8)}</td>
              <td>{String(job.projectId).slice(0, 8)}…</td>
              <td>{job.userId ? `${String(job.userId).slice(0, 8)}…` : "—"}</td>
              <td>{job.workerId || "—"}</td>
              <td>{job.status}</td>
              <td>
                {job.runtimeMs != null
                  ? `${(job.runtimeMs / 1000).toFixed(1)}s`
                  : "—"}
              </td>
              <td>
                {job.peakCpuPercent != null ? `${job.peakCpuPercent}%` : "—"}
              </td>
              <td>{formatBytes(job.peakRssBytes)}</td>
              <td>{formatBytes(job.peakDiskBytes)}</td>
              <td>
                {job.status === "queued" || job.status === "running" ? (
                  <button
                    className="btn btn-xs btn-danger"
                    onClick={() => kill(job.jobId)}
                  >
                    Kill
                  </button>
                ) : null}
                {["failed", "timeout", "cancelled"].includes(job.status) ? (
                  <button
                    className="btn btn-xs btn-warning"
                    onClick={() => retry(job.jobId)}
                  >
                    Retry
                  </button>
                ) : null}{" "}
                <button
                  className="btn btn-xs btn-default"
                  onClick={() => showLog(job.jobId)}
                >
                  Logs
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const element = document.getElementById("admin-jobs-root");
if (element) {
  createRoot(element).render(<JobsDashboard />);
}
