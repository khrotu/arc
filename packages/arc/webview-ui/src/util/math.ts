const ESC: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
export const esc = (s: string): string => s.replace(/[&<>"']/g, (c) => ESC[c] ?? c);
const MORD = "mord";
const MBIN = "mbin";
const MREL = "mrel";
const MOPEN = "mopen";
const MCLOSE = "mclose";
const MPUNCT = "mpunct";
const MOP = "mop";
const MINNER = "minner";
const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ϵ", varepsilon: "ε",
  zeta: "ζ", eta: "η", theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ",
  lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", omicron: "ο", pi: "π", varpi: "ϖ",
  rho: "ρ", varrho: "ϱ", sigma: "σ", varsigma: "ς", tau: "τ", upsilon: "υ",
  phi: "ϕ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ",
  Upsilon: "Υ", Phi: "Φ", Psi: "Ψ", Omega: "Ω", Omicron: "Ο", Epsilon: "Ε",
  Zeta: "Ζ", Eta: "Η", Iota: "Ι", Kappa: "Κ", Mu: "Μ", Nu: "Ν", Rho: "Ρ", Tau: "Τ", Chi: "Χ",
};
const SYM: Record<string, string | [string, string]> = {
  times: ["×", MBIN], div: ["÷", MBIN], cdot: ["·", MBIN], pm: ["±", MBIN], mp: ["∓", MBIN],
  le: ["≤", MREL], leq: ["≤", MREL], ge: ["≥", MREL], geq: ["≥", MREL],
  ne: ["≠", MREL], neq: ["≠", MREL], approx: ["≈", MREL], sim: ["∼", MREL], simeq: ["≃", MREL],
  propto: ["∝", MREL], equiv: ["≡", MREL], cong: ["≅", MREL],
  in: ["∈", MREL], notin: ["∉", MREL], ni: ["∋", MREL], subset: ["⊂", MREL], supset: ["⊃", MREL], subseteq: ["⊆", MREL], supseteq: ["⊇", MREL],
  cup: ["∪", MBIN], cap: ["∩", MBIN], land: ["∧", MBIN], wedge: ["∧", MBIN], lor: ["∨", MBIN], vee: ["∨", MBIN], lnot: ["¬", MREL], neg: ["¬", MREL],
  forall: ["∀", MREL], exists: ["∃", MREL], nexists: ["∄", MREL], nabla: "∇", partial: "∂",
  infty: ["∞", MORD], infinity: ["∞", MORD],
  to: ["→", MREL], rightarrow: ["→", MREL], leftarrow: ["←", MREL], leftrightarrow: ["↔", MREL], uparrow: ["↑", MREL], downarrow: ["↓", MREL], updownarrow: ["↕", MREL],
  Rightarrow: ["⇒", MREL], Leftarrow: ["⇐", MREL], mapsto: ["↦", MREL], rightleftharpoons: ["⇌", MREL],
  cdots: "⋯", ldots: "...", dots: "...", vdots: "⋮", ddots: "⋱",
  prime: "′", degree: "°", angle: "∠", perp: ["⊥", MREL], parallel: ["∥", MREL], therefore: ["∴", MREL], because: ["∵", MREL],
  emptyset: "∅", aleph: "ℵ", hbar: "ℏ", ell: "ℓ", Re: "ℜ", Im: "ℑ",
  langle: ["⟨", MOPEN], rangle: ["⟩", MCLOSE], mid: ["|", MREL], vert: ["|", MREL], Vert: ["‖", MREL], ast: ["∗", MBIN], star: ["∗", MBIN],
  circ: ["∘", MBIN], bullet: ["∙", MBIN], diamond: ["⋄", MBIN],
};
const BIG_OPS: Record<string, string> = {
  sum: "∑", prod: "∏", int: "∫", oint: "∮", coprod: "∐",
  bigcup: "⋃", bigcap: "⋂", bigoplus: "⊕", bigotimes: "⊗", bigvee: "⋁", bigwedge: "⋀",
};
const FUNC = new Set([
  "sin", "cos", "tan", "cot", "sec", "csc", "arcsin", "arccos", "arctan",
  "sinh", "cosh", "tanh", "log", "ln", "lg", "exp", "lim", "max", "min",
  "sup", "inf", "det", "dim", "ker", "deg", "arg", "gcd", "mod", "Pr", "Var", "Cov", "sgn", "erf",
]);
const ACCENTS: Record<string, string> = {
  hat: "^", widehat: "^", bar: "¯", overline: "¯", vec: "→", dot: "·",
  ddot: "¨", tilde: "~", widetilde: "~", overrightarrow: "→",
};
const BB: Record<string, string> = { R: "ℝ", N: "ℕ", Z: "ℤ", Q: "ℚ", C: "ℂ", P: "ℙ", H: "ℍ", F: "𝔽", E: "𝔼", B: "𝔹", D: "𝔻", I: "𝕀", J: "𝕁", K: "𝕂", L: "𝕃", M: "𝕄", S: "𝕊", T: "𝕋", U: "𝕌", V: "𝕍", W: "𝕎", X: "𝕏", Y: "𝕐" };
const CAL: Record<string, string> = { L: "ℒ", R: "ℛ", O: "𝒪", C: "𝒞", F: "ℱ", H: "ℋ", N: "𝒩", B: "ℬ", G: "𝒢", P: "𝒫", S: "𝒮", T: "𝒯", A: "𝒜", M: "ℳ" };
const MATRICES: Record<string, { open: string; close: string }> = {
  matrix: { open: "", close: "" },
  pmatrix: { open: "(", close: ")" },
  bmatrix: { open: "[", close: "]" },
  Bmatrix: { open: "{", close: "}" },
  vmatrix: { open: "|", close: "|" },
  Vmatrix: { open: "‖", close: "‖" },
};
const CHAR_CLASS: Record<string, string> = {
  "+": MBIN, "-": MBIN, "*": MBIN, "=": MREL, "<": MREL, ">": MREL, ":": MREL,
  "(": MOPEN, "[": MOPEN, "{": MOPEN, ")": MCLOSE, "]": MCLOSE, "}": MCLOSE,
  ",": MPUNCT, ";": MPUNCT, "|": MREL, "!": MORD, ".": MORD, "/": MORD,
};
const isLetter = (c: string): boolean => /[A-Za-z]/.test(c);
const atom = (cls: string, inner: string): string => `<span class="${cls}">${inner}</span>`;
class MathParser {
  private s: string;
  private i = 0;
  constructor(s: string) { this.s = s; }
  private done(): boolean { return this.i >= this.s.length; }
  private peek(): string { return this.s[this.i]; }
  seq(): string {
    let out = "";
    while (!this.done() && this.peek() !== "}") out += this.atom();
    return out;
  }
  private atom(): string {
    let base = this.base();
    let out = base;
    while (!this.done() && (this.peek() === "^" || this.peek() === "_")) {
      const op = this.peek();
      this.i++;
      const arg = this.arg();
      out = op === "^"
        ? `<span class="msupsub"><span class="msupsub-base">${base}</span><span class="msupsub-exp">${arg}</span></span>`
        : `<span class="msupsub"><span class="msupsub-base">${base}</span><span class="msupsub-sub">${arg}</span></span>`;
      base = out;
    }
    return out;
  }
  private base(): string {
    if (this.done()) return "";
    const c = this.peek();
    if (c === "{") { this.i++; const inner = this.seq(); if (this.peek() === "}") this.i++; return inner; }
    if (c === "\\") return this.command();
    if (c === "^" || c === "_") return "";
    if (c === "~") { this.i++; return "&nbsp;"; }
    this.i++;
    if (isLetter(c)) return atom(`${MORD} mathnormal`, esc(c));
    return atom(CHAR_CLASS[c] ?? MORD, esc(c));
  }
  private arg(): string {
    if (this.done()) return "";
    if (this.peek() === "{") { this.i++; const inner = this.seq(); if (this.peek() === "}") this.i++; return inner; }
    return this.base();
  }
  private rawGroup(): string {
    if (this.peek() !== "{") return this.arg();
    this.i++;
    let out = "";
    let depth = 1;
    while (!this.done() && depth > 0) {
      const c = this.peek();
      if (c === "{") { depth++; out += c; this.i++; }
      else if (c === "}") { depth--; this.i++; if (depth === 0) break; out += c; }
      else { out += c; this.i++; }
    }
    return out;
  }
  private command(): string {
    if (this.done()) return "\\";
    this.i++;
    let name = "";
    while (!this.done() && /[A-Za-z]/.test(this.peek())) { name += this.peek(); this.i++; }
    if (!name) {
      const c = this.peek();
      if (c && !/[A-Za-z]/.test(c)) {
        this.i++;
        switch (c) {
          case ",": return "&#8202;";
          case ";": return "&#8203;&#8202;";
          case ":": return "&#8202;&#8202;";
          case "!": return "";
          case " ": return "&nbsp;";
          case "\\": return " ";
          default: return atom(MORD, esc(c));
        }
      }
      return "\\";
    }
    return this.known(name);
  }
  private known(name: string): string {
    switch (name) {
      case "frac": {
        const n = this.arg(); const d = this.arg();
        return atom(MORD, `<span class="mfrac"><span class="mfrac-num">${n}</span><span class="frac-line"></span><span class="mfrac-den">${d}</span></span>`);
      }
      case "sqrt": {
        let idx = "";
        if (this.peek() === "[") { this.i++; while (!this.done() && this.peek() !== "]") { idx += this.peek(); this.i++; } if (this.peek() === "]") this.i++; }
        const body = this.arg();
        return idx
          ? atom(`${MORD} sqrt`, `<span class="katex-root">${esc(idx)}</span><span class="sqrt-sign">√</span><span class="sqrt-body">${body}</span>`)
          : atom(`${MORD} sqrt`, `<span class="sqrt-sign">√</span><span class="sqrt-body">${body}</span>`);
      }
      case "text": case "mbox": case "textnormal": case "textup": case "textrm":
        return atom(`${MORD} textrm`, esc(this.rawGroup()));
      case "mathrm": case "operatorname":
        return atom(`${MORD} mathrm`, esc(this.rawGroup()));
      case "textbf": case "mathbf": case "boldsymbol":
        return atom(`${MORD} textbf`, esc(this.rawGroup()));
      case "textit": case "mathit":
        return atom(`${MORD} textit`, esc(this.rawGroup()));
      case "textsf": case "mathsf":
        return atom(`${MORD} mathsf`, esc(this.rawGroup()));
      case "texttt": case "mathtt":
        return atom(`${MORD} mathtt`, esc(this.rawGroup()));
      case "mathbb": {
        const inner = this.arg();
        return atom(`${MORD} mathbb`, inner.split("").map((ch) => BB[ch] ?? esc(ch)).join(""));
      }
      case "mathcal": case "mathscr": {
        const inner = this.arg();
        return atom(`${MORD} mathcal`, inner.split("").map((ch) => CAL[ch] ?? esc(ch)).join(""));
      }
      case "left": case "right": {
        const cls = name === "left" ? MOPEN : MCLOSE;
        if (this.done()) return "";
        let ch = this.peek();
        if (ch === "\\") { this.i++; ch = this.peek(); }
        this.i++;
        if (ch === ".") return "";
        return atom(`${cls} delimcenter`, esc(ch));
      }
      case "big": case "Big": case "bigg": case "Bigg":
      case "bigl": case "bigr": case "Bigl": case "Bigr":
      case "biggl": case "biggr": case "Biggl": case "Biggr": {
        if (this.done()) return "";
        const ch = this.peek(); this.i++;
        const cls = /l$/.test(name) ? MOPEN : /r$/.test(name) ? MCLOSE : MORD;
        return atom(`${cls} delimcenter is-big`, esc(ch));
      }
      case "begin": return this.env();
      case "end": return "";
      case "quad": return "&emsp;&emsp;";
      case "qquad": return "&emsp;&emsp;&emsp;";
      case "enspace": return "&ensp;";
      case "thinspace": return "&#8202;";
      case "negthinspace": return "";
      case "limits": case "nolimits": case "displaystyle": case "textstyle":
      case "scriptstyle": case "scriptscriptstyle": return "";
      default: break;
    }
    if (FUNC.has(name)) return this.funcOp(name);
    if (ACCENTS[name]) {
      const inner = this.arg();
      return atom(`${MORD} accent`, `<span class="accent-body">${inner}</span><span class="accent-mark">${esc(ACCENTS[name])}</span>`);
    }
    if (BIG_OPS[name]) return this.bigOp(BIG_OPS[name]);
    if (GREEK[name]) return atom(`${MORD} mathnormal`, GREEK[name]);
    if (SYM[name] !== undefined) { const s = SYM[name]; return typeof s === "string" ? atom(MORD, s) : atom(s[1], s[0]); }
    return atom(MORD, esc(name));
  }
  private funcOp(name: string): string {
    let sub: string | undefined; let sup: string | undefined;
    while (!this.done() && (this.peek() === "^" || this.peek() === "_")) {
      const op = this.peek(); this.i++; const arg = this.arg();
      if (op === "_") sub = arg; else sup = arg;
    }
    let base = atom(MOP, name);
    if (sub) base = `<span class="msupsub"><span class="msupsub-base">${base}</span><span class="msupsub-sub">${sub}</span></span>`;
    if (sup) base = `<span class="msupsub"><span class="msupsub-base">${base}</span><span class="msupsub-exp">${sup}</span></span>`;
    return base;
  }
  private bigOp(sym: string): string {
    let lower: string | undefined; let upper: string | undefined;
    while (!this.done() && (this.peek() === "^" || this.peek() === "_")) {
      const op = this.peek(); this.i++; const arg = this.arg();
      if (op === "_") lower = arg; else upper = arg;
    }
    if (lower || upper) {
      return atom(`${MOP} op-limits`, `<span class="mop-lim">${upper ?? "&nbsp;"}</span><span class="mop-sym">${sym}</span><span class="mop-lim">${lower ?? "&nbsp;"}</span>`);
    }
    return atom(MOP, sym);
  }
  private env(): string {
    const env = this.rawGroup();
    const m = MATRICES[env];
    const marker = `\\end{${env}}`;
    const idx = this.s.indexOf(marker, this.i);
    const raw = idx >= 0 ? this.s.slice(this.i, idx) : this.s.slice(this.i);
    this.i = idx >= 0 ? idx + marker.length : this.s.length;
    if (!m && !raw.trim()) return "";
    const rows = raw.split(/\\\\/).map((r) => r.split("&").map((cell) => new MathParser(cell).seq()));
    const mtrs = rows.map((r) => `<span class="mtr">${r.map((c) => `<span class="mtd">${c}</span>`).join("")}</span>`).join("");
    const inner = `<span class="mtable">${mtrs}</span>`;
    const open = m?.open ? atom(`${MOPEN} delimcenter is-big`, esc(m.open)) : "";
    const close = m?.open ? atom(`${MCLOSE} delimcenter is-big`, esc(m.close)) : "";
    return atom(MINNER, `${open}${inner}${close}`);
  }
}
export function renderMath(src: string, display = false): string {
  const body = new MathParser(src).seq();
  const katex = `<span class="katex"><span class="katex-html" aria-hidden="true">${body}</span></span>`;
  return display ? `<span class="katex-display">${katex}</span>` : katex;
}