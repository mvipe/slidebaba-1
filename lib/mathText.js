// Converts LaTeX math into clean, EDITABLE Unicode text (no images).
// Handles the cases that show up in exam papers: fractions, exponents,
// subscripts, roots, Greek letters, operators, trig/log functions.
// Anything exotic degrades gracefully to readable inline text.

const SUP = {
  "0": "⁰", "1": "¹", "2": "²", "3": "³", "4": "⁴", "5": "⁵", "6": "⁶", "7": "⁷", "8": "⁸", "9": "⁹",
  "+": "⁺", "-": "⁻", "−": "⁻", "=": "⁼", "(": "⁽", ")": "⁾", ".": "·",
  a: "ᵃ", b: "ᵇ", c: "ᶜ", d: "ᵈ", e: "ᵉ", f: "ᶠ", g: "ᵍ", h: "ʰ", i: "ⁱ", j: "ʲ", k: "ᵏ", l: "ˡ",
  m: "ᵐ", n: "ⁿ", o: "ᵒ", p: "ᵖ", r: "ʳ", s: "ˢ", t: "ᵗ", u: "ᵘ", v: "ᵛ", w: "ʷ", x: "ˣ", y: "ʸ", z: "ᶻ",
  A: "ᴬ", B: "ᴮ", D: "ᴰ", E: "ᴱ", G: "ᴳ", H: "ᴴ", I: "ᴵ", J: "ᴶ", K: "ᴷ", L: "ᴸ", M: "ᴹ", N: "ᴺ",
  O: "ᴼ", P: "ᴾ", R: "ᴿ", T: "ᵀ", U: "ᵁ", V: "ⱽ", W: "ᵂ", " ": " ",
};
const SUB = {
  "0": "₀", "1": "₁", "2": "₂", "3": "₃", "4": "₄", "5": "₅", "6": "₆", "7": "₇", "8": "₈", "9": "₉",
  "+": "₊", "-": "₋", "−": "₋", "=": "₌", "(": "₍", ")": "₎",
  a: "ₐ", e: "ₑ", h: "ₕ", i: "ᵢ", j: "ⱼ", k: "ₖ", l: "ₗ", m: "ₘ", n: "ₙ", o: "ₒ", p: "ₚ",
  r: "ᵣ", s: "ₛ", t: "ₜ", u: "ᵤ", v: "ᵥ", x: "ₓ", " ": " ",
};
const UNI = {
  times: "×", div: "÷", pm: "±", mp: "∓", cdot: "·", ast: "∗", star: "⋆", bullet: "•",
  leq: "≤", le: "≤", geq: "≥", ge: "≥", neq: "≠", ne: "≠", approx: "≈", equiv: "≡", cong: "≅",
  sim: "∼", simeq: "≃", propto: "∝", ll: "≪", gg: "≫", doteq: "≐",
  rightarrow: "→", to: "→", longrightarrow: "→", leftarrow: "←", gets: "←", Rightarrow: "⇒",
  implies: "⇒", Leftarrow: "⇐", iff: "⇔", leftrightarrow: "↔", Leftrightarrow: "⇔", mapsto: "↦",
  infty: "∞", circ: "∘", degree: "°", prime: "′", dprime: "″",
  ldots: "…", dots: "…", cdots: "⋯", vdots: "⋮", ddots: "⋱",
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η",
  theta: "θ", vartheta: "ϑ", iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π",
  rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ", phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
  sum: "∑", prod: "∏", int: "∫", oint: "∮", partial: "∂", nabla: "∇", surd: "√",
  angle: "∠", perp: "⊥", parallel: "∥", therefore: "∴", because: "∵", triangle: "△",
  in: "∈", notin: "∉", ni: "∋", subset: "⊂", supset: "⊃", subseteq: "⊆", supseteq: "⊇",
  cup: "∪", cap: "∩", setminus: "∖", forall: "∀", exists: "∃", nexists: "∄", emptyset: "∅", varnothing: "∅",
  land: "∧", wedge: "∧", lor: "∨", vee: "∨", neg: "¬", oplus: "⊕", otimes: "⊗",
  pi: "π", ell: "ℓ", Re: "ℜ", Im: "ℑ", aleph: "ℵ", hbar: "ℏ", nabla: "∇",
  lfloor: "⌊", rfloor: "⌋", lceil: "⌈", rceil: "⌉", langle: "⟨", rangle: "⟩",
};
const ESCAPED = { "%": "%", "&": "&", "#": "#", _: "_", $: "$", "{": "{", "}": "}", " ": " " };
const FUNCS = ["sin", "cos", "tan", "cot", "sec", "csc", "sinh", "cosh", "tanh", "log", "ln", "lim", "max", "min", "exp", "gcd", "det", "arg", "deg", "mod"];
const TEXT_CMDS = ["text", "textrm", "textbf", "textit", "textsf", "texttt", "mathrm", "mathbf", "mathit", "mathsf", "operatorname", "emph", "underline", "boldsymbol"];
const SKIP = ["left", "right", "displaystyle", "textstyle", "scriptstyle", "limits", "nolimits", "big", "Big", "bigg", "Bigg", "bigl", "bigr", "biggl", "biggr", "!"];
const VULGAR = { "1/2": "½", "1/3": "⅓", "2/3": "⅔", "1/4": "¼", "3/4": "¾", "1/5": "⅕", "2/5": "⅖", "3/5": "⅗", "4/5": "⅘", "1/6": "⅙", "1/8": "⅛", "3/8": "⅜" };

