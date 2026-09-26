import { renderMath, esc as escape } from "./math";
const FILE_REF_RE = /(?<![\w./\\-])([A-Za-z0-9_@][\w./\\-]*\.[A-Za-z0-9]{1,8}):(\d+)(?:-(\d+))?(?![\d-])/g;
const FILE_REF_FULL = new RegExp(FILE_REF_RE.source);
function renderInline(s: string): string {  const mathBlocks: string[] = [];
  s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, latex: string) => {
    mathBlocks.push(renderMath(latex, true));
    return `\u0001M${mathBlocks.length - 1}\u0001`;
  });
  s = s.replace(/\$([^$\n]+?)\$/g, (_, latex: string) => {
    if (!latex.trim()) return `$${latex}$`;
    if (!/[\\^_{}$[\]]/.test(latex)) return `$${latex}$`;
    mathBlocks.push(renderMath(latex, false));
    return `\u0001M${mathBlocks.length - 1}\u0001`;
  });
  s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, latex: string) => {
    mathBlocks.push(renderMath(latex, false));
    return `\u0001M${mathBlocks.length - 1}\u0001`;
  });
  const codes: string[] = [];
  s = s.replace(/`([^`\n]+)`/g, (_, c) => {
    codes.push(c);
    return `\u0001C${codes.length - 1}\u0001`;
  });
  const refs: { path: string; line: string; endLine?: string }[] = [];
  s = s.replace(FILE_REF_RE, (m, path: string, line: string, endLine: string | undefined, offset: number, full: string) => {
    if (/https?:\/\/[^\s]*$/.test(full.slice(0, offset))) return m;
    refs.push({ path, line, ...(endLine ? { endLine } : {}) });
    return `\u0001R${refs.length - 1}\u0001`;
  });
  const images: { alt: string; src: string }[] = [];
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)(?:\s+"([^"]*)")?\)/g, (_, alt, src) => {
    if (!/^(https?:\/\/|\/)/i.test(src)) return alt; 
    images.push({ alt, src });
    return `\u0001I${images.length - 1}\u0001`;
  });
  const links: { text: string; href: string }[] = [];
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, text, href) => {
    if (!/^(https?:\/\/|\/|#)/i.test(href)) return text; 
    links.push({ text, href });
    return `\u0001L${links.length - 1}\u0001`;
  });
  s = escape(s);
  s = s.replace(/~~([^~\n]+)~~/g, (_, t) => `<del>${t}</del>`);
  s = s.replace(/\*\*\*([\s\S]+?)\*\*\*/g, (_, t) => `<strong><em>${t}</em></strong>`);
  s = s.replace(/\*\*([\s\S]+?)\*\*/g, (_, t) => `<strong>${t}</strong>`);
  s = s.replace(/__([^_\n]+)__/g, (_, t) => `<strong>${t}</strong>`);
  s = s.replace(/(^|[^\*])\*([\s\S]+?)\*(?!\*)/g, (_, p, t) => `${p}<em>${t}</em>`);
  s = s.replace(/(^|[^_])_([^_\n]+)_(?!_)/g, (_, p, t) => `${p}<em>${t}</em>`);
  s = s.replace(/\u0001I(\d+)\u0001/g, (_, idx) => {
    const { alt, src } = images[Number(idx)];
    return `<img src="${escape(src)}" alt="${escape(alt)}" loading="lazy" />`;
  });
  s = s.replace(/\u0001L(\d+)\u0001/g, (_, idx) => {
    const { text, href } = links[Number(idx)];
    return `<a href="${escape(href)}" rel="noopener noreferrer" target="_blank">${escape(text)}</a>`;
  });
  s = s.replace(/\u0001R(\d+)\u0001/g, (_, idx) => {
    const { path, line, endLine } = refs[Number(idx)];
    return `<a class="arc-ref" role="link" tabindex="0" data-path="${escape(path)}" data-line="${escape(line)}"${endLine ? ` data-end-line="${escape(endLine)}"` : ""}>${escape(path)}:${escape(line)}${endLine ? `-${escape(endLine)}` : ""}</a>`;
  });
  s = s.replace(/\u0001C(\d+)\u0001/g, (_, idx) => {
    const raw = codes[Number(idx)];
    const m = FILE_REF_FULL.exec(raw);
    if (m && m[0] === raw) {
      const path = m[1];
      const line = m[2];
      const endLine = m[3];
      return `<code class="arc-ref-code" role="link" tabindex="0" data-path="${escape(path)}" data-line="${escape(line)}"${endLine ? ` data-end-line="${escape(endLine)}"` : ""}><span class="arc-ref-path">${escape(path)}</span><span class="arc-ref-lines">:${escape(line)}${endLine ? `-${escape(endLine)}` : ""}</span></code>`;
    }
    return `<code>${escape(raw)}</code>`;
  });
  s = s.replace(/\u0001M(\d+)\u0001/g, (_, idx) => mathBlocks[Number(idx)]);
  return s;
}
type Lang = "python" | "javascript" | "typescript" | "json" | "bash" | "css" | "html" | "go" | "rust" | "java" | "cpp" | "ruby" | "php" | "sql" | "yaml" | "powershell" | "diff" | string;
const KEYWORDS: Record<string, RegExp> = {
  python: /\b(def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|pass|break|continue|lambda|yield|global|nonlocal|is|None|True|False|self|async|await)\b/g,
  javascript: /\b(var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|throw|try|catch|finally|typeof|instanceof|in|of|async|await|yield|import|export|from|as|default|null|undefined|true|false)\b/g,
  typescript: /\b(var|let|const|function|return|if|else|for|while|do|switch|case|break|continue|new|class|extends|super|this|throw|try|catch|finally|typeof|instanceof|in|of|async|await|yield|import|export|from|as|default|interface|type|enum|public|private|protected|readonly|static|abstract|implements|null|undefined|true|false|void|never|unknown|any)\b/g,
  bash: /\b(if|then|else|elif|fi|for|while|do|done|case|esac|in|function|return|export|local|read|echo|set|unset)\b/g,
  css: /\b(important|inherit|initial|unset|none|block|inline|flex|grid|absolute|relative|fixed|static|sticky)\b/g,
  json: /\b(true|false|null)\b/g,
  html: /\b(html|head|body|div|span|p|a|img|table|tr|td|th|tbody|thead|class|id|src|href|alt|title|style|script|meta|link|input|button|form|label|select|option|textarea)\b/g,
  go: /\b(package|import|func|var|const|type|struct|interface|map|chan|go|defer|return|if|else|for|range|switch|case|default|break|continue|fallthrough|goto|select|select|len|cap|make|new|nil|true|false)\b/g,
  rust: /\b(fn|let|mut|const|static|struct|enum|trait|impl|mod|use|pub|crate|super|self|Self|match|if|else|for|while|loop|return|break|continue|move|ref|as|where|dyn|async|await|unsafe|type|in|let)\b/g,
  java: /\b(public|private|protected|static|final|abstract|class|interface|extends|implements|new|return|if|else|for|while|do|switch|case|break|continue|throw|throws|try|catch|finally|this|super|import|package|void|boolean|int|long|float|double|char|byte|short|synchronized|volatile|native|transient|strictfp|enum|default)\b/g,
  cpp: /\b(if|else|for|while|do|switch|case|default|break|continue|return|goto|struct|union|enum|typedef|const|static|extern|volatile|register|signed|unsigned|short|int|long|float|double|char|void|sizeof|new|delete|class|public|private|protected|virtual|override|template|typename|namespace|using|try|catch|throw|true|false|nullptr)\b/g,
  ruby: /\b(def|end|class|module|if|elsif|else|unless|case|when|while|until|for|do|yield|return|begin|rescue|ensure|raise|break|next|redo|retry|and|or|not|require|include|extend|attr_accessor|self|nil|true|false)\b/g,
  php: /\b(function|class|interface|trait|extends|implements|public|private|protected|static|return|if|else|elseif|for|foreach|while|do|switch|case|break|continue|new|throw|try|catch|finally|namespace|use|require|require_once|include|include_once|echo|isset|empty|global|const|true|false|null)\b/g,
  sql: /\b(select|from|where|insert|into|values|update|set|delete|create|table|alter|drop|index|view|join|inner|left|right|full|outer|on|group|by|order|having|limit|offset|union|all|distinct|as|and|or|not|null|default|primary|key|foreign|references|constraint|check|unique|is)\b/g,
  yaml: /\b(true|false|null|yes|no|on|off)\b/g,
  powershell: /\b(function|param|return|if|else|elseif|foreach|for|while|do|switch|case|default|break|continue|try|catch|finally|throw|new|begin|process|end|filter|until|in|not|and|or|$true|$false|null)\b/g,
};
const TYPE_KEYWORDS: Record<string, RegExp> = {
  typescript: /\b(string|number|boolean|bigint|symbol|object|Function|Array|Map|Set|Promise|Date|RegExp|Error)\b/g,
  go: /\b(string|int|int8|int16|int32|int64|uint|uint8|uint16|uint32|uint64|uintptr|float32|float64|bool|byte|rune|error|any)\b/g,
  rust: /\b(i8|i16|i32|i64|i128|u8|u16|u32|u64|u128|isize|usize|f32|f64|bool|char|str|String|Vec|Option|Result|Box)\b/g,
  java: /\b(String|Integer|Long|Boolean|Float|Double|Character|Byte|Short|Object|List|Map|Set|ArrayList|HashMap|Exception|Throwable)\b/g,
  cpp: /\b(string|vector|map|set|pair|shared_ptr|unique_ptr|size_t|bool|void|int|long|float|double|char)\b/g,
  php: /\b(string|int|float|bool|array|object|mixed|void|callable|iterable|null)\b/g,
};
const COMMENT: Record<string, { line?: RegExp; block?: RegExp }> = {
  python: { line: /(^|\s)#.*$/gm, block: undefined },
  javascript: { line: /\/\/.*$/gm, block: /\/\*[\s\S]*?\*\//g },
  typescript: { line: /\/\/.*$/gm, block: /\/\*[\s\S]*?\*\//g },
  bash: { line: /(^|\s)#.*$/gm },
  css: { block: /\/\*[\s\S]*?\*\//g },
  html: { block: /<!--[\s\S]*?-->/g },
  json: {},
  go: { line: /\/\/.*$/gm, block: /\/\*[\s\S]*?\*\//g },
  rust: { line: /\/\/.*$/gm, block: /\/\*[\s\S]*?\*\//g },
  java: { line: /\/\/.*$/gm, block: /\/\*[\s\S]*?\*\//g },
  cpp: { line: /\/\/.*$/gm, block: /\/\*[\s\S]*?\*\//g },
  ruby: { line: /(^|\s)#.*$/gm },
  php: { line: /(\/\/|#).*$/gm, block: /\/\*[\s\S]*?\*\//g },
  sql: { line: /--.*$/gm, block: /\/\*[\s\S]*?\*\//g },
  yaml: { line: /(^|\s)#.*$/gm },
  powershell: { line: /(^|\s)#.*$/gm, block: /<#[\s\S]*?#>/g },
};
const STRING_RE: Record<string, RegExp> = {
  python: /("""[\s\S]*?"""|'''[\s\S]*?'''|"(?:\\.|[^"\\\n])*"|'(?:\\.|[^'\\\n])*')/g,
  javascript: /(`(?:\\.|\$\{[^{}]*\}|\$(?!\{)|[^`\\$])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  typescript: /(`(?:\\.|\$\{[^{}]*\}|\$(?!\{)|[^`\\$])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  bash: /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  json: /("(?:\\.|[^"\\])*")/g,
  css: /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  html: /("[^"]*"|'[^']*')/g,
  go: /(`[\s\S]*?`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  rust: /(r#"[^"]*"#|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  java: /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  cpp: /(R"([^()\\]*)\([\s\S]*?\)\2"|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  ruby: /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  php: /(`(?:\\.|[^`\\])*`|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  sql: /('(?:\\.|[^'\\])*')/g,
  yaml: /("(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
  powershell: /("(?:\\.|`"|[^"\\])*"|'(?:\\.|[^'\\])*')/g,
};
const NUM_RE = /\b\d+(?:\.\d+)?\b/g;
const VAR_RE: Record<string, RegExp> = {
  powershell: /\$[A-Za-z_][A-Za-z0-9_]*/g,
  php: /\$[A-Za-z_][A-Za-z0-9_]*/g,
  bash: /\$[A-Za-z_][A-Za-z0-9_]*(?:\[[^\]]*\])?|\$\{[^}]*\}/g,
  ruby: /@[A-Za-z_][A-Za-z0-9_]*|@@[A-Za-z_][A-Za-z0-9_]*|\$[A-Za-z_][A-Za-z0-9_]*/g,
};
function highlightCode(src: string, lang: Lang): string {
  if (!lang) return escape(src);
  if (lang === "diff") return highlightDiff(src);
  if (!KEYWORDS[lang]) return escape(src);
  type Patch = { start: number; end: number; html: string };
  const patches: Patch[] = [];
  const collect = (re: RegExp, wrap: (raw: string) => string) => {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(src)) !== null) {
      patches.push({ start: m.index, end: m.index + m[0].length, html: wrap(m[0]) });
      if (m[0].length === 0) re.lastIndex++;
    }
  };
  if (STRING_RE[lang]) collect(STRING_RE[lang], (m) => `<span class="arc-syn-str">${escape(m)}</span>`);
  const c = COMMENT[lang];
  if (c?.line) collect(c.line, (m) => `<span class="arc-syn-c">${escape(m)}</span>`);
  if (c?.block) collect(c.block, (m) => `<span class="arc-syn-c">${escape(m)}</span>`);
  collect(NUM_RE, (m) => `<span class="arc-syn-num">${m}</span>`);
  collect(KEYWORDS[lang], (m) => `<span class="arc-syn-kw">${m}</span>`);
  if (TYPE_KEYWORDS[lang]) collect(TYPE_KEYWORDS[lang], (m) => `<span class="arc-syn-type">${m}</span>`);
  if (VAR_RE[lang]) collect(VAR_RE[lang], (m) => `<span class="arc-syn-var">${escape(m)}</span>`);
  patches.sort((a, b) => a.start - b.start || (b.end - b.start) - (a.end - a.start));
  let out = "";
  let cursor = 0;
  for (const p of patches) {
    if (p.start < cursor) continue;
    out += escape(src.slice(cursor, p.start));
    out += p.html;
    cursor = p.end;
  }
  out += escape(src.slice(cursor));
  return out;
}
function highlightDiff(src: string): string {
  const rows = src.split("\n").map((l) => {
    if (/^(diff --git|index |new file|deleted file|rename from|rename to|similarity index|old mode|new mode)/.test(l)) return `<span class="arc-syn-diff-meta">${escape(l)}</span>`;
    if (/^@@/.test(l)) return `<span class="arc-syn-diff-head">${escape(l)}</span>`;
    if (/^\+\+\+/.test(l) || /^---$/.test(l) || /^--- /.test(l)) return `<span class="arc-syn-diff-meta">${escape(l)}</span>`;
    if (/^\+/.test(l)) return `<span class="arc-syn-diff-add">${escape(l)}</span>`;
    if (/^-/.test(l)) return `<span class="arc-syn-diff-del">${escape(l)}</span>`;
    return escape(l);
  });
  return rows.join("\n");
}
function renderBlock(s: string): string {
  const lines = s.split("\n");
  const html: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === "") { i++; continue; }
    if (/^ {0,3}>/.test(line)) {
      const raw: string[] = [];
      while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
        raw.push(lines[i].replace(/^ {0,3}> ?/, ""));
        i++;
      }
      html.push(renderBlockquote(raw, 0));
      continue;
    }
    if (/^\s*\$\$/.test(line)) {
      const sameLine = /^\s*\$\$([\s\S]*?)\$\$\s*$/.exec(line);
      if (sameLine) {
        html.push(renderMath(sameLine[1].trim(), true));
        i++;
        continue;
      }
      const block: string[] = [line.replace(/^\s*\$\$/, "")];
      i++;
      while (i < lines.length && !/\$\$\s*$/.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      if (i < lines.length) {
        block.push(lines[i].replace(/\$\$\s*$/, ""));
        i++;
      }
      html.push(renderMath(block.join("\n").trim(), true));
      continue;
    }
    if (/^\s*\\\[\s*$/.test(line)) {
      const block: string[] = [];
      i++;
      while (i < lines.length && !/^\s*\\\]\s*$/.test(lines[i])) {
        block.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      html.push(renderMath(block.join("\n").trim(), true));
      continue;
    }
    const fenceOpen = /^ {0,3}```([a-zA-Z0-9_+\-#]*)\s*$/.exec(line);
    if (fenceOpen) {
      const lang = (fenceOpen[1] || "").toLowerCase();
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^ {0,3}```\s*$/.test(lines[i])) {
        body.push(lines[i]);
        i++;
      }
      if (i < lines.length) i++;
      const code = body.join("\n");
      const innerHtml = lang ? highlightCode(code, lang) : escape(code);
      const langClass = lang ? ` data-lang="${lang}"` : "";
      const headLabel = lang ? `<span class="arc-md-lang-label">${escape(lang)}</span>` : "";
      const copyIcon = `<svg class="arc-md-copy-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>`;
      const checkIcon = `<svg class="arc-md-copy-check" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M20 6 9 17l-5-5"></path></svg>`;
      html.push(
        `<div class="arc-md-codeblock"${langClass}>` +
          `<div class="arc-md-codehead">${headLabel}<button type="button" class="arc-md-copy" title="Copy code" aria-label="Copy code">${copyIcon}${checkIcon}</button></div>` +
          `<pre class="arc-md-pre"${langClass}><code class="arc-md-code">${innerHtml}</code></pre>` +
          `</div>`,
      );
      continue;
    }
    const [htmlOut, next] = renderBlockLines(lines, i);
    html.push(htmlOut);
    i = next;
  }
  return html.join("");
}
function renderBlockLines(lines: string[], start: number): [string, number] {
  let i = start;
  const line = lines[i];
  if (line === undefined) return ["", i];
  if (/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
    return [`<hr class="arc-md-hr" />`, i + 1];
  }
  const h = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
  if (h) return [`<h${h[1].length}>${renderInline(h[2])}</h${h[1].length}>`, i + 1];
  if (i + 1 < lines.length && /\|/.test(line)) {
    const splitRow = (r: string): string[] =>
      r.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
    const head = splitRow(line);
    const delimCells = splitRow(lines[i + 1]);
    const delimOk =
      head.length > 0 &&
      delimCells.length === head.length &&
      delimCells.every((c) => /^:?-+:?$/.test(c)) &&
      delimCells.join("").replace(/[^ -]/g, "").length >= 3;
    if (delimOk) {
      i += 2;
    const aligns = splitRow(lines[i - 1]).map((c) => {
      const l = c.startsWith(":");
      const r = c.endsWith(":");
      return l && r ? "center" : r ? "right" : l ? "left" : "";
    });
    const headHtml = `<tr>${head.map((c, idx) => `<th style="text-align:${aligns[idx] || "left"}">${renderInline(c)}</th>`).join("")}</tr>`;
    const bodyRows: string[] = [];
    while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim() !== "") {
      const cells = splitRow(lines[i]);
      while (cells.length < head.length) cells.push("");
      bodyRows.push(`<tr>${cells.map((c, idx) => `<td style="text-align:${aligns[idx] || "left"}">${renderInline(c)}</td>`).join("")}</tr>`);
      i++;
    }
    return [`<table class="arc-md-table"><thead>${headHtml}</thead><tbody>${bodyRows.join("")}</tbody></table>`, i];
    }
  }
  if (isListLine(line)) {
    const [html, nextI] = renderListAt(lines, i, indentOf(line));
    return [html, nextI];
  }
  const buf: string[] = [line];
  i++;
  while (
    i < lines.length &&
    lines[i].trim() !== "" &&
    !/^(#{1,6})\s+/.test(lines[i]) &&
    !/^ {0,3}(-{3,}|\*{3,}|_{3,})\s*$/.test(lines[i]) &&
    !isListLine(lines[i]) &&
    !/^ {0,3}>/.test(lines[i]) &&
    !/^ {0,3}```/.test(lines[i])
  ) {
    buf.push(lines[i]);
    i++;
  }
  return [`<p>${renderInline(buf.join(" "))}</p>`, i];
}
function renderBlockquote(raw: string[], level: number): string {
  const current: string[] = [];
  const nested: string[] = [];
  for (const l of raw) {
    if (/^ {0,3}>/.test(l)) {
      nested.push(l.replace(/^ {0,3}> ?/, ""));
    } else {
      current.push(l);
    }
  }
  const inner = renderBlock(current.join("\n"));
  if (nested.length) {
    return `<blockquote class="arc-md-quote">${inner}${renderBlockquote(nested, level + 1)}</blockquote>`;
  }
  return `<blockquote class="arc-md-quote">${inner}</blockquote>`;
}
function isListLine(line: string): boolean {
  return /^ {0,6}([-*]|\d+\.)\s+/.test(line);
}
function indentOf(line: string): number {
  const m = /^( *)/.exec(line)!;
  return m[1].length;
}
function renderListAt(lines: string[], start: number, parentIndent: number): [string, number] {
  const out: string[] = [];
  let i = start;
  let currentTag: "ul" | "ol" | null = null;
  let liOpen = false;
  const closeLiIfOpen = () => {
    if (liOpen) { out.push(`</li>`); liOpen = false; }
  };
  const closeList = () => {
    if (currentTag) {
      closeLiIfOpen();
      out.push(`</${currentTag}>`);
      currentTag = null;
    }
  };
  while (i < lines.length) {
    const l = lines[i];
    if (l.trim() === "") {
      let k = i + 1;
      while (k < lines.length && lines[k].trim() === "") k++;
      if (k < lines.length && isListLine(lines[k]) && indentOf(lines[k]) >= parentIndent) {
        i = k;
        continue;
      }
      break;
    }
    if (!isListLine(l)) break;
    const indent = indentOf(l);
    if (indent < parentIndent) break;
    const content = l.replace(/^ *([-*]|\d+\.)\s+/, "");
    const isOrdered = /^\d+\.\s+/.test(l.trimStart());
    const tag: "ul" | "ol" = isOrdered ? "ol" : "ul";
    if (indent > parentIndent) {
      if (!liOpen) {
        i++;
        continue;
      }
      const [childHtml, nextI] = renderListAt(lines, i, indent);
      out.push(childHtml);
      i = nextI;
      closeLiIfOpen();
      continue;
    }
    if (currentTag === null) {
      currentTag = tag;
      out.push(`<${tag} class="arc-md-${tag}">`);
    } else if (currentTag !== tag) {
      closeList();
      currentTag = tag;
      out.push(`<${tag} class="arc-md-${tag}">`);
    } else {
      closeLiIfOpen();
    }
    const taskMatch = /^(\[[ xX]\])(\s+.*)$/.exec(content);
    if (!isOrdered && taskMatch) {
      const checked = taskMatch[1].toLowerCase() === "[x]";
      const rest = taskMatch[2];
      out.push(
        `<li class="arc-md-task">` +
        `<input type="checkbox" disabled${checked ? " checked" : ""} /> ` +
        `${renderInline(rest)}</li>`,
      );
      liOpen = false; 
    } else {
      out.push(`<li>${renderInline(content)}`);
      liOpen = true;
    }
    i++;
  }
  closeList();
  return [out.join(""), i];
}
export function renderMarkdown(src: string): string {
  if (!src) return "";
  return renderBlock(src);
}