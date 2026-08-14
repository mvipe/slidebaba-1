"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { User, Mail, Phone, UserPlus, Loader2, ShieldCheck } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";
import { useAuth } from "@/context/AuthContext";

export default function RegisterPage() {
  const { sendRegisterOtp, confirmRegisterOtp, resendOtp } = useAuth();
  const router = useRouter();
  const [form, setForm] = useState({ fullName: "", email: "", phone: "" });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const [step, setStep] = useState("form"); // "form" | "otp"

  const [otp, setOtp] = useState("");
  const [otpErr, setOtpErr] = useState("");

  const set = (k) => (e) => setForm((f) => ({ ...f, [k]: e.target.value }));

  useEffect(() => {
    if (typeof window === "undefined") return;
    const pre = new URLSearchParams(window.location.search).get("phone");
    if (pre) setForm((f) => ({ ...f, phone: pre }));
  }, []);

  const onSubmit = async () => {
    setError("");
    if (!form.fullName || !form.phone) { setError("Please enter your name and mobile number."); return; }
    if (form.phone.replace(/\D/g, "").length < 10) { setError("Enter a valid 10-digit mobile number."); return; }
    setBusy(true);
    try {
      await sendRegisterOtp(form.phone);
      setStep("otp"); setOtpErr("");
    } catch (e) { setError(e?.message || "Couldn't send the code. Please try again."); }
    finally { setBusy(false); }
  };

  const verify = async () => {
    setOtpErr("");
    if (otp.replace(/\D/g, "").length < 4) { setOtpErr("Enter the 6-digit code we sent you."); return; }
    setBusy(true);
    try {
      await confirmRegisterOtp(otp.trim(), { phone: form.phone, name: form.fullName, email: form.email });
      router.push("/dashboard");
    } catch (e) { setOtpErr(e?.message || "That code is incorrect. Please try again."); }
    finally { setBusy(false); }
  };

  const resend = async () => {
    setOtpErr(""); setBusy(true);
    try { await resendOtp(form.phone); }
    catch (e) { setOtpErr(e?.message || "Couldn't resend the code."); }
    finally { setBusy(false); }
  };

  if (step === "otp") {
    return (
      <AuthShell>
        <div className="grid h-12 w-12 place-items-center rounded-2xl bg-brand-gradient text-white shadow-soft"><ShieldCheck className="h-6 w-6" /></div>
        <h1 className="mt-4 font-display text-3xl font-extrabold text-white">Verify your number</h1>
        <p className="mt-2 text-sm text-slate-400">We sent a 6-digit code to <b className="text-slate-200">{form.phone}</b>. Enter it below to finish creating your account.</p>

        <div className="mt-7 space-y-5">
          <div>
            <label className="label">Verification code</label>
            <input
              inputMode="numeric"
              maxLength={6}
              className="input text-center text-lg tracking-[0.5em]"
              placeholder="••••••"
              value={otp}
              onChange={(e) => setOtp(e.target.value.replace(/\D/g, ""))}
              onKeyDown={(e) => e.key === "Enter" && verify()}
            />
          </div>

          {otpErr && <p className="text-sm font-medium text-accent-400">{otpErr}</p>}

          <button onClick={verify} disabled={busy} className="btn-cool w-full text-base">
            {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ShieldCheck className="h-4 w-4" />} Verify &amp; Continue
          </button>

          <div className="flex items-center justify-between text-sm">
            <button onClick={resend} disabled={busy} className="font-semibold text-brand-300 hover:text-brand-200 disabled:opacity-50">Resend code</button>
            <button onClick={() => { setStep("form"); setOtp(""); setOtpErr(""); }} className="text-slate-500 hover:text-slate-300">Change details</button>
          </div>
        </div>
      </AuthShell>
    );
  }

  return (
    <AuthShell>
      <h1 className="font-display text-3xl font-extrabold text-white">Start for Free</h1>
      <p className="mt-2 text-sm text-slate-400">Create your account — we&apos;ll verify your phone with a quick OTP.</p>

      <div className="mt-7 space-y-5">
        <Field label="Full name" icon={User}>
          <input className="input pl-11" placeholder="Your name" value={form.fullName} onChange={set("fullName")} />
        </Field>
        <Field label="Email address (optional)" icon={Mail}>
          <input type="email" className="input pl-11" placeholder="name@domain.com" value={form.email} onChange={set("email")} />
        </Field>
        <Field label="Phone number" icon={Phone}>
          <input className="input pl-11" inputMode="numeric" maxLength={10} placeholder="10-digit mobile number" value={form.phone} onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value.replace(/\D/g, "").slice(0, 10) }))} onKeyDown={(e) => e.key === "Enter" && onSubmit()} />
        </Field>

        {error && <p className="text-sm font-medium text-accent-400">{error}</p>}

        <button onClick={onSubmit} disabled={busy} className="btn-cool w-full text-base">
          {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <UserPlus className="h-4 w-4" />} Send OTP
        </button>
      </div>

      <p className="mt-6 text-center text-sm text-slate-400">
        Already have an account? <Link href="/login" className="font-semibold text-brand-300 hover:text-brand-200">Sign in here</Link>
      </p>
      <p className="mt-4 text-center text-xs text-slate-600">By continuing, you agree to our Terms of Service &amp; Privacy Policy.</p>
    </AuthShell>
  );
}

function Field({ label, icon: Icon, children }) {
  return (
    <div>
      <label className="label">{label}</label>
      <div className="relative">
        <Icon className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
        {children}
      </div>
    </div>
  );
}