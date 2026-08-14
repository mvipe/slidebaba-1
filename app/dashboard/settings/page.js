"use client";

import { useEffect, useRef, useState } from "react";
import { Mail, Phone, User, Upload, Building2, Save, Check, Loader2 } from "lucide-react";
import Topbar from "@/components/dashboard/Topbar";
import { useAuth } from "@/context/AuthContext";
import { doc, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase";

// Downscale an uploaded image to a small data URL so it fits within Firestore limits.
function downscale(file, max = 256) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        const scale = Math.min(1, max / Math.max(img.width, img.height));
        const w = Math.round(img.width * scale);
        const h = Math.round(img.height * scale);
        const canvas = document.createElement("canvas");
        canvas.width = w;
        canvas.height = h;
        canvas.getContext("2d").drawImage(img, 0, 0, w, h);
        resolve(canvas.toDataURL("image/jpeg", 0.82));
      };
      img.onerror = reject;
      img.src = reader.result;
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

export default function SettingsPage() {
  const { user, profile } = useAuth();
  const fileRef = useRef(null);
  const [fullName, setFullName] = useState("");
  const [coaching, setCoaching] = useState("");
  const [logo, setLogo] = useState("");
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);

  useEffect(() => {
    if (profile) {
      setFullName(profile.fullName || "");
      setCoaching(profile.coaching || "");
      setLogo(profile.logo || "");
    }
  }, [profile]);

  const pickLogo = async (f) => {
    if (!f) return;
    if (f.size > 2 * 1024 * 1024) return alert("Please choose an image under 2 MB.");
    try {
      setLogo(await downscale(f));
    } catch {
      alert("Couldn't read that image.");
    }
  };

  const save = async () => {
    if (!user) return;
    setBusy(true);
    setDone(false);
    try {
      await updateDoc(doc(db, "users", user.uid), { fullName, coaching, logo });
      setDone(true);
      setTimeout(() => setDone(false), 2500);
    } catch (e) {
      alert("Couldn't save: " + (e?.message || "unknown error"));
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Topbar title="Account Settings" />
      <div className="flex-1 overflow-y-auto bg-dots p-6">
        <div className="mx-auto max-w-2xl rounded-3xl bg-ink-850 p-7 ring-1 ring-white/10">
          <h2 className="font-display text-xl font-extrabold text-white">Account Settings</h2>

          <div className="mt-6 space-y-5">
            <Field label="Full name" icon={User}>
              <input className="input pl-11" value={fullName} onChange={(e) => setFullName(e.target.value)} placeholder="Your name" />
            </Field>

            <Field label="Email address" icon={Mail}>
              <input className="input pl-11 opacity-60" value={profile?.email || user?.email || ""} readOnly />
            </Field>

            <Field label="Phone number" icon={Phone}>
              <input className="input pl-11 opacity-60" value={profile?.phone || user?.phoneNumber || ""} readOnly />
            </Field>

            <div>
              <label className="label">Logo</label>
              <div className="flex items-center gap-4">
                <div className="grid h-16 w-16 place-items-center overflow-hidden rounded-xl bg-ink-800 ring-1 ring-inset ring-white/10">
                  {logo ? (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={logo} alt="logo" className="h-full w-full object-cover" />
                  ) : (
                    <Upload className="h-5 w-5 text-slate-500" />
                  )}
                </div>
                <div>
                  <input ref={fileRef} type="file" accept="image/png,image/jpeg" hidden onChange={(e) => pickLogo(e.target.files?.[0])} />
                  <button onClick={() => fileRef.current?.click()} className="btn-ghost">
                    <Upload className="h-4 w-4" /> Upload Logo
                  </button>
                  <p className="mt-1 text-xs text-slate-500">PNG, JPG — max 2 MB</p>
                </div>
              </div>
            </div>

            <Field label="Coaching / Institute name" icon={Building2}>
              <input className="input pl-11" value={coaching} onChange={(e) => setCoaching(e.target.value)} placeholder="e.g. Sharma Classes | 7761088809" />
            </Field>

            <button onClick={save} disabled={busy} className="btn-primary">
              {busy ? <Loader2 className="h-4 w-4 animate-spin" /> : done ? <Check className="h-4 w-4" /> : <Save className="h-4 w-4" />}
              {done ? "Saved" : "Save Changes"}
            </button>
          </div>
        </div>
      </div>
    </>
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
