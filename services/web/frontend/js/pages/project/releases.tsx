import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { getJSON, postJSON } from "@/infrastructure/fetch-json";
import ProjectToolNav from "@/shared/components/project-tool-nav";

type Release = {
  _id: string;
  tag: string;
  version: number | null;
  buildId: string;
  imageName: string | null;
  compiler: string | null;
  jobId: string | null;
  notes: string;
  createdBy: string | null;
  createdAt: string;
};

type CompileJob = {
  jobId: string;
  buildId: string | null;
  status: string;
  finishedAt?: string;
};

function projectIdFromPath() {
  const match = window.location.pathname.match(
    /\/project\/([a-f0-9]{24})\/releases/,
  );
  return match ? match[1] : null;
}

function ReleasesDashboard() {
  const projectId = projectIdFromPath();
  const [releases, setReleases] = useState<Release[]>([]);
  const [jobs, setJobs] = useState<CompileJob[]>([]);
  const [tag, setTag] = useState("");
  const [notes, setNotes] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [diff, setDiff] = useState<{
    tag: string;
    files: Array<{
      path: string;
      status: string;
      added: number;
      removed: number;
      hunks: Array<{
        beforeStart: number;
        beforeLines: string[];
        afterStart: number;
        afterLines: string[];
      }>;
    }>;
  } | null>(null);

  async function refresh() {
    if (!projectId) return;
    setError(null);
    try {
      const [rel, jobData] = await Promise.all([
        getJSON<{ releases: Release[] }>(`/project/${projectId}/api/releases`),
        getJSON<{ jobs: CompileJob[] }>(`/project/${projectId}/jobs?limit=10`),
      ]);
      setReleases(rel.releases);
      setJobs(
        (jobData.jobs || []).filter((j) => j.status === "success" && j.buildId),
      );
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  async function showDiff(releaseId: string) {
    setError(null);
    try {
      setDiff(
        await getJSON(`/project/${projectId}/api/releases/${releaseId}/diff`),
      );
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectId]);

  async function createRelease(e: React.FormEvent) {
    e.preventDefault();
    if (!projectId) return;
    setError(null);
    setMessage(null);
    try {
      await postJSON(`/project/${projectId}/api/releases`, {
        body: { tag, notes },
      });
      setTag("");
      setNotes("");
      setMessage("Release created.");
      refresh();
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  if (!projectId) {
    return <p>Invalid project.</p>;
  }

  const latestBuild = jobs[0];

  return (
    <div>
      <h1>Releases</h1>
      <p>
        <ProjectToolNav projectId={projectId} />
      </p>
      <p>
        Pin a compiled build as an immutable, traceable release: the source
        archive and PDF stay downloadable, and the compiler environment is
        recorded for reproducibility.
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}

      <form onSubmit={createRelease} style={{ margin: "16px 0" }}>
        <input
          type="text"
          value={tag}
          placeholder="Tag, e.g. v1.0"
          required
          onChange={(e) => setTag(e.target.value)}
        />{" "}
        <input
          type="text"
          value={notes}
          placeholder="Notes (optional)"
          size={40}
          onChange={(e) => setNotes(e.target.value)}
        />{" "}
        <button type="submit" className="btn btn-primary">
          Release {latestBuild ? `latest build ${latestBuild.buildId}` : ""}
        </button>
      </form>
      {latestBuild ? null : (
        <p className="text-warning">
          No successful compile yet — compile the project first, then tag a
          release.
        </p>
      )}

      <h2>Released versions</h2>
      <table className="table table-striped">
        <thead>
          <tr>
            <th>Tag</th>
            <th>Created</th>
            <th>Build</th>
            <th>Compiler</th>
            <th>Notes</th>
            <th>Downloads</th>
          </tr>
        </thead>
        <tbody>
          {releases.map((r) => (
            <tr key={r._id}>
              <td>
                <strong>{r.tag}</strong>
              </td>
              <td>{new Date(r.createdAt).toLocaleString()}</td>
              <td title={r.buildId}>{r.buildId.slice(0, 12)}…</td>
              <td>
                {[r.compiler, r.imageName].filter(Boolean).join(" / ") || "—"}
              </td>
              <td>{r.notes || "—"}</td>
              <td>
                <button
                  className="btn btn-xs btn-default"
                  onClick={() => showDiff(r._id)}
                >
                  Diff vs current
                </button>{" "}
                <a
                  className="btn btn-xs btn-default"
                  href={`/project/${projectId}/build/${r.buildId}/output/output.zip`}
                >
                  Source
                </a>{" "}
                <a
                  className="btn btn-xs btn-default"
                  href={`/download/project/${projectId}/build/${r.buildId}/output/output.pdf`}
                >
                  PDF
                </a>
              </td>
            </tr>
          ))}
          {releases.length === 0 ? (
            <tr>
              <td colSpan={6}>No releases yet.</td>
            </tr>
          ) : null}
        </tbody>
      </table>

      {diff ? (
        <>
          <h2>Diff: {diff.tag} vs current</h2>
          {diff.files.length === 0 ? (
            <p>No files in this release snapshot.</p>
          ) : (
            diff.files.map((f) => (
              <div key={f.path} style={{ marginBottom: 16 }}>
                <div>
                  <code>{f.path}</code> — {f.status} (+{f.added}/-
                  {f.removed})
                </div>
                {f.hunks.length > 0 ? (
                  <pre
                    style={{
                      background: "#f6f6f6",
                      padding: 8,
                      fontSize: 12,
                      maxHeight: 240,
                      overflow: "auto",
                      maxWidth: 760,
                    }}
                  >
                    {f.hunks
                      .map((h) => [
                        ...h.beforeLines.map((l) => `- ${l}`),
                        ...h.afterLines.map((l) => `+ ${l}`),
                      ])
                      .flat()
                      .join("\n")}
                  </pre>
                ) : null}
              </div>
            ))
          )}
        </>
      ) : null}
    </div>
  );
}

const element = document.getElementById("project-releases-root");
if (element) {
  createRoot(element).render(<ReleasesDashboard />);
}
