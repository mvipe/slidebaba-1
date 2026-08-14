"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Phone, ArrowRight, Loader2, ShieldCheck } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";
import { useAuth } from "@/context/AuthContext";

export default function LoginPage() {
  const { sendOtp, confirmOtp, resendOtp } = useAuth();
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [step, setStep] = useState("phone"); // "phone" | "otp"
  const [otp, setOtp] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [info, setInfo] = useState("");

  const sendCode = async () => {
    setError(""); setInfo("");
    if (phone.replace(/\D/g, "").length < 10) { setError("Enter a valid 10-digit mobile number."); return; }
    setBusy(true);
    try { await sendOtp(phone); setStep("otp"); }
    catch (e) {
      if (e?.notRegistered) {
        setBusy(false);
        setInfo("This number isn't registered yet — taking you to sign up…");
        setTimeout(() => router.push(`/register?phone=${encodeURIComponent(phone)}`), 1400);
        return;
      }
      setError(e?.message || "Couldn't send the code. Please try again.");
    }
    finally { setBusy(false); }
  };

  const verify = async () => {
    setError("");
    if (otp.replace(/\D/g, "").length < 4) { setError("Enter the 6-digit code we sent you."); return; }
    setBusy(true);
    try { await confirmOtp(otp.trim(), phone); router.push("/dashboard"); }
    catch (e) { setError(e?.message || "That code is incorrect. Please try again."); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    setError(""); setBusy(true);
    try { await resendOtp(phone); }
    catch (e) { setError(e?.message || "Couldn't resend the code."); }
    finally { setBusy(false); }
  };

  if (step === "otp") {
    return (
      <AuthShell>
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-gradient text-white shadow-soft"><ShieldCheck className="h-6 w-6" /></div>
        <h1 className="mt-4 font-display text-3xl font-extrabold text-white">Enter the code</h1>
        <p className="mt-2 text-sm text-slate-400">We sent a 6-digit code to <b className="text-slate-200">{phone}</b>.</p>

        <div className="mt-7 space-y-5">
          <input
            inputMode="numeric"
            maxLength={6}
            className="input text-center text-lg tracking-[0.5em]"
            placeholder="••••••"
            value={otp}
            onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
            onKeyDown={(e) => e.key === "Enter" && verify()}
          />
          {error && <p className="text-sm font-medium text-accent-400">{error}</p>}
          <button onClick={verify} disabled={busy} className="btn-cool w-full text-base">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Verify &amp; Sign In
          </button>
          <div className="flex items-center justify-between text-sm">
            <button onClick={resend} disabled={busy} className="font-semibold text-brand-300 hover:text-brand-200 disabled:opacity-50">Resend code</button>
            <button onClick={() => { setStep("phone"); setOtp(""); setError(""); }} className="text-slate-500 hover:text-slate-300">Change number</button>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="font-display text-3xl font-extrabold text-white">Welcome Back</h1>
      <p className="mt-2 text-sm text-slate-400">Sign in with your mobile number and a one-time code.</p>

      <div className="mt-7 space-y-5">
        <div>
          <label className="label">Phone number</label>
          <div className="relative">
            <Phone className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
            <input
              className="input pl-11"
              inputMode="numeric"
              placeholder="Enter 10-digit mobile number"
              value={phone}
              maxLength={10}
              onChange={(e) => setPhone(e.target.value.replace(/\D/g, "").slice(0, 10))}
              onKeyDown={(e) => e.key === "Enter" && sendCode()}
            />
          </div>
        </div>

        {error && <p className="text-sm font-medium text-accent-400">{error}</p>}
        {info && <p className="flex items-center gap-1.5 text-sm font-medium text-emerald-400"><Loader2 className="h-3.5 w-3.5 animate-spin" /> {info}</p>}

        <button onClick={sendCode} disabled={busy || !!info} className="btn-cool w-full text-base">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
          Send OTP <ArrowRight className="h-4 w-4" />
        </button>
      </div>

      <p className="mt-6 text-center text-sm text-slate-400">
        New to SlideBaba?{" "}
        <Link href="/register" className="font-semibold text-brand-300 hover:text-brand-200">Create an account</Link>
      </p>
    </AuthShell>
  );
}