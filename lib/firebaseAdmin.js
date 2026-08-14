// Firebase Admin (server-only). Mints custom tokens after MSG91 verifies an OTP,
// and creates the Firebase user + Firestore profile.
//
// Accepts THREE credential formats (whichever is set wins, in this order):
//   1) FIREBASE_SERVICE_ACCOUNT          -> the full service-account JSON on one line
//   2) FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY  (3 split vars)
//   3) GOOGLE_APPLICATION_CREDENTIALS    -> absolute path to the JSON file on the server
//
// Lazy-initialised so a missing config never crashes the app at import time.
import { initializeApp, getApps, cert, applicationDefault } from "firebase-admin/app";
import { getAuth } from "firebase-admin/auth";
import { getFirestore } from "firebase-admin/firestore";

let _app;

// Normalise a PEM private key whether it arrived with real newlines, escaped \n, or wrapping quotes.
function fixKey(k) {
  if (!k) return k;
  let key = String(k).trim();
  if ((key.startsWith('"') && key.endsWith('"')) || (key.startsWith("'") && key.endsWith("'"))) {
    key = key.slice(1, -1);
  }
  key = key.replace(/\\r/g, "").replace(/\\n/g, "\n"); // escaped -> real newlines
  return key;
}

function loadCreds() {
  // --- Format 1: single-line JSON ---
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT;
  if (raw && raw.trim()) {
    let creds;
    try { creds = typeof raw === "string" ? JSON.parse(raw) : raw; }
    catch (e) { throw new Error("FIREBASE_SERVICE_ACCOUNT is set but is not valid JSON: " + (e?.message || e)); }
    if (creds.private_key) creds.private_key = fixKey(creds.private_key);
    if (!creds.private_key || !creds.client_email || !creds.project_id) {
      throw new Error("FIREBASE_SERVICE_ACCOUNT JSON is missing project_id / client_email / private_key.");
    }
    return cert(creds);
  }

  // --- Format 2: three split vars ---
  const projectId = process.env.FIREBASE_PROJECT_ID;
  const clientEmail = process.env.FIREBASE_CLIENT_EMAIL;
  const privateKey = process.env.FIREBASE_PRIVATE_KEY;
  if (projectId && clientEmail && privateKey) {
    return cert({ projectId, clientEmail, privateKey: fixKey(privateKey) });
  }

  // --- Format 3: file path on disk ---
  if (process.env.GOOGLE_APPLICATION_CREDENTIALS) {
    return applicationDefault();
  }

  throw new Error(
    "No Firebase Admin credentials found. Set one of: FIREBASE_SERVICE_ACCOUNT (one-line JSON), " +
    "or FIREBASE_PROJECT_ID + FIREBASE_CLIENT_EMAIL + FIREBASE_PRIVATE_KEY, " +
    "or GOOGLE_APPLICATION_CREDENTIALS (path to the JSON file)."
  );
}

function app() {
  if (_app) return _app;
  if (getApps().length) { _app = getApps()[0]; return _app; }
  _app = initializeApp({ credential: loadCreds() });
  return _app;
}

export function adminAuth() { return getAuth(app()); }
export function adminDb() { return getFirestore(app()); }
