// Small helpers for plan/usage/billing display.

export function toDate(ts) {
  if (!ts) return new Date();
  if (typeof ts.toDate === "function") return ts.toDate();
  if (ts.seconds) return new Date(ts.seconds * 1000);
  return new Date(ts);
}

export function billingInfo(profile) {
  const created = toDate(profile?.createdAt);
  const renew = new Date(created.getTime() + 30 * 24 * 3600 * 1000);
  const now = new Date();
  const daysLeft = Math.max(0, Math.ceil((renew - now) / (24 * 3600 * 1000)));
  return { created, renew, daysLeft };
}

export function fmtDate(d) {
  try {
    return new Date(d).toLocaleDateString("en-IN", { day: "numeric", month: "short", year: "numeric" });
  } catch {
    return "";
  }
}
