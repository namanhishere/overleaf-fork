import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getJSON } from "@/infrastructure/fetch-json";

type CompileStats = {
  total: number;
  byStatus: Record<string, number>;
  avgRuntimeMs: number | null;
  failureRate: number | null;
};

type Observability = {
  window: { since: string; hours: number };
  compiles: CompileStats;
  users: { total: number; admins: number; suspended: number };
  auditEntries: number;
  queue: { pending: number | null; dlq: number | null };
  workers: {
    checkedAt: string;
    workers: Array<{ id: string; ok: boolean; error?: string }>;
  } | null;
  aiUsage: {
    byPurpose: Array<{
      purpose: string;
      requests: number;
      promptTokens: number;
      completionTokens: number;
      estimatedCost: number;
    }>;
    totals: {
      requests: number;
      promptTokens: number;
      completionTokens: number;
      estimatedCost: number;
    };
    pricing: { prompt: number; completion: number };
  };
  generatedAt: string;
};

function Stat({ label, value }: { label: string; value: string | number }) {
  return (
    <div style={{ minWidth: 160 }}>
      <div style={{ fontSize: 28, fontWeight: 600 }}>{value}</div>
      <div style={{ color: "#67727e" }}>{label}</div>
    </div>
  );
}

function formatMs(ms: number | null) {
  if (ms == null) return "—";
  if (ms >= 1000) return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

function ObservabilityDashboard() {
  const [data, setData] = useState<Observability | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function refresh() {
    setError(null);
    try {
      setData(await getJSON<Observability>("/admin/api/observability"));
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
      <h1>Observability</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/users">Users</a> ·{" "}
        <a href="/admin/jobs">Jobs</a> · <a href="/admin/workers">Workers</a> ·{" "}
        <a href="/admin/audit">Audit</a>
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {!data && !error ? <p>Loading…</p> : null}
      {data ? (
        <>
          <p>
            Compiles over the last {data.window.hours}h · updated{" "}
            {new Date(data.generatedAt).toLocaleTimeString()}
          </p>
          <div style={{ display: "flex", gap: 32, flexWrap: "wrap" }}>
            <Stat label="Compiles (24h)" value={data.compiles.total} />
            <Stat
              label="Failure rate"
              value={
                data.compiles.failureRate == null
                  ? "—"
                  : `${data.compiles.failureRate}%`
              }
            />
            <Stat
              label="Avg runtime"
              value={formatMs(data.compiles.avgRuntimeMs)}
            />
            <Stat
              label="Queue pending"
              value={data.queue.pending == null ? "—" : data.queue.pending}
            />
            <Stat label="Dead-lettered" value={data.queue.dlq ?? "—"} />
            <Stat label="Users" value={data.users.total} />
            <Stat label="Suspended" value={data.users.suspended} />
            <Stat label="Audit events (24h)" value={data.auditEntries} />
          </div>
          <h2>Compile outcomes</h2>
          <table className="table table-striped" style={{ maxWidth: 480 }}>
            <thead>
              <tr>
                <th>Status</th>
                <th>Count</th>
              </tr>
            </thead>
            <tbody>
              {Object.entries(data.compiles.byStatus)
                .sort((a, b) => b[1] - a[1])
                .map(([status, count]) => (
                  <tr key={status}>
                    <td>
                      <code>{status}</code>
                    </td>
                    <td>{count}</td>
                  </tr>
                ))}
              {Object.keys(data.compiles.byStatus).length === 0 ? (
                <tr>
                  <td colSpan={2}>No compiles in the last 24h.</td>
                </tr>
              ) : null}
            </tbody>
          </table>
          <h2>Workers</h2>
          {data.workers ? (
            <table className="table table-striped" style={{ maxWidth: 480 }}>
              <thead>
                <tr>
                  <th>Worker</th>
                  <th>Health</th>
                </tr>
              </thead>
              <tbody>
                {data.workers.workers.map((w) => (
                  <tr key={w.id}>
                    <td>{w.id}</td>
                    <td>{w.ok ? "✓" : `✗ ${w.error || ""}`}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No worker health data yet — visit the Workers page.</p>
          )}
          <h2>AI usage (24h)</h2>
          <div
            style={{
              display: "flex",
              gap: 32,
              flexWrap: "wrap",
              marginBottom: 24,
            }}
          >
            <Stat label="AI requests" value={data.aiUsage.totals.requests} />
            <Stat
              label="Prompt tokens"
              value={data.aiUsage.totals.promptTokens.toLocaleString()}
            />
            <Stat
              label="Completion tokens"
              value={data.aiUsage.totals.completionTokens.toLocaleString()}
            />
            <Stat
              label={`Estimated cost ($${data.aiUsage.pricing.prompt}/$${data.aiUsage.pricing.completion} per 1M tok)`}
              value={`$${data.aiUsage.totals.estimatedCost.toFixed(4)}`}
            />
          </div>
          {data.aiUsage.byPurpose.length > 0 ? (
            <table style={{ marginBottom: 24, borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  {[
                    "Purpose",
                    "Requests",
                    "Prompt tok",
                    "Completion tok",
                    "Est. cost",
                  ].map((h) => (
                    <th
                      key={h}
                      style={{ textAlign: "left", padding: "4px 16px 4px 0" }}
                    >
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.aiUsage.byPurpose.map((r) => (
                  <tr key={r.purpose}>
                    <td style={{ paddingRight: 16 }}>{r.purpose}</td>
                    <td style={{ paddingRight: 16 }}>{r.requests}</td>
                    <td style={{ paddingRight: 16 }}>
                      {r.promptTokens.toLocaleString()}
                    </td>
                    <td style={{ paddingRight: 16 }}>
                      {r.completionTokens.toLocaleString()}
                    </td>
                    <td style={{ paddingRight: 16 }}>
                      ${r.estimatedCost.toFixed(4)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <p>No AI usage recorded in this window.</p>
          )}
        </>
      ) : null}
    </div>
  );
}

const element = document.getElementById("admin-observability-root");
if (element) {
  createRoot(element).render(<ObservabilityDashboard />);
}
