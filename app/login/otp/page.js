"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Phone, ArrowRight, Lock, Loader2, ShieldCheck } from "lucide-react";
import AuthShell from "@/components/auth/AuthShell";
import { useAuth } from "@/context/AuthContext";

export default function OtpLoginPage() {
  const { sendOtp, confirmOtp } = useAuth();
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState("phone"); // phone | code
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const onSend = async () => {
    setError("");
    if (!phone) {
      setError("Enter your registered mobile number.");
      return;
    }
    setBusy(true);
    try {
      await sendOtp(phone);
      setStage("code");
    } catch (e) {
      setError(e?.message || "Could not send OTP. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  const onConfirm = async () => {
    setError("");
    if (code.length < 6) {
      setError("Enter the 6-digit code.");
      return;
    }
    setBusy(true);
    try {
      await confirmOtp(code);
      router.push("/dashboard");
    } catch (e) {
      setError("Invalid or expired code. Please try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell>
      <h1 className="font-display text-3xl font-extrabold text-white">Welcome Back</h1>
      <p className="mt-2 text-sm text-slate-400">Log in to access your AI workspace.</p>

      <div className="mt-7 space-y-5">
        {stage === "phone" ? (
          <>
            <div>
              <label className="label">Phone number</label>
              <div className="relative">
                <Phone className="pointer-events-none absolute left-4 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
                <input
                  className="input pl-11"
                  placeholder="Enter 10-digit mobile number"
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && onSend()}
                />
              </div>
            </div>

            {error && <p className="text-sm font-medium text-accent-400">{error}</p>}

            <button onClick={onSend} disabled={busy} className="btn-cool w-full text-base">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Continue with OTP <ArrowRight className="h-4 w-4" />
            </button>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2 rounded-xl bg-brand-500/10 px-4 py-3 text-sm text-brand-200 ring-1 ring-inset ring-brand-500/30">
              <ShieldCheck className="h-4 w-4" /> Code sent to {phone}
            </div>
            <div>
              <label className="label">Enter OTP</label>
              <input
                className="input text-center text-lg tracking-[0.5em]"
                placeholder="••••••"
                maxLength={6}
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                onKeyDown={(e) => e.key === "Enter" && onConfirm()}
              />
            </div>

            {error && <p className="text-sm font-medium text-accent-400">{error}</p>}

            <button onClick={onConfirm} disabled={busy} className="btn-cool w-full text-base">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : null}
              Verify & Sign In <ArrowRight className="h-4 w-4" />
            </button>
            <button onClick={() => setStage("phone")} className="w-full text-center text-sm text-slate-400 hover:text-slate-200">
              Change number
            </button>
          </>
        )}

        <div className="flex items-center gap-3">
          <span className="h-px flex-1 bg-white/10" />
          <span className="text-xs font-semibold text-slate-500">OR</span>
          <span className="h-px flex-1 bg-white/10" />
        </div>

        <Link href="/login" className="btn-ghost w-full">
          <Lock className="h-4 w-4" /> Login with Password
        </Link>
      </div>

      <p className="mt-6 text-center text-sm text-slate-400">
        New to SlideBaba?{" "}
        <Link href="/register" className="font-semibold text-brand-300 hover:text-brand-200">
          Create an account
        </Link>
      </p>
    </AuthShell>
  );
}
