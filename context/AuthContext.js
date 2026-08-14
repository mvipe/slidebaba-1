"use client";

import { createContext, useContext, useEffect, useState, useCallback } from "react";
import {
  createUserWithEmailAndPassword,
  signInWithEmailAndPassword,
  signInWithCustomToken,
  updateProfile,
  sendPasswordResetEmail,
  signOut,
  onAuthStateChanged,
} from "firebase/auth";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { auth, db } from "@/lib/firebase";
import { maybeRenew } from "@/lib/plan";

const AuthContext = createContext(null);

/** Normalise an Indian phone number to E.164 (+91XXXXXXXXXX). */
export function normalizePhone(raw) {
  const digits = String(raw || "").replace(/[^\d]/g, "");
  if (!digits) return "";
  if (digits.length === 10) return `+91${digits}`;
  if (digits.length === 12 && digits.startsWith("91")) return `+${digits}`;
  if (String(raw).trim().startsWith("+")) return String(raw).trim();
  return `+${digits}`;
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [profile, setProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsub = onAuthStateChanged(auth, async (u) => {
      setUser(u);
      if (u) {
        try {
          const snap = await getDoc(doc(db, "users", u.uid));
          if (snap.exists()) {
            let data = snap.data();
            const renewPatch = await maybeRenew(u.uid, data);
            if (renewPatch) data = { ...data, ...renewPatch };
            setProfile(data);
          } else setProfile(null);
        } catch {
          setProfile(null);
        }
      } else {
        setProfile(null);
      }
      setLoading(false);
    });
    return () => unsub();
  }, []);

  // ---- Register (creates account + profile + phone index) ----
  const register = useCallback(async ({ fullName, email, phone, password }) => {
    const e164 = normalizePhone(phone);
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: fullName });

    const profileData = {
      uid: cred.user.uid,
      fullName,
      email,
      phone: e164,
      plan: "free",
      period: "monthly",
      docsLimit: 0,
      docsUsed: 0,
      snipsLimit: 0,
      snipsUsed: 0,
      createdAt: serverTimestamp(),
    };
    await setDoc(doc(db, "users", cred.user.uid), profileData);
    // Public index so phone -> email login & register-first checks work.
    await setDoc(doc(db, "phoneIndex", e164), { email, uid: cred.user.uid });
    setProfile(profileData);
    return cred.user;
  }, []);

  // ---- Password login (accepts phone OR email) ----
  const loginWithPassword = useCallback(async (identifier, password) => {
    let email = identifier;
    if (!String(identifier).includes("@")) {
      const e164 = normalizePhone(identifier);
      const idx = await getDoc(doc(db, "phoneIndex", e164));
      if (!idx.exists()) {
        throw new Error("No account found for this number. Please create an account first.");
      }
      email = idx.data().email;
    }
    return signInWithEmailAndPassword(auth, email, password);
  }, []);

  // ---- OTP via MSG91 (passwordless; server mints a Firebase custom token) ----
  const postJSON = async (url, payload) => {
    const res = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok || !data.ok) throw new Error(data.error || "Something went wrong. Please try again.");
    return data;
  };

  const sendOtp = useCallback(async (phone) => {
    const e164 = normalizePhone(phone);
    const res = await fetch("/api/auth/otp/send", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ phone: e164, mode: "login" }) });
    let data = {};
    try { data = await res.json(); } catch {}
    if (!res.ok || !data.ok) {
      const err = new Error(data.error || "Could not send the OTP. Please try again.");
      if (data.notRegistered) err.notRegistered = true;
      throw err;
    }
    if (typeof window !== "undefined") window._otpPhone = e164;
    return true;
  }, []);

  const resendOtp = useCallback(async (phone) => {
    const e164 = normalizePhone(phone || (typeof window !== "undefined" ? window._otpPhone : ""));
    await postJSON("/api/auth/otp/resend", { phone: e164 });
    return true;
  }, []);

  const confirmOtp = useCallback(async (code, phone) => {
    const e164 = normalizePhone(phone || (typeof window !== "undefined" ? window._otpPhone : ""));
    const { token } = await postJSON("/api/auth/otp/verify", { phone: e164, otp: code, mode: "login" });
    const cred = await signInWithCustomToken(auth, token);
    return cred.user;
  }, []);

  // Registration OTP — the account is created on the server when the OTP is verified.
  const sendRegisterOtp = useCallback(async (phone) => {
    const e164 = normalizePhone(phone);
    await postJSON("/api/auth/otp/send", { phone: e164, mode: "register" });
    if (typeof window !== "undefined") window._otpPhone = e164;
    return true;
  }, []);

  const confirmRegisterOtp = useCallback(async (code, extra = {}) => {
    const e164 = normalizePhone(extra.phone || (typeof window !== "undefined" ? window._otpPhone : ""));
    const { token } = await postJSON("/api/auth/otp/verify", { phone: e164, otp: code, mode: "register", name: extra.name || "", email: extra.email || "" });
    const cred = await signInWithCustomToken(auth, token);
    return cred.user;
  }, []);

  const resetPassword = useCallback(async (email) => sendPasswordResetEmail(auth, email), []);
  const logout = useCallback(async () => signOut(auth), []);

  const mergeProfile = useCallback((patch) => setProfile((p) => ({ ...(p || {}), ...patch })), []);
  const refreshProfile = useCallback(async () => {
    const u = auth.currentUser;
    if (!u) return;
    try { const snap = await getDoc(doc(db, "users", u.uid)); if (snap.exists()) setProfile(snap.data()); } catch {}
  }, []);

  const value = {
    user,
    profile,
    loading,
    register,
    loginWithPassword,
    sendOtp,
    resendOtp,
    confirmOtp,
    resetPassword,
    logout,
    sendRegisterOtp,
    confirmRegisterOtp,
    mergeProfile,
    refreshProfile,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
