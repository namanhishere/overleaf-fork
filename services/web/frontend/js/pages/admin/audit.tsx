import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getJSON } from "@/infrastructure/fetch-json";

type AuditEntry = {
  _id: string;
  action: string;
  actorId?: string;
  actorType?: string;
  targetType: string;
  targetId?: string;
  projectId?: string | null;
  ipAddress?: string;
  timestamp: string;
};

type Filters = {
  action: string;
  targetType: string;
  actorId: string;
};

const PAGE_SIZE = 50;

function formatTime(iso: string) {
  const d = new Date(iso);
  return isNaN(d.getTime()) ? iso : d.toLocaleString();
}

function shortId(id?: string) {
  if (!id) return "—";
  return id.length > 12 ? `${id.slice(0, 12)}…` : id;
}

function AuditDashboard() {
  const [entries, setEntries] = useState<AuditEntry[]>([]);
  const [total, setTotal] = useState(0);
  const [offset, setOffset] = useState(0);
  const [filters, setFilters] = useState<Filters>({
    action: "",
    targetType: "",
    actorId: "",
  });
  const [error, setError] = useState<string | null>(null);

  async function load(nextOffset: number, f: Filters) {
    setError(null);
    try {
      const params = new URLSearchParams();
      params.set("limit", String(PAGE_SIZE));
      params.set("offset", String(nextOffset));
      if (f.action) params.set("action", f.action);
      if (f.targetType) params.set("targetType", f.targetType);
      if (f.actorId) params.set("actorId", f.actorId);
      const data = await getJSON<{ entries: AuditEntry[]; total: number }>(
        `/admin/api/audit?${params.toString()}`,
      );
      setEntries(data.entries);
      setTotal(data.total);
      setOffset(nextOffset);
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  useEffect(() => {
    load(0, filters);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    load(0, filters);
  }

  return (
    <div>
      <h1>Audit log</h1>
      <p>
        <a href="/admin">Back to admin</a> · <a href="/admin/users">Users</a> ·{" "}
        <a href="/admin/jobs">Jobs</a> · <a href="/admin/workers">Workers</a>
      </p>
      <form onSubmit={onSubmit}>
        <input
          type="text"
          value={filters.action}
          placeholder="Action (e.g. login)"
          onChange={(e) => setFilters({ ...filters, action: e.target.value })}
        />{" "}
        <select
          value={filters.targetType}
          onChange={(e) =>
            setFilters({ ...filters, targetType: e.target.value })
          }
        >
          <option value="">Any target</option>
          <option value="user">User</option>
          <option value="project">Project</option>
          <option value="job">Job</option>
        </select>{" "}
        <input
          type="text"
          value={filters.actorId}
          placeholder="Actor user ID"
          onChange={(e) => setFilters({ ...filters, actorId: e.target.value })}
        />{" "}
        <button type="submit" className="btn btn-primary">
          Filter
        </button>
      </form>
      {error ? <p className="text-danger">{error}</p> : null}
      <p>
        {total} entr{total === 1 ? "y" : "ies"}
      </p>
      <table className="table table-striped">
        <thead>
          <tr>
            <th>Time</th>
            <th>Action</th>
            <th>Actor</th>
            <th>Target</th>
            <th>IP</th>
          </tr>
        </thead>
        <tbody>
          {entries.map((entry) => (
            <tr key={entry._id}>
              <td>{formatTime(entry.timestamp)}</td>
              <td>
                <code>{entry.action}</code>
              </td>
              <td title={entry.actorType}>{shortId(entry.actorId)}</td>
              <td>
                {entry.targetType}:{" "}
                {entry.targetType === "user" && entry.targetId ? (
                  <a href={`/admin/users/${entry.targetId}`}>
                    {shortId(entry.targetId)}
                  </a>
                ) : (
                  shortId(entry.targetId)
                )}
              </td>
              <td>{entry.ipAddress || "—"}</td>
            </tr>
          ))}
          {entries.length === 0 ? (
            <tr>
              <td colSpan={5}>No audit entries match the current filters.</td>
            </tr>
          ) : null}
        </tbody>
      </table>
      <p>
        <button
          className="btn btn-default"
          disabled={offset === 0}
          onClick={() => load(Math.max(offset - PAGE_SIZE, 0), filters)}
        >
          ← Newer
        </button>{" "}
        <button
          className="btn btn-default"
          disabled={offset + PAGE_SIZE >= total}
          onClick={() => load(offset + PAGE_SIZE, filters)}
        >
          Older →
        </button>
      </p>
    </div>
  );
}

const element = document.getElementById("admin-audit-root");
if (element) {
  createRoot(element).render(<AuditDashboard />);
}
