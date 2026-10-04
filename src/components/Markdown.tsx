import { isValidElement, memo, useCallback, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@tauri-apps/api/core";
import { copyText } from "./clip";

function isWebUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <span>{children}</span>;
  if (!isWebUrl(href)) {
    // Relative paths, anchors, and non-web schemes stay inert so a model
    // cannot trigger navigation outside the browser.
    return <code className="md-inline md-link-path">{children}</code>;
  }
  return (
    <a
      href={href}
      title={href}
      target="_blank"
      rel="noopener noreferrer"
      onClick={(e: MouseEvent) => {
        if (!isTauri()) return;
        e.preventDefault();
        openUrl(href).catch(() => {});
      }}
    >
      {children}
    </a>
  );
}

function DiffLines({ text }: { text: string }) {
  const lines = text.split("\n");
  return (
    <>
      {lines.map((line, i) => {
        const isLast = i === lines.length - 1 && line === "";
        if (isLast) return null;
        const kind =
          line.startsWith("+") && !line.startsWith("+++")
            ? "add"
            : line.startsWith("-") && !line.startsWith("---")
              ? "del"
              : line.startsWith("@@")
                ? "hunk"
                : line.startsWith("diff --git") || line.startsWith("index ") || line.startsWith("--- ") || line.startsWith("+++ ")
                  ? "hdr"
                  : "ctx";
        return (
          <span key={i} className={`git-diff-${kind}`}>
            {line}
            {"\n"}
          </span>
        );
      })}
    </>
  );
}

function MdCode({ className, children }: { className?: string; children?: ReactNode }) {
  const isDiff = className?.includes("language-diff") || className?.includes("language-patch");
  if (isDiff && typeof children === "string") {
    return <code className="md-inline md-diff-block"><DiffLines text={children} /></code>;
  }
  return <code className="md-inline">{children}</code>;
}

function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  // A fenced block arrives as a single <code> element; recurse into it.
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

function parseBlockInfo(children: ReactNode): { lang: string; file?: string; lines: number } {
  const kids = Array.isArray(children) ? children : [children];
  const first = kids[0];
  let lang = "code";
  let file: string | undefined;
  if (isValidElement<{ className?: string }>(first)) {
    const rawClass = first.props.className ?? "";
    const m = /language-([^\s]+)/.exec(rawClass);
    if (m) {
      const spec = m[1];
      if (spec.includes(":")) {
        const [l, f] = spec.split(":", 2);
        lang = l;
        file = f;
      } else {
        lang = spec;
      }
    }
  }
  const text = textOf(children);
  const lines = text ? text.split("\n").filter((l, i, arr) => i < arr.length - 1 || l.length > 0).length : 0;
  return { lang, file, lines };
}

function MdPre({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const { lang, file, lines } = parseBlockInfo(children);
  const copy = useCallback(() => {
    // Fenced blocks carry one trailing newline; drop it from the copy.
    const text = textOf(children).replace(/\n$/, "");
    void copyText(text).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [children]);
  return (
    <div className="md-code">
      <div className="md-code-head">
        <div className="md-code-tag">
          {file ? <span className="md-code-file">{file}</span> : null}
          <span className="md-code-lang">{lang}</span>
          {lines > 1 ? <span className="md-code-lines">{lines} lines</span> : null}
        </div>
        <button type="button" className="md-copy" aria-label="Copy code" onClick={copy}>
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function MdTable({ children }: { children?: ReactNode }) {
  return (
    <div className="md-table-wrap">
      <table>{children}</table>
    </div>
  );
}

const components: Components = { a: MdLink, pre: MdPre, code: MdCode, table: MdTable };

function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
}

export default memo(Markdown);