function mapAll(str, table) {
  let out = "";
  for (const ch of str) {
    if (table[ch] === undefined) return null;
    out += table[ch];
  }
  return out;
}
const toSuper = (s) => mapAll(s, SUP);
const toSub = (s) => mapAll(s, SUB);

function readGroup(s, i) {
  if (s[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < s.length; j++) {
    if (s[j] === "{") depth++;
    else if (s[j] === "}") { depth--; if (depth === 0) return { content: s.slice(i + 1, j), end: j + 1 }; }
  }
  return { content: s.slice(i + 1), end: s.length };
}
function readArg(s, i) {
  if (s[i] === "{") { const g = readGroup(s, i); return { value: parse(g.content), end: g.end }; }
  if (s[i] === "\\") { const m = /^\\([a-zA-Z]+)/.exec(s.slice(i)); if (m) return { value: parse(s.slice(i, i + m[0].length)), end: i + m[0].length }; }
  return { value: s[i] || "", end: i + 1 };
}
function frac(a, b) {
  const sa = toSuper(a), sb = toSub(b);
  if (sa && sb && a.length <= 3 && b.length <= 3) return sa + "⁄" + sb;
  if (VULGAR[`${a}/${b}`]) return VULGAR[`${a}/${b}`];
  const an = a.length > 1 ? `(${a})` : a;
  const bn = b.length > 1 ? `(${b})` : b;
  return `${an}/${bn}`;
}
function sup(inner) {
  const m = toSuper(inner);
  if (m) return m;
  if (inner === "∘") return "°";
  if (inner.length === 1 && !/[A-Za-z0-9]/.test(inner)) return inner;
  return `^${inner.length > 1 ? `(${inner})` : inner}`;
}
function sub(inner) {
  const m = toSub(inner);
  if (m) return m;
  return `_${inner.length > 1 ? `(${inner})` : inner}`;
}

function parse(s) {
  let out = "";
  let i = 0;
  while (i < s.length) {
    const c = s[i];
    if (c === "\\") {
      const m = /^\\([a-zA-Z]+)/.exec(s.slice(i));
      if (m) {
        const name = m[1];
        let j = i + m[0].length;
        if (name === "frac" || name === "dfrac" || name === "tfrac" || name === "cfrac") {
          const a = readGroup(s, j);
          if (a) { const b = readGroup(s, a.end); if (b) { out += frac(parse(a.content), parse(b.content)); i = b.end; continue; } }
        }
        if (name === "sqrt") {
          let root = null;
          if (s[j] === "[") { const k = s.indexOf("]", j); if (k !== -1) { root = parse(s.slice(j + 1, k)); j = k + 1; } }
          const a = readGroup(s, j);
          const inner = a ? parse(a.content) : (() => { const r = readArg(s, j); j = r.end; return r.value; })();
          if (a) j = a.end;
          out += (root ? (toSuper(root) || `${root} `) : "") + "√" + (inner.length > 1 ? inner : inner);
          i = j; continue;
        }
        if (TEXT_CMDS.includes(name)) { const a = readGroup(s, j); if (a) { out += parse(a.content); i = a.end; continue; } i = j; continue; }
        if (SKIP.includes(name)) { i = j; continue; }
        if (FUNCS.includes(name)) { out += name; i = j; continue; }
        if (UNI[name] !== undefined) { out += UNI[name]; i = j; continue; }
        out += name; i = j; continue; // unknown command -> keep its name
      }
      const nxt = s[i + 1];
      if (nxt === "\\") { out += "\n"; i += 2; continue; }
      if (ESCAPED[nxt] !== undefined) { out += ESCAPED[nxt]; i += 2; continue; }
      if (nxt === ",") { out += " "; i += 2; continue; }
      i += 1; continue;
    }
    if (c === "^") { const a = readArg(s, i + 1); out += sup(a.value); i = a.end; continue; }
    if (c === "_") { const a = readArg(s, i + 1); out += sub(a.value); i = a.end; continue; }
    if (c === "{" || c === "}") { i += 1; continue; }
    out += c; i += 1;
  }
  return out;
}

export function latexToUnicode(input) {
  if (!input) return "";
  return parse(String(input).replace(/\$\$?/g, ""));
}

// Convert a full string that may contain $...$ delimited math into plain Unicode text.
export function mixedToUnicode(text) {
  if (!text) return "";
  let s = String(text);
  // $$...$$ then $...$ then \(...\) then \[...\]
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, m) => latexToUnicode(m));
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, m) => latexToUnicode(m));
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, m) => latexToUnicode(m));
  s = s.replace(/\$([^$\n]*?)\$/g, (_, m) => latexToUnicode(m));
  // any leftover bare commands outside delimiters
  if (/\\[a-zA-Z]/.test(s) || /[\^_]/.test(s)) s = latexToUnicode(s);
  return s;
}