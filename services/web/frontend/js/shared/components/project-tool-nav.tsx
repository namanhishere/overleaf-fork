const TOOLS = [
  { href: "/review", label: "Review" },
  { href: "/releases", label: "Releases" },
  { href: "/secrets", label: "Secrets" },
  { href: "/artifacts", label: "Artifacts" },
  { href: "/ai", label: "AI assistant" },
];

// Cross-links between the standalone project tool pages (review,
// releases, secrets, artifacts, AI assistant). These pages render
// outside the editor's React providers, so the active item is derived
// from window.location.
export default function ProjectToolNav({ projectId }: { projectId: string }) {
  const pathname = window.location.pathname;
  return (
    <p style={{ fontSize: 13 }}>
      <a href={`/project/${projectId}`}>Back to project</a>
      {TOOLS.map((t) => {
        const active = pathname.endsWith(t.href);
        return (
          <span key={t.href}>
            {" · "}
            {active ? (
              <strong>{t.label}</strong>
            ) : (
              <a href={`/project/${projectId}${t.href}`}>{t.label}</a>
            )}
          </span>
        );
      })}
    </p>
  );
}
