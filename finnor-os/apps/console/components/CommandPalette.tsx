"use client";

// Hand-rolled command palette (~120 lines, no cmdk dependency — Phase 10 decision:
// zero new npm deps). Static command list only — no action-execution commands here:
// approving from a palette without seeing the card would weaken the confirmation
// gate's "a human actually read it" property. Deliberate non-goal.

import { useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

function readTheme(): "dark" | "light" {
  if (typeof document === "undefined") return "dark";
  return (document.documentElement.getAttribute("data-theme") as "dark" | "light") ?? "dark";
}

function setTheme(theme: "dark" | "light") {
  document.documentElement.setAttribute("data-theme", theme);
  window.localStorage.setItem("finnor_theme", theme);
}

export default function CommandPalette() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [activeIndex, setActiveIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands: Command[] = useMemo(
    () => [
      { id: "nav-home", label: "Go to Mission Control", hint: "home", run: () => router.push("/") },
      { id: "nav-underwriting", label: "Go to Underwriting", hint: "models, runs, returns", run: () => router.push("/underwriting") },
      { id: "nav-confirm", label: "Go to Confirmation Queue", hint: "confirm", run: () => router.push("/confirm") },
      { id: "nav-customers", label: "Go to Customers", hint: "customers", run: () => router.push("/customers") },
      { id: "nav-audit", label: "Go to Audit Log", hint: "audit", run: () => router.push("/audit") },
      { id: "nav-policy", label: "Go to Policies", hint: "policy", run: () => router.push("/policy") },
      { id: "nav-comms", label: "Go to Communications", hint: "comms", run: () => router.push("/comms") },
      { id: "nav-talk", label: "Go to Talk to Finnor", hint: "talk", run: () => router.push("/talk") },
      { id: "queue-pending", label: "Approve queue → pending", hint: "confirm?filter=pending", run: () => router.push("/confirm") },
      { id: "queue-blocked", label: "Approve queue → blocked", hint: "confirm?filter=blocked", run: () => router.push("/confirm") },
      {
        id: "toggle-theme",
        label: "Toggle theme",
        hint: "dark/light",
        run: () => setTheme(readTheme() === "dark" ? "light" : "dark"),
      },
    ],
    [router],
  );

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) => c.label.toLowerCase().includes(q) || c.hint?.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => {
    function onKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setOpen((prev) => !prev);
      } else if (e.key === "Escape" && open) {
        setOpen(false);
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [open]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActiveIndex(0);
      // Focus trap: the input is the only focusable element while open.
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => {
    setActiveIndex(0);
  }, [query]);

  function runActive() {
    const cmd = filtered[activeIndex];
    if (!cmd) return;
    cmd.run();
    setOpen(false);
  }

  if (!open) return null;

  return (
    <div className="palette-backdrop" role="presentation" onClick={() => setOpen(false)}>
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Command palette"
        onClick={(e) => e.stopPropagation()}
      >
        <input
          ref={inputRef}
          className="palette-input"
          placeholder="Type a command…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setActiveIndex((i) => Math.min(i + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setActiveIndex((i) => Math.max(i - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              runActive();
            }
          }}
        />
        <div className="palette-list">
          {filtered.length === 0 && <div className="palette-empty">No matching commands.</div>}
          {filtered.map((c, i) => (
            <div
              key={c.id}
              className={`palette-item${i === activeIndex ? " active" : ""}`}
              onMouseEnter={() => setActiveIndex(i)}
              onClick={() => {
                c.run();
                setOpen(false);
              }}
            >
              {c.label}
              {c.hint && <span style={{ float: "right", color: "var(--text-faint)" }}>{c.hint}</span>}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
