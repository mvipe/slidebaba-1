/* eslint-disable @next/next/no-img-element */
export default function Logo({ showText = true, size = 36, className = "" }) {
  return (
    <span className={`group inline-flex items-center gap-2.5 ${className}`}>
      <img
        src="/logo.png"
        alt="SLIDE BABA"
        width={size}
        height={size}
        className="rounded-xl shadow-soft"
        style={{ width: size, height: size }}
      />
      {showText && (
        <span className="select-none font-['Montserrat'] text-xl font-black uppercase leading-none tracking-tight">
          <span className="text-ink-900 transition-colors duration-200 group-hover:text-brand-500 dark:text-white dark:group-hover:text-brand-400">SLIDE</span>
          <span className="text-brand-500 transition-colors duration-200 group-hover:text-ink-900 dark:text-brand-400 dark:group-hover:text-white">&nbsp;BABA</span>
        </span>
      )}
    </span>
  );
}
