"use client";

/**
 * "Watch tutorial" — a button plus a lightbox that plays the SlideBaba walkthrough.
 *
 * The iframe is mounted ONLY while the modal is open. An always-present YouTube embed
 * pulls several hundred KB of player JavaScript into the landing page on first paint,
 * which is a real cost on a mobile connection for something most visitors never click.
 *
 * youtube-nocookie.com is used so no tracking cookie is set unless the video is played.
 */

import { useEffect, useState, useCallback } from "react";
import { Play, X } from "lucide-react";

/** Change this one constant to swap the tutorial. */
export const TUTORIAL_VIDEO_ID = "9bQa1SRDSq4";
export const TUTORIAL_URL = `https://youtu.be/${TUTORIAL_VIDEO_ID}`;
const EMBED_URL =
  `https://www.youtube-nocookie.com/embed/${TUTORIAL_VIDEO_ID}` +
  `?autoplay=1&rel=0&modestbranding=1&playsinline=1`;

/* -------------------------------------------------------------------------- */

export function TutorialModal({ open, onClose }) {
  // Escape to close, and stop the page behind from scrolling while it is open.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === "Escape") onClose?.(); };
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/80 p-4 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="SlideBaba tutorial"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
    >
      <div className="relative w-full max-w-4xl">
        <button
          onClick={onClose}
          aria-label="Close tutorial"
          className="absolute -top-11 right-0 grid h-9 w-9 place-items-center rounded-full bg-white/10 text-white ring-1 ring-white/20 transition hover:bg-white/20"
        >
          <X className="h-4 w-4" />
        </button>

        <div className="overflow-hidden rounded-2xl bg-black shadow-glow ring-1 ring-white/15">
          <div className="relative w-full" style={{ paddingTop: "56.25%" }}>
            <iframe
              className="absolute inset-0 h-full w-full"
              src={EMBED_URL}
              title="How to use SlideBaba"
              frameBorder="0"
              allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
              referrerPolicy="strict-origin-when-cross-origin"
              allowFullScreen
            />
          </div>
        </div>

        <p className="mt-3 text-center text-xs text-slate-400">
          Trouble playing?{" "}
          <a href={TUTORIAL_URL} target="_blank" rel="noopener noreferrer" className="font-semibold text-brand-300 underline-offset-2 hover:underline">
            Open it on YouTube
          </a>
        </p>
      </div>
    </div>
  );
}

/* -------------------------------------------------------------------------- */

/**
 * A button that opens the tutorial. `className` styles the button itself, so the same
 * component can be a ghost link on the landing page and a solid button elsewhere.
 */
export default function WatchTutorial({ className = "", label = "Watch tutorial", icon = true }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)} className={className}>
        {icon && <Play className="h-4 w-4" />} {label}
      </button>
      <TutorialModal open={open} onClose={close} />
    </>
  );
}

/* -------------------------------------------------------------------------- */

/** A card for the dashboard — a thumbnail with a play badge, straight from YouTube. */
export function TutorialCard({ className = "" }) {
  const [open, setOpen] = useState(false);
  const close = useCallback(() => setOpen(false), []);
  return (
    <>
      <div className={`overflow-hidden rounded-3xl bg-ink-850 ring-1 ring-white/10 ${className}`}>
        <div className="flex flex-col gap-5 p-6 sm:flex-row sm:items-center sm:p-7">
          <button
            type="button"
            onClick={() => setOpen(true)}
            aria-label="Play the SlideBaba tutorial"
            className="group relative w-full shrink-0 overflow-hidden rounded-2xl ring-1 ring-white/10 sm:w-64"
            style={{ aspectRatio: "16 / 9" }}
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img
              src={`https://i.ytimg.com/vi/${TUTORIAL_VIDEO_ID}/hqdefault.jpg`}
              alt=""
              className="absolute inset-0 h-full w-full object-cover transition duration-300 group-hover:scale-105"
              loading="lazy"
            />
            <span className="absolute inset-0 bg-black/30 transition group-hover:bg-black/15" />
            <span className="absolute inset-0 grid place-items-center">
              <span className="grid h-12 w-12 place-items-center rounded-full bg-white/95 text-ink-900 shadow-glow transition group-hover:scale-110">
                <Play className="ml-0.5 h-5 w-5 fill-current" />
              </span>
            </span>
          </button>

          <div className="min-w-0">
            <h3 className="font-display text-lg font-extrabold text-white">New here? Watch the tutorial</h3>
            <p className="mt-1.5 text-sm leading-relaxed text-slate-400">
              A quick walkthrough: upload a document, scan it, and turn it into editable slides or A4 notes.
            </p>
            <button
              type="button"
              onClick={() => setOpen(true)}
              className="btn-primary mt-4 px-4 py-2.5 text-sm"
            >
              <Play className="h-4 w-4" /> Watch tutorial
            </button>
          </div>
        </div>
      </div>
      <TutorialModal open={open} onClose={close} />
    </>
  );
}
