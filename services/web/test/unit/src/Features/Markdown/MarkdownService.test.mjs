import { expect, describe, it } from "vitest";
import { toLatex } from "../../../../../app/src/Features/Markdown/MarkdownService.mjs";

describe("MarkdownService.toLatex", function () {
  it("converts headings to sectioning commands", function () {
    const tex = toLatex("# Title\n## Section\n### Sub");
    expect(tex).to.contain("\\section{Title}");
    expect(tex).to.contain("\\subsection{Section}");
    expect(tex).to.contain("\\subsubsection{Sub}");
  });

  it("escapes LaTeX special characters in prose", function () {
    const tex = toLatex("Cost: 100$ & 50% of #items");
    expect(tex).to.contain("\\$");
    expect(tex).to.contain("\\&");
    expect(tex).to.contain("\\%");
    expect(tex).to.contain("\\#");
  });

  it("converts emphasis and inline code", function () {
    const tex = toLatex("This is **bold** and *italic* and `code`");
    expect(tex).to.contain("\\textbf{bold}");
    expect(tex).to.contain("\\emph{italic}");
    expect(tex).to.contain("\\texttt{code}");
  });

  it("converts bullet and numbered lists", function () {
    const tex = toLatex("- one\n- two\n\n1. first\n2. second");
    expect(tex).to.contain("\\begin{itemize}");
    expect(tex).to.contain("\\item one");
    expect(tex).to.contain("\\end{itemize}");
    expect(tex).to.contain("\\begin{enumerate}");
    expect(tex).to.contain("\\item first");
    expect(tex).to.contain("\\end{enumerate}");
  });

  it("wraps fenced code blocks in verbatim without escaping transforms", function () {
    const tex = toLatex("```\nconst x = a & b;\n```");
    expect(tex).to.contain("\\begin{verbatim}");
    expect(tex).to.contain("const x = a \\& b;");
    expect(tex).to.contain("\\end{verbatim}");
  });

  it("converts links to href", function () {
    const tex = toLatex("[Overleaf](https://overleaf.com)");
    expect(tex).to.contain("\\href{https://overleaf.com}{Overleaf}");
  });

  it("never lets markdown through unescaped into structural commands", function () {
    const tex = toLatex("# 100% *done*");
    expect(tex).to.contain("\\section{100\\% \\emph{done}}");
  });
});
