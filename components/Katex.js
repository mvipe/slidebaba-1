"use client";

import { useMemo } from "react";
import katex from "katex";

/* ---------- math environment matching ---------- */
const ENV_RE = /\\(begin|end)\{[a-zA-Z*]+\}/g;

function matchEnvironment(text, start) {
  ENV_RE.lastIndex = start;
  let depth = 0;
  let m;
  while ((m = ENV_RE.exec(text))) {
    depth += m[1] === "begin" ? 1 : -1;
    if (depth === 0) {
      const end = m.index + m[0].length;
      return { block: text.slice(start, end), end };
    }
  }
  return null;
}

/* ---------- tokenizer: split into text vs math ---------- */
function tokenize(text) {
  const tokens = [];
  let buf = "";
  let i = 0;
  const n = text.length;
  const flush = () => { if (buf) { tokens.push({ type: "text", value: buf }); buf = ""; } };

  while (i < n) {
    const two = text.slice(i, i + 2);
    if (two === "$$") {
      const end = text.indexOf("$$", i + 2);
      if (end !== -1) { flush(); tokens.push({ type: "math", display: true, value: text.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (two === "\\[") {
      const end = text.indexOf("\\]", i + 2);
      if (end !== -1) { flush(); tokens.push({ type: "math", display: true, value: text.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (two === "\\(") {
      const end = text.indexOf("\\)", i + 2);
      if (end !== -1) { flush(); tokens.push({ type: "math", display: false, value: text.slice(i + 2, end) }); i = end + 2; continue; }
    }
    if (text.startsWith("\\begin{", i)) {
      const env = matchEnvironment(text, i);
      if (env) { flush(); tokens.push({ type: "math", display: true, value: env.block, raw: true }); i = env.end; continue; }
    }
    if (text[i] === "$") {
      const nl = text.indexOf("\n", i + 1);
      const end = text.indexOf("$", i + 1);
      if (end !== -1 && (nl === -1 || end < nl)) { flush(); tokens.push({ type: "math", display: false, value: text.slice(i + 1, end) }); i = end + 1; continue; }
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return tokens;
}

/* ---------- LaTeX commands that appear OUTSIDE math ---------- */
const SYMBOLS = {
  "\\quad": '<span style="display:inline-block;width:1em"></span>',
  "\\qquad": '<span style="display:inline-block;width:2em"></span>',
  "\\enspace": '<span style="display:inline-block;width:0.5em"></span>',
  "\\thinspace": '<span style="display:inline-block;width:0.17em"></span>',
  "\\,": '<span style="display:inline-block;width:0.17em"></span>',
  "\\;": '<span style="display:inline-block;width:0.28em"></span>',
  "\\:": '<span style="display:inline-block;width:0.22em"></span>',
  "\\!": "",
  "\\%": "%", "\\&": "&amp;", "\\#": "#", "\\_": "_", "\\$": "$", "\\{": "{", "\\}": "}",
  "\\times": "×", "\\div": "÷", "\\pm": "±", "\\mp": "∓", "\\cdot": "·", "\\ast": "∗",
  "\\leq": "≤", "\\le": "≤", "\\geq": "≥", "\\ge": "≥", "\\neq": "≠", "\\ne": "≠",
  "\\approx": "≈", "\\equiv": "≡", "\\sim": "∼", "\\propto": "∝", "\\ll": "≪", "\\gg": "≫",
  "\\rightarrow": "→", "\\to": "→", "\\leftarrow": "←", "\\gets": "←", "\\Rightarrow": "⇒",
  "\\Leftarrow": "⇐", "\\leftrightarrow": "↔", "\\Leftrightarrow": "⇔", "\\mapsto": "↦",
  "\\infty": "∞", "\\degree": "°", "\\textdegree": "°", "\\circ": "∘",
  "\\ldots": "…", "\\dots": "…", "\\cdots": "⋯", "\\vdots": "⋮", "\\ddots": "⋱",
  "\\pi": "π", "\\alpha": "α", "\\beta": "β", "\\gamma": "γ", "\\delta": "δ",
  "\\epsilon": "ε", "\\varepsilon": "ε", "\\zeta": "ζ", "\\eta": "η", "\\theta": "θ",
  "\\vartheta": "ϑ", "\\iota": "ι", "\\kappa": "κ", "\\lambda": "λ", "\\mu": "μ", "\\nu": "ν",
  "\\xi": "ξ", "\\rho": "ρ", "\\sigma": "σ", "\\tau": "τ", "\\upsilon": "υ", "\\phi": "φ",
  "\\varphi": "φ", "\\chi": "χ", "\\psi": "ψ", "\\omega": "ω",
  "\\Gamma": "Γ", "\\Delta": "Δ", "\\Theta": "Θ", "\\Lambda": "Λ", "\\Xi": "Ξ", "\\Pi": "Π",
  "\\Sigma": "Σ", "\\Phi": "Φ", "\\Psi": "Ψ", "\\Omega": "Ω",
  "\\sqrt": "√", "\\sum": "∑", "\\prod": "∏", "\\int": "∫", "\\partial": "∂", "\\nabla": "∇",
  "\\angle": "∠", "\\perp": "⊥", "\\parallel": "∥", "\\therefore": "∴", "\\because": "∵",
  "\\in": "∈", "\\notin": "∉", "\\subset": "⊂", "\\supset": "⊃", "\\cup": "∪", "\\cap": "∩",
  "\\forall": "∀", "\\exists": "∃", "\\emptyset": "∅", "\\pm": "±",
};
const ARG_CMDS = ["\\hspace", "\\vspace", "\\textbf", "\\textit", "\\emph", "\\underline", "\\texttt", "\\text", "\\textrm", "\\textsf", "\\mathrm", "\\mathbf", "\\mathit"];

function readBrace(text, i) {
  if (text[i] !== "{") return null;
  let depth = 0;
  for (let j = i; j < text.length; j++) {
    if (text[j] === "{") depth++;
    else if (text[j] === "}") { depth--; if (depth === 0) return { content: text.slice(i + 1, j), end: j + 1 }; }
  }
  return null;
}
function cssLen(s) {
  const m = /^\s*(-?\d*\.?\d+)\s*(pt|mm|cm|in|ex|em|px|pc)\s*$/.exec(s || "");
  if (!m) return "1em";
  let v = parseFloat(m[1]);
  if (!(v > 0)) v = 0;
  return `${v}${m[2]}`;
}

// Resolve LaTeX commands that show up in plain-text (spacing, formatting, symbols).
//
// Per-word styling: while a box is being edited the browser shows the real inline styles
// the toolbar wrote. The read-only render — used by the preview, by the thumbnails and
// by the PDF snapshot — has to keep the SAME set, otherwise the text visibly changes the
// moment you click away and the export then matches the wrong one. Previously only
// colour and highlight survived, so per-word bold / italic / underline / size / font
// were silently dropped everywhere except the box you were typing in.
//
// Every value is matched against a strict pattern, so no url(), expression() or stray
// quote can escape into the attribute.
const COLOR_RE = /^(#[0-9a-fA-F]{3,8}|rgba?\([\d.,\s%]+\)|[a-zA-Z]+)$/;
const STYLE_RULES = {
  "color": COLOR_RE,
  "background": COLOR_RE,
  "background-color": COLOR_RE,
  "font-weight": /^([1-9]00|normal|bold|bolder|lighter)$/,
  "font-style": /^(normal|italic|oblique)$/,
  "font-size": /^\d{1,3}(\.\d+)?(px|pt|em|rem|%)$/,
  "font-family": /^[\w\s'\-,]{1,80}$/,
  "text-decoration": /^(none|(underline|line-through|overline)(\s+(underline|line-through|overline))*)$/,
  "text-decoration-line": /^(none|(underline|line-through|overline)(\s+(underline|line-through|overline))*)$/,
};
const STYLE_ALIAS = { "background-color": "background", "text-decoration-line": "text-decoration" };

function sanitizeSpanStyle(style) {
  const out = [];
  for (const part of String(style).split(";")) {
    const idx = part.indexOf(":");
    if (idx < 0) continue;
    const prop = part.slice(0, idx).trim().toLowerCase();
    const value = part.slice(idx + 1).trim();
    const rule = STYLE_RULES[prop];
    if (!rule || !rule.test(value)) continue;
    out.push(`${STYLE_ALIAS[prop] || prop}:${value}`);
  }
  return out.join(";");
}
// If a safe <span style="..."> or </span> starts at position i, return {html, len}; else null.
function matchSpanTag(text, i) {
  if (text.startsWith("</span>", i)) return { html: "</span>", len: 7 };
  const m = /^<span\s+style="([^"<>]*)">/.exec(text.slice(i, i + 240));
  if (m) {
    const safe = sanitizeSpanStyle(m[1]);
    if (safe) return { html: `<span style="${safe}">`, len: m[0].length };
  }
  return null;
}

function decorateText(text) {
  let out = "";
  let i = 0;
  const n = text.length;
  while (i < n) {
    const ch = text[i];
    if (ch === "\\") {
      const rest = text.slice(i);
      if (rest.startsWith("\\\\")) { out += "<br>"; i += 2; continue; }
      if (rest[1] === " ") { out += " "; i += 2; continue; }
      const nameMatch = /^\\([a-zA-Z]+)\*?/.exec(rest);
      if (nameMatch) {
        const full = nameMatch[0];
        const bare = "\\" + nameMatch[1];
        let j = i + full.length;
        if (ARG_CMDS.includes(bare)) {
          // skip optional whitespace then read {arg}
          while (text[j] === " ") j++;
          const grp = readBrace(text, j);
          if (grp) {
            const inner = grp.content;
            j = grp.end;
            if (bare === "\\hspace") out += `<span style="display:inline-block;width:${cssLen(inner)}"></span>`;
            else if (bare === "\\vspace") out += "";
            else if (bare === "\\textbf" || bare === "\\mathbf") out += `<b>${renderMixed(inner)}</b>`;
            else if (bare === "\\textit" || bare === "\\emph" || bare === "\\mathit") out += `<i>${renderMixed(inner)}</i>`;
            else if (bare === "\\underline") out += `<u>${renderMixed(inner)}</u>`;
            else if (bare === "\\texttt") out += `<code>${renderMixed(inner)}</code>`;
            else out += renderMixed(inner); // \text, \textrm, \textsf, \mathrm
            i = j;
            continue;
          }
        }
        if (SYMBOLS[bare] !== undefined) { out += SYMBOLS[bare]; i += full.length; continue; }
        out += escapeHtml(full); i += full.length; continue; // unknown: leave visible
      }
      const two = rest.slice(0, 2);
      if (SYMBOLS[two] !== undefined) { out += SYMBOLS[two]; i += 2; continue; }
      out += "\\"; i += 1; continue;
    }
    if (ch === "&") { out += "&amp;"; i += 1; continue; }
    if (ch === "<") {
      const sp = matchSpanTag(text, i);
      if (sp) { out += sp.html; i += sp.len; continue; }
      out += "&lt;"; i += 1; continue;
    }
    if (ch === ">") { out += "&gt;"; i += 1; continue; }
    out += ch;
    i += 1;
  }
  return out;
}

/* ---------- public renderer ---------- */
/* ---------- fallback: detect bare LaTeX that the model emitted WITHOUT $ delimiters ---------- */
// Commands/patterns that only appear in LaTeX math, never in normal Hindi/English prose.
const LATEX_HINT = /\\(?:frac|dfrac|tfrac|sqrt|lim|sum|prod|int|sin|cos|tan|cot|sec|csc|log|ln|left|right|begin|cdot|times|div|pm|mp|infty|alpha|beta|gamma|theta|pi|lambda|mu|sigma|Delta|partial|nabla|angle|triangle|vec|hat|bar|overline|underline|rightarrow|leftarrow|to|leq|geq|neq|approx|circ|prime|binom|matrix)\b|\\[a-zA-Z]+\s*\{|[\^_]\{|\\\\/;

// Scan forward from `start` consuming a full bare-LaTeX expression (brace-balanced),
// stopping only at a hard boundary (newline, or ordinary letters that clearly resume prose).
function scanLatexRun(s, start) {
  let i = start;
  let sawCmd = false;
  const n = s.length;
  while (i < n) {
    const ch = s[i];
    if (ch === "\n") break;
    if (ch === "\\") {
      // a command like \frac, \left, \to, or an escaped symbol
      sawCmd = true;
      i += 1;
      while (i < n && /[a-zA-Z]/.test(s[i])) i += 1;
      continue;
    }
    if (ch === "{" || ch === "[") {
      // consume a balanced group
      const open = ch; const close = ch === "{" ? "}" : "]";
      let depth = 0;
      while (i < n) {
        if (s[i] === open) depth += 1;
        else if (s[i] === close) { depth -= 1; if (depth === 0) { i += 1; break; } }
        else if (s[i] === "\n") break;
        i += 1;
      }
      continue;
    }
    if (ch === "^" || ch === "_") { i += 1; continue; }
    // math-safe single chars: digits, operators, parens, common math unicode, spaces
    if (/[A-Za-z0-9+\-*/=<>(),.:;|!'√×÷·°′″∞πθαβγλμσ\s]/.test(ch)) { i += 1; continue; }
    break;
  }
  // trim trailing whitespace out of the expression
  let end = i;
  while (end > start && /\s/.test(s[end - 1])) end -= 1;
  return { end, trimmedEnd: end, sawCmd };
}

// Split a plain-text token: pull out spans of bare LaTeX and mark them as math.
function splitBareLatex(value) {
  if (value.indexOf("<span") !== -1) return [{ type: "text", value }]; // don't disturb word-styling tags
  if (!LATEX_HINT.test(value)) return [{ type: "text", value }];
  const out = [];
  let pos = 0;
  let guard = 0;
  const n = value.length;
  while (pos < n && guard++ < 1000) {
    const slice = value.slice(pos);
    const rel = slice.search(LATEX_HINT);
    if (rel === -1) { out.push({ type: "text", value: slice }); break; }
    let start = pos + rel;
    // walk back to include a leading token attached to the command (e.g. "(C) " stays text, but "x^{2}" starts at x)
    while (start > pos && /[A-Za-z0-9]/.test(value[start - 1]) && !/\s/.test(value[start - 1])) start -= 1;
    if (start > pos) out.push({ type: "text", value: value.slice(pos, start) });
    const { end } = scanLatexRun(value, start);
    const expr = value.slice(start, end).replace(/\s+$/, "");
    if (expr.trim()) out.push({ type: "math", display: false, value: expr });
    else out.push({ type: "text", value: value.slice(start, Math.max(end, start + 1)) });
    pos = Math.max(end, start + 1);
  }
  return out.length ? out : [{ type: "text", value }];
}

// Expand text tokens that contain bare LaTeX into math tokens (delimited math already handled).
function withBareLatex(tokens) {
  const out = [];
  for (const tok of tokens) {
    if (tok.type === "text") out.push(...splitBareLatex(tok.value));
    else out.push(tok);
  }
  return out;
}

export function renderMixed(text) {
  if (!text) return "";
  return withBareLatex(tokenize(String(text)))
    .map((tok) => {
      if (tok.type === "text") return decorateText(tok.value);
      const expr = tok.raw ? tok.value : tok.value.trim();
      try {
        return katex.renderToString(expr, { throwOnError: false, displayMode: !!tok.display });
      } catch {
        return decorateText(tok.raw ? tok.value : tok.display ? `$$${tok.value}$$` : `$${tok.value}$`);
      }
    })
    .join("");
}

export default function Katex({ children, className = "" }) {
  const html = useMemo(() => renderMixed(String(children ?? "")), [children]);
  return <span className={className} dangerouslySetInnerHTML={{ __html: html }} />;
}

// Like renderMixed, but wraps each math chunk so its LaTeX source survives in the DOM
// (data-latex) — used by the A4 notes editor for styling pills and for Word export.
export function renderMixedAnnotated(text) {
  if (!text) return "";
  return withBareLatex(tokenize(String(text)))
    .map((tok) => {
      if (tok.type === "text") return decorateText(tok.value);
      const expr = tok.raw ? tok.value : tok.value.trim();
      let html;
      try { html = katex.renderToString(expr, { throwOnError: false, displayMode: !!tok.display }); }
      catch { html = decorateText(tok.raw ? tok.value : tok.display ? `$$${tok.value}$$` : `$${tok.value}$`); }
      return `<span class="mathpill" data-latex="${attr(expr)}">${html}</span>`;
    })
    .join("");
}

function attr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}