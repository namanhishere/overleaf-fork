import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { getJSON, postJSON } from "@/infrastructure/fetch-json";

type Props = {
  projectId: string;
  docId: string;
};

function MarkdownPreview({ projectId, docId }: Props) {
  const [html, setHtml] = useState<string>("");
  const [docPath, setDocPath] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    async function load() {
      setError(null);
      try {
        const data = await getJSON<{ lines: string[]; docPath: string }>(
          `/project/${projectId}/api/markdown/${docId}`,
        );
        setDocPath(data.docPath);
        // marked renders markdown; DOMPurify strips any embedded HTML threats
        setHtml(DOMPurify.sanitize(marked.parse(data.lines.join("\n"))));
      } catch (err) {
        setError(String((err as Error).message));
      }
    }
    load();
  }, [projectId, docId]);

  async function convert() {
    setError(null);
    setMessage(null);
    try {
      const res = await postJSON(
        `/project/${projectId}/api/markdown/${docId}/convert-to-latex`,
        { body: {} },
      );
      setMessage(`Converted to ${res.texPath}`);
    } catch (err) {
      setError(String((err as Error).message));
    }
  }

  return (
    <div className="container">
      <h1>Markdown preview</h1>
      <p>
        <a href={`/project/${projectId}`}>Back to project</a>
        {docPath ? (
          <>
            {" · "}
            <code>{docPath}</code>
          </>
        ) : null}
        {" · "}
        <button className="btn btn-primary btn-sm" onClick={convert}>
          Convert to LaTeX
        </button>
      </p>
      {error ? <p className="text-danger">{error}</p> : null}
      {message ? <p className="text-success">{message}</p> : null}
      <div
        className="markdown-preview-content"
        // content is sanitized with DOMPurify before it reaches this node
        dangerouslySetInnerHTML={{ __html: html }}
        style={{ maxWidth: 760 }}
      />
    </div>
  );
}

const element = document.getElementById("markdown-preview-root");
if (element) {
  const projectId = element.getAttribute("data-project-id") || "";
  const docId = element.getAttribute("data-doc-id") || "";
  createRoot(element).render(
    <MarkdownPreview projectId={projectId} docId={docId} />,
  );
}
