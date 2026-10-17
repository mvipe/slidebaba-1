/**
 * User-facing error messages.
 *
 * Customers must never see raw errors — provider names ("Gemini", "ChatGPT"), HTTP codes,
 * parameter names, Firestore codes or stack text. Every error shown on a page goes through
 * userError(): it logs the ORIGINAL error to the console (browser) or server log, and
 * returns a short message that says what to do.
 *
 * Server routes use publicError() for the `error` field of a JSON response: the original
 * text in development (so testing stays easy), the friendly text in production. They also
 * send `errorKind`, so the browser can pick the right message without the raw text.
 */

export const ERROR_KIND = {
  BUSY: "busy",             // provider overloaded / rate-limited / daily limit — try later
  CONFIG: "config",         // our setup is wrong (key, model, parameter, billing) — not the user's fault
  NETWORK: "network",       // timeout / connection dropped
  UNREADABLE: "unreadable", // the page itself could not be read
  OTHER: "other",
};

const KINDS = new Set(Object.values(ERROR_KIND));

/** Work out what kind of failure this is, from an explicit kind or the error text. */
export function classifyError(err) {
  const explicit = err?.kind || err?.errorKind;
  if (explicit && KINDS.has(explicit)) return explicit;

  const status = Number(err?.status) || 0;
  const t = `${err?.code || ""} ${err?.message || err || ""}`.toLowerCase();

  if (/could not read any text|couldn't read any page|unreadable|clearer scan|refused this page/.test(t)) return ERROR_KIND.UNREADABLE;
  if (status === 429 || status === 503 || /\b(429|503)\b|high demand|overloaded|rate.?limit|busy|too many requests|daily limit|resource.?exhausted|capacity/.test(t)) return ERROR_KIND.BUSY;
  if (status === 408 || /timeout|timed out|did not respond|did not answer|network|failed to fetch|fetch failed|econn|socket|aborted|connection|unavailable|offline/.test(t)) return ERROR_KIND.NETWORK;
  if ([400, 401, 403, 404].includes(status) || /\b(400|401|403|404)\b|not configured|api key|unsupported parameter|invalid|not found|billing|no credit|quota|max_tokens|permission|unauthenticated|credential/.test(t)) return ERROR_KIND.CONFIG;
  return ERROR_KIND.OTHER;
}

const SCAN = {
  busy: "Our scanning service is busy right now. Please try again in a few minutes.",
  config: "Scanning is temporarily unavailable. Please try again later.",
  network: "The connection was slow or dropped. Please check your internet and try again.",
  unreadable: "We couldn't read this page. Please upload a clearer scan.",
  other: "Something went wrong while scanning. Please try again.",
};

/** Messages per screen. A string applies to every kind; an object picks by kind (falls back to `other`). */
const MESSAGES = {
  scan: SCAN,
  split: { ...SCAN, unreadable: SCAN.unreadable, other: "We couldn't prepare your slides. Please try again.", config: "We couldn't prepare your slides. Please try again later." },
  file: "Couldn't read that file. Make sure it's a valid PDF or image.",
  save: { network: "Your result couldn't be saved because the connection dropped. Please try again. Download your result before leaving this page.", other: "Your result couldn't be saved. Please sign in again and retry. Download your result before leaving this page." },
  create: { network: "This document couldn't be added to My Documents because the connection dropped. Your scan still runs — download the result before leaving this page.", other: "This document couldn't be added to My Documents. Your scan still runs — download the result before leaving this page." },
  open: "Couldn't open your slides. Please try again.",
  notes: "Couldn't open your notes. Please try again.",
  export: "Download failed. Please try again. Your slides are safe.",
  login: { busy: "Too many attempts right now. Please wait a minute and try again.", network: "The connection was slow or dropped. Please check your internet and try again.", other: "Login is temporarily unavailable. Please try again later." },
};

/** The friendly message for a kind of failure on a given screen. */
export function friendlyMessage(kind, context = "scan") {
  const m = MESSAGES[context] || MESSAGES.scan;
  if (typeof m === "string") return m;
  return m[kind] || m.other || SCAN.other;
}

/**
 * Log the original error and return the message to show the user.
 * An error that already carries a vetted `userMessage` keeps it (e.g. plan limits).
 */
export function userError(err, context = "scan") {
  console.error(`[SlideBaba] ${context} error:`, err);
  if (err?.userMessage) return err.userMessage;
  return friendlyMessage(classifyError(err), context);
}

/** Server side: the original text in development, the given friendly text in production. */
export function devOr(raw, friendly) {
  return process.env.NODE_ENV !== "production" ? String(raw || friendly) : friendly;
}

/** Server side: the `error` text to send — original in development, friendly in production. */
export function publicError(raw, kind, context = "scan") {
  return devOr(raw, friendlyMessage(kind || classifyError(raw), context));
}
