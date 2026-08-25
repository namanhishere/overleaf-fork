#!/usr/bin/env node
// Integrated acceptance walkthrough for the fork extension (PLANS.md).
// Exercises all major subsystems in one continuous pass against a running
// dev stack: /init, compile, release, review, AI summary, secrets,
// observability, backup with off-site push, worker/storage health.
//
// Usage:
//   node develop/acceptance-smoke.mjs [baseUrl] [projectId]
// Requires an authenticated session cookie in the environment:
//   OVERLEAF_SESSION_COOKIE="cookie string from a logged-in browser"
// Exit code 0 = all steps passed; 1 = any step failed.

const BASE = process.argv[2] || "http://localhost:13080";
const PROJECT_ID = process.argv[3] || "";
const COOKIE = process.env.OVERLEAF_SESSION_COOKIE || "";

let passed = 0;
let failed = 0;
const results = [];

function check(name, ok, detail) {
  results.push(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
  ok ? passed++ : failed++;
}

let CSRF = null;

async function acquireCsrfToken() {
  // The token is published in the page's meta tags; any authenticated
  // page render carries it.
  const res = await fetch(`${BASE}/project`, { headers: { Cookie: COOKIE } });
  const html = await res.text();
  const m = html.match(/name="ol-csrfToken" content="([^"]+)"/);
  CSRF = m ? m[1] : null;
}

async function api(path, { method = "GET", body } = {}) {
  const headers = {
    "Content-Type": "application/json",
    Cookie: COOKIE,
  };
  if (CSRF && method !== "GET") headers["X-Csrf-Token"] = CSRF;
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    // HTML error pages surface as null json
  }
  return { status: res.status, json, text };
}

async function main() {
  if (!PROJECT_ID) {
    console.error("usage: acceptance-smoke.mjs [baseUrl] [projectId]");
    process.exit(1);
  }
  const p = (suffix) => `/project/${PROJECT_ID}${suffix}`;

  await acquireCsrfToken();
  if (!CSRF) {
    console.error("could not acquire CSRF token - is the session valid?");
    process.exit(1);
  }

  // 1. /init context docs
  const init = await api(p("/api/ai/init"), { method: "POST", body: {} });
  check(
    "1. /init generates context docs",
    init.status === 200 && Array.isArray(init.json?.files) && init.json.files.includes("agents.md"),
    (init.json?.files || []).join(","),
  );

  // 2. Compile
  const compile = await api(p("/compile"), { method: "POST", body: {} });
  check(
    "2. compile succeeds with PDF",
    compile.json?.status === "success" &&
      (compile.json?.outputFiles || []).some((f) => f.path === "output.pdf"),
    compile.json?.status,
  );

  // 3. Release the build (version pinned)
  const tag = `v1.0-acceptance-${Date.now()}`;
  const release = await api(p("/api/releases"), {
    method: "POST",
    body: { tag, notes: "acceptance walkthrough" },
  });
  check("3. release created", release.status === 201, `tag=${tag}`);

  // 4. Release diff
  const releases = await api(p("/api/releases"));
  const rel = (releases.json?.releases || []).find((r) => r.version != null);
  if (rel) {
    const diff = await api(p(`/api/releases/${rel._id}/diff`));
    check(
      "4. release diff vs current",
      diff.status === 200 && Array.isArray(diff.json?.files),
      `${(diff.json?.files || []).length} files`,
    );
  } else {
    check("4. release diff vs current", false, "no versioned release");
  }

  // 5. Review status
  const review = await api(p("/api/review"));
  check(
    "5. review status",
    review.status === 200 && Array.isArray(review.json?.threads),
    `${(review.json?.threads || []).length} threads`,
  );

  // 6. AI summarize
  const summarize = await api(p("/api/ai/run"), {
    method: "POST",
    body: { task: "/summarize-comments" },
  });
  check(
    "6. /summarize-comments",
    summarize.status === 200 && (summarize.json?.transcript || []).length > 0,
  );

  // 7. Observability incl. AI usage
  const obs = await api("/admin/api/observability");
  check(
    "7. observability with AI usage",
    obs.status === 200 && obs.json?.aiUsage != null,
    `compiles=${obs.json?.compiles?.total} aiRequests=${obs.json?.aiUsage?.totals?.requests}`,
  );

  // 8. Backup with off-site push
  const backup = await api("/admin/api/backups", {
    method: "POST",
    body: { label: "acceptance-smoke" },
  });
  const backupList = await api("/admin/api/backups");
  const latest = (backupList.json?.backups || [])[0] || {};
  check(
    "8. backup completes",
    latest.status === "complete",
    `offsite=${latest.offsite ? (latest.offsite.pushed ? "pushed" : latest.offsite.error || latest.offsite.reason) : "n/a"}`,
  );

  // 9. Workers + storage health
  const workers = await api("/admin/api/workers");
  const storage = await api("/admin/api/storage");
  check(
    "9. worker + storage health",
    workers.status === 200 && storage.status === 200,
  );

  // 10. Audit trail captured the walkthrough
  const audit = await api("/admin/api/audit");
  const actions = (audit.json?.entries || audit.json?.auditEntries || []).map(
    (e) => e.action || e.operation,
  );
  check(
    "10. audit trail",
    actions.includes("release-created") && actions.includes("ai-init"),
    actions.slice(0, 3).join(","),
  );

  console.log(results.join("\n"));
  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error("walkthrough aborted:", err.message);
  process.exit(1);
});
