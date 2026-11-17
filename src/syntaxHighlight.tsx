import { Fragment, type ReactNode } from "react";

type TokKind = "com" | "str" | "kw" | "type" | "num" | "fn" | "meta" | "key";

const MAX_HIGHLIGHT_CHARS = 24_000;

const COMMON_KEYWORDS = new Set([
  "if",
  "else",
  "elif",
  "for",
  "while",
  "loop",
  "do",
  "break",
  "continue",
  "return",
  "yield",
  "switch",
  "case",
  "default",
  "match",
  "try",
  "catch",
  "finally",
  "throw",
  "raise",
  "import",
  "from",
  "export",
  "as",
  "default",
  "const",
  "let",
  "var",
  "function",
  "async",
  "await",
  "class",
  "interface",
  "type",
  "enum",
  "struct",
  "impl",
  "trait",
  "fn",
  "pub",
  "mod",
  "use",
  "crate",
  "super",
  "self",
  "Self",
  "where",
  "mut",
  "ref",
  "move",
  "in",
  "of",
  "def",
  "lambda",
  "with",
  "pass",
  "and",
  "or",
  "not",
  "is",
  "local",
  "then",
  "elseif",
  "end",
  "until",
  "repeat",
  "new",
  "extends",
  "implements",
  "typeof",
  "keyof",
  "readonly",
  "private",
  "public",
  "protected",
  "static",
  "SELECT",
  "FROM",
  "WHERE",
  "INSERT",
  "INTO",
  "VALUES",
  "UPDATE",
  "SET",
  "DELETE",
  "JOIN",
  "LEFT",
  "RIGHT",
  "INNER",
  "ON",
  "ORDER",
  "BY",
  "GROUP",
  "LIMIT",
  "CREATE",
  "TABLE",
  "select",
  "from",
  "where",
  "insert",
  "into",
  "update",
  "delete",
  "join",
  "order",
  "group",
  "limit",
]);

const LITERAL_WORDS = new Set([
  "true",
  "false",
  "null",
  "nil",
  "none",
  "None",
  "True",
  "False",
  "undefined",
  "NaN",
  "Infinity",
  "Some",
  "Ok",
  "Err",
]);

const BUILTIN_TYPES = new Set([
  "string",
  "number",
  "boolean",
  "void",
  "any",
  "unknown",
  "never",
  "object",
  "str",
  "bool",
  "usize",
  "isize",
  "u8",
  "u16",
  "u32",
  "u64",
  "i8",
  "i16",
  "i32",
  "i64",
  "f32",
  "f64",
  "char",
  "Vec",
  "Option",
  "Result",
  "String",
  "Path",
  "PathBuf",
  "HashMap",
  "HashSet",
  "Promise",
  "Record",
  "Array",
  "ReactNode",
]);

function supportsHashComment(lang: string): boolean {
  return /^(py|python|bash|sh|zsh|shell|toml|yaml|yml|powershell|ps1|ruby|rb)$/.test(lang);
}

function supportsDashComment(lang: string): boolean {
  return /^(lua|luau|sql)$/.test(lang);
}

function normalizeLang(raw: string): string {
  return raw.trim().toLowerCase();
}

function readString(code: string, start: number, quote: string): number {
  let i = start + 1;
  while (i < code.length) {
    const ch = code[i];
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (ch === quote) {
      return i + 1;
    }
    if (ch === "\n" && quote !== "`") {
      return i;
    }
    i++;
  }
  return code.length;
}

/**
 * Tokenize source code into lightweight syntax-highlighted React spans.
 * Guarantees concatenated text equals `code` character-for-character so copy operations stay exact.
 */
