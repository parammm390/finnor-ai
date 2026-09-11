"use client";

import { usePathname } from "next/navigation";

const LINKS = [
  { href: "/work", label: "Work + Attention" },
  { href: "/ic", label: "Investment Committee" },
  { href: "/underwriting", label: "Underwriting" },
  { href: "/confirm", label: "Confirmation Queue" },
  { href: "/customers", label: "Customers" },
  { href: "/audit", label: "Audit Log" },
  { href: "/policy", label: "Policies" },
  { href: "/comms", label: "Communications" },
];

function readTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return (document.documentElement.getAttribute("data-theme") as "dark" | "light") ?? "dark";
}

export default function Nav() {
  const pathname = usePathname();

  function toggleTheme() {
    const next = readTheme() === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    window.localStorage.setItem("finnor_theme", next);
  }

  return (
    <nav className="app-nav">
      <a href="/" className="app-brand">FINNOR</a>
      {LINKS.map((l) => (
        <a key={l.href} href={l.href} className={`app-nav-link${pathname === l.href || pathname.startsWith(`${l.href}/`) ? " active" : ""}`}>
          {l.label}
        </a>
      ))}
      <a href="/talk" className="app-nav-link talk">🎙 Talk to Finnor</a>
      <div className="app-nav-spacer" />
      <button className="palette-hint" onClick={() => window.dispatchEvent(new KeyboardEvent("keydown", { key: "k", metaKey: true }))}>
        ⌘K
      </button>
      <button className="theme-toggle" onClick={toggleTheme}>◐ Theme</button>
    </nav>
  );
}
