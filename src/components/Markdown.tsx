import { isValidElement, memo, useCallback, useState, type MouseEvent, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { isTauri } from "@tauri-apps/api/core";
import { copyText } from "./clip";
import { DiffLines } from "./diffViewer";
import { highlightCode } from "../syntaxHighlight";

const FILE_EXT_RE =
  /\.(?:tsx?|jsx?|mjs|cjs|rs|py|luau|lua|css|scss|html?|jsonc?|toml|ya?ml|md|mdx|ps1|sh|zsh|cmd|bat|sql|txt|env|gitignore|lock)(?::\d+(?:-\d+)?)?$/i;

const SHELL_LANGS = new Set(["bash", "sh", "zsh", "shell", "powershell", "ps1", "cmd", "bat", "pwsh"]);

function isWebUrl(href: string): boolean {
  return /^https?:\/\//i.test(href);
}

function dispatchInspectFile(filePath: string) {
  window.dispatchEvent(new CustomEvent("velum:inspect-file", { detail: { path: filePath } }));
}

function extractWorkspaceFilePath(raw: string): { display: string; filePath: string } | null {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.length > 260 || /[\s<>"'`]/.test(trimmed)) return null;

  if (/^file:\/\/\//i.test(trimmed)) {
    const noHash = trimmed.split("#")[0];
    const fsPath = decodeURIComponent(noHash.replace(/^file:\/\/\//i, ""));
    if (!fsPath) return null;
    return { display: fsPath, filePath: fsPath };
  }

  if (/^[a-z]+:\/\//i.test(trimmed)) return null;

  const cleanNoHash = trimmed.split("#")[0];
  if (FILE_EXT_RE.test(cleanNoHash) || /^[a-zA-Z0-9_.-]+(?:\/[a-zA-Z0-9_.-]+)+\.[a-zA-Z0-9]{1,8}(?::\d+)?$/.test(cleanNoHash)) {
    const fileOnly = cleanNoHash.replace(/:\d+(?:-\d+)?$/, "");
    return { display: trimmed, filePath: fileOnly };
  }
  return null;
}

function MdLink({ href, children }: { href?: string; children?: ReactNode }) {
  if (!href) return <span>{children}</span>;
  if (!isWebUrl(href)) {
    const fileRef = extractWorkspaceFilePath(href);
    if (fileRef) {
      return (
        <button
          type="button"
          className="md-file-chip"
          title={`Inspect ${fileRef.filePath} in Split Studio`}
          onClick={() => dispatchInspectFile(fileRef.filePath)}
        >
          <span className="md-file-chip-icon" aria-hidden="true">↗</span>
          <span>{children}</span>
        </button>
      );
    }
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

function MdCode({ className, children }: { className?: string; children?: ReactNode }) {
  const isDiff = className?.includes("language-diff") || className?.includes("language-patch");
  if (isDiff && typeof children === "string") {
    return (
      <code className="md-inline md-diff-block">
        <DiffLines text={children} />
      </code>
    );
  }
  // Inline code paths (never fenced blocks, which contain newlines or language classes) become clickable file chips.
  if (!className && typeof children === "string" && !children.includes("\n")) {
    const fileRef = extractWorkspaceFilePath(children);
    if (fileRef) {
      return (
        <button
          type="button"
          className="md-file-chip"
          title={`Inspect ${fileRef.filePath} in Split Studio`}
          onClick={() => dispatchInspectFile(fileRef.filePath)}
        >
          <code>{children}</code>
        </button>
      );
    }
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
  const [wrap, setWrap] = useState(false);
  const { lang, file, lines } = parseBlockInfo(children);
  const rawCode = textOf(children).replace(/\n$/, "");
  const isDiff = lang.toLowerCase() === "diff" || lang.toLowerCase() === "patch";
  const isShell = SHELL_LANGS.has(lang.toLowerCase()) && rawCode.trim().length > 0 && rawCode.length <= 2000;

  const copy = useCallback(() => {
    void copyText(rawCode).then((ok) => {
      if (!ok) return;
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1200);
    });
  }, [rawCode]);

  const insert = useCallback(() => {
    window.dispatchEvent(new CustomEvent("velum:insert-draft", { detail: rawCode }));
  }, [rawCode]);

  const insertRun = useCallback(() => {
    window.dispatchEvent(
      new CustomEvent("velum:insert-draft", {
        detail: `Run this command and report the output:\n\`\`\`${lang}\n${rawCode}\n\`\`\``,
      })
    );
  }, [lang, rawCode]);

  return (
    <div className="md-code">
      <div className="md-code-head">
        <div className="md-code-tag">
          {file ? (
            <button
              type="button"
              className="md-code-file md-code-file-btn"
              title={`Inspect ${file} in Split Studio`}
              onClick={() => dispatchInspectFile(file)}
            >
              {file}
            </button>
          ) : null}
          <span className="md-code-lang">{lang}</span>
          {lines > 1 ? <span className="md-code-lines">{lines} lines</span> : null}
        </div>
        <div className="md-code-actions">
          {isShell && (
            <button
              type="button"
              className="md-insert-btn md-run-btn"
              aria-label="Run snippet in composer"
              title="Queue this shell command in the composer"
              onClick={insertRun}
            >
              Run
            </button>
          )}
          {lines > 1 && (
            <button
              type="button"
              className={`md-wrap-btn${wrap ? " active" : ""}`}
              aria-pressed={wrap}
              title={wrap ? "Disable line wrapping" : "Wrap long lines"}
              onClick={() => setWrap((w) => !w)}
            >
              Wrap
            </button>
          )}
          <button
            type="button"
            className="md-insert-btn"
            aria-label="Insert into message draft"
            title="Insert snippet or command into message composer"
            onClick={insert}
          >
            Insert
          </button>
          <button type="button" className="md-copy" aria-label="Copy code" onClick={copy}>
            {copied ? "Copied" : "Copy"}
          </button>
        </div>
      </div>
      {isDiff ? (
        <pre className={wrap ? "wrapped" : undefined}>
          <code className="md-inline md-diff-block">
            <DiffLines text={rawCode} />
          </code>
        </pre>
      ) : (
        <pre className={wrap ? "wrapped" : undefined}>
          <code>{highlightCode(rawCode, lang)}</code>
        </pre>
      )}
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

function MdBlockquote({ children }: { children?: ReactNode }) {
  const plain = textOf(children).trimStart();
  const match = plain.match(/^\[!(NOTE|TIP|IMPORTANT|WARNING|CAUTION)\]\s*/i);
  if (match) {
    const kind = match[1].toLowerCase();
    return (
      <blockquote className={`md-callout callout-${kind}`}>
        <div className="md-callout-badge">{match[1].toUpperCase()}</div>
        {children}
      </blockquote>
    );
  }
  return <blockquote>{children}</blockquote>;
}

const components: Components = {
  a: MdLink,
  pre: MdPre,
  code: MdCode,
  table: MdTable,
  blockquote: MdBlockquote,
};

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