export function highlightCode(code: string, rawLang = ""): ReactNode {
  if (!code) return code;
  const lang = normalizeLang(rawLang);
  if (!lang || lang === "text" || lang === "txt" || lang === "plain") {
    return code;
  }

  const slice = code.length > MAX_HIGHLIGHT_CHARS ? code.slice(0, MAX_HIGHLIGHT_CHARS) : code;
  const remainder = code.length > MAX_HIGHLIGHT_CHARS ? code.slice(MAX_HIGHLIGHT_CHARS) : "";

  const out: ReactNode[] = [];
  let plainStart = 0;
  let keyCounter = 0;

  const flushPlain = (end: number) => {
    if (end > plainStart) {
      out.push(slice.slice(plainStart, end));
      plainStart = end;
    }
  };

  const pushTok = (start: number, end: number, kind: TokKind) => {
    flushPlain(start);
    out.push(
      <span key={keyCounter++} className={`tok-${kind}`}>
        {slice.slice(start, end)}
      </span>
    );
    plainStart = end;
  };

  const hashCom = supportsHashComment(lang);
  const dashCom = supportsDashComment(lang);
  const isJson = lang === "json" || lang === "jsonc";

  let i = 0;
  while (i < slice.length) {
    const ch = slice[i];
    const next = slice[i + 1];

    // Block comment /* ... */
    if (ch === "/" && next === "*") {
      const close = slice.indexOf("*/", i + 2);
      const end = close === -1 ? slice.length : close + 2;
      pushTok(i, end, "com");
      i = end;
      continue;
    }

    // Luau/Lua long comment --[[ ... ]]
    if (dashCom && ch === "-" && next === "-" && slice[i + 2] === "[" && slice[i + 3] === "[") {
      const close = slice.indexOf("]]", i + 4);
      const end = close === -1 ? slice.length : close + 2;
      pushTok(i, end, "com");
      i = end;
      continue;
    }

    // Line comments // ... or # ... or -- ...
    if (
      (ch === "/" && next === "/") ||
      (hashCom && ch === "#") ||
      (dashCom && ch === "-" && next === "-")
    ) {
      const nl = slice.indexOf("\n", i);
      const end = nl === -1 ? slice.length : nl;
      pushTok(i, end, "com");
      i = end;
      continue;
    }

    // Decorators / Rust attributes #[...] or @decorator
    if ((ch === "#" && next === "[") || (ch === "@" && /[A-Za-z_]/.test(next || ""))) {
      let end = i + 1;
      if (ch === "#" && next === "[") {
        const close = slice.indexOf("]", i + 2);
        end = close === -1 ? slice.length : close + 1;
      } else {
        while (end < slice.length && /[A-Za-z0-9_.]/.test(slice[end])) end++;
      }
      pushTok(i, end, "meta");
      i = end;
      continue;
    }

    // Triple-quoted Python strings
    if ((ch === '"' || ch === "'") && next === ch && slice[i + 2] === ch) {
      const delim = ch + ch + ch;
      const close = slice.indexOf(delim, i + 3);
      const end = close === -1 ? slice.length : close + 3;
      pushTok(i, end, "str");
      i = end;
      continue;
    }

    // Strings ("...", '...', `...`)
    if (ch === '"' || ch === "'" || ch === "`") {
      const end = readString(slice, i, ch);
      // Check if JSON / object property key ("key":)
      let look = end;
      while (look < slice.length && (slice[look] === " " || slice[look] === "\t")) look++;
      const isKey = ch === '"' && slice[look] === ":";
      pushTok(i, end, isKey && isJson ? "key" : isKey ? "key" : "str");
      i = end;
      continue;
    }

    // Numbers (hex, float, int)
    if (/[0-9]/.test(ch) && (i === 0 || !/[A-Za-z0-9_]/.test(slice[i - 1]))) {
      let end = i + 1;
      if (ch === "0" && (next === "x" || next === "X" || next === "b" || next === "o")) {
        end = i + 2;
        while (end < slice.length && /[0-9a-fA-F_]/.test(slice[end])) end++;
      } else {
        while (end < slice.length && /[0-9_.]/.test(slice[end])) end++;
        if (slice[end] === "e" || slice[end] === "E") {
          end++;
          if (slice[end] === "+" || slice[end] === "-") end++;
          while (end < slice.length && /[0-9_]/.test(slice[end])) end++;
        }
      }
      pushTok(i, end, "num");
      i = end;
      continue;
    }

    // Identifiers, keywords, types, functions, macros
    if (/[A-Za-z_$]/.test(ch)) {
      let end = i + 1;
      while (end < slice.length && /[A-Za-z0-9_$]/.test(slice[end])) end++;
      const word = slice.slice(i, end);

      let look = end;
      while (look < slice.length && (slice[look] === " " || slice[look] === "\t")) look++;

      if (slice[end] === "!" && (lang === "rust" || lang === "rs")) {
        pushTok(i, end + 1, "meta");
        i = end + 1;
        continue;
      }

      if (LITERAL_WORDS.has(word)) {
        pushTok(i, end, "num");
      } else if (COMMON_KEYWORDS.has(word)) {
        pushTok(i, end, "kw");
      } else if (BUILTIN_TYPES.has(word) || (/^[A-Z][A-Za-z0-9_]+$/.test(word) && slice[look] !== "(")) {
        pushTok(i, end, "type");
      } else if (slice[look] === "(") {
        pushTok(i, end, "fn");
      } else if (slice[look] === ":" && (slice[look + 1] !== ":") && (i === 0 || /[\s{,]/.test(slice[i - 1]))) {
        pushTok(i, end, "key");
      }
      i = end;
      continue;
    }

    i++;
  }

  flushPlain(slice.length);
  if (remainder) out.push(remainder);
  return <Fragment>{out}</Fragment>;
}
