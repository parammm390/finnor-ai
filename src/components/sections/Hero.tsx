"use client";

import { useEffect, useState } from "react";
import dynamic from "next/dynamic";
import { motion } from "framer-motion";
import { CalendarDays, FileText, Play, ShieldCheck, Waves } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { siteConfig } from "@/config/site";
import { Magnetic } from "@/components/ui/magnetic";
import { JarvisProofSurface } from "@/components/sections/jarvis-proof/JarvisProofSurface";

// Three.js (via Orb3D) is real weight (~140kB) that a public, SEO-facing homepage
// shouldn't pay for on first paint. Deferred client-only, same lazy-load discipline
// hard rule #4 asks for, applied at the bundle-splitting level, not just the
// animation level. The static gradient fallback below mirrors Orb3D's own reduced-
// motion/low-power collapse look, so there's no visual pop when the real module lands.
const MarketingOrb = dynamic(
  () =>
    import("@/components/sections/jarvis-proof/MarketingOrb").then(
      (m) => m.MarketingOrb,
    ),
  {
    ssr: false,
    loading: () => (
      <div
        className="h-full w-full rounded-full"
        style={{
          background:
            "radial-gradient(circle at 38% 32%, rgba(34,211,238,0.35) 0%, rgba(34,211,238,0.12) 45%, rgba(6,11,24,0.05) 72%)",
        }}
      />
    ),
  },
);

const navItems = [
  { href: "#product", label: "Product" },
  { href: "#capabilities", label: "Capabilities" },
  { href: "#workflow", label: "How It Works" },
  { href: "/resources", label: "Resources" },
  { href: "/trust-safety", label: "Trust" },
  { href: "#pricing", label: "Pricing" },
  { href: "#faq", label: "FAQ" },
];

const miniStatusItems: Array<{ icon: LucideIcon; label: string }> = [
  { icon: Waves, label: "Instruction understood" },
  { icon: ShieldCheck, label: "Approved by you" },
  { icon: FileText, label: "Receipt filed" },
];

const loopSteps = [
  "Instruction given",
  "Plan drafted",
  "You approve",
  "Executed + receipt",
];

// The orb only knows three states (idle/planning/executing); the strip has
// four beats. Map each orb state to the strip step it should light up so the
// two stay honest about what's actually happening rather than drifting apart
// on separate clocks. "Executing" holds the longest in the orb's own script,
// so it gets two beats (approve, then executed) instead of one.
const STEP_FOR_STATE: Record<string, number[]> = {
  idle: [0],
  planning: [1],
  executing: [2, 3],
};

const ORB_CAPTION: Record<string, string> = {
  idle: "Idle. Listening for the next instruction.",
  planning: "Planning. Breaking the outcome into steps.",
  executing: "Executing. Working the plan, verifying as it goes.",
};

export function Hero() {
  const [scrolled, setScrolled] = useState(false);
  const [orbState, setOrbState] = useState<string>("idle");

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 16);
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <section className="relative min-h-screen overflow-hidden px-0 pb-16 pt-24 md:pt-28">
      <div className="absolute inset-0 operational-grid opacity-45" />
      <div className="absolute inset-x-0 top-0 h-40 bg-gradient-to-b from-white via-white/80 to-transparent" />
      <div className="absolute left-[-16rem] top-[-12rem] h-[34rem] w-[34rem] rounded-full bg-sky-200/35 blur-3xl" />
      <div className="absolute right-[-13rem] top-16 h-[32rem] w-[32rem] rounded-full bg-teal-100/38 blur-3xl" />
      <div className="absolute inset-x-0 bottom-0 h-48 bg-gradient-to-t from-[#f8faf9] to-transparent" />

      <motion.nav
        initial={false}
        className={`fixed left-0 right-0 top-0 z-50 transition-all duration-300 ${
          scrolled
            ? "border-b border-slate-900/10 bg-white/88 shadow-[0_12px_42px_rgba(15,38,62,0.08)] backdrop-blur-xl"
            : "border-b border-transparent bg-transparent"
        }`}
      >
        <div className="container flex h-20 items-center justify-between px-4 md:px-6">
          <a
            href="/"
            className="flex items-center gap-3 text-xl font-black tracking-tight text-slate-950"
          >
            <span className="flex h-8 w-8 items-center justify-center rounded-xl bg-slate-950 text-xs font-black text-white shadow-lg">
              F
            </span>
            {siteConfig.name}
          </a>
          <div className="hidden items-center gap-5 lg:gap-8 md:flex">
            {navItems.map((item) => (
              <a
                key={item.href}
                href={item.href}
                className="text-xs font-black uppercase tracking-[0.18em] text-slate-600 transition hover:text-slate-950"
              >
                {item.label}
              </a>
            ))}
          </div>
          <div className="flex items-center gap-2">
            <a
              href="#demo-builder"
              className="cta-secondary hidden h-11 items-center justify-center rounded-full border border-slate-900/12 bg-white px-4 text-xs font-black text-slate-800 transition hover:-translate-y-0.5 hover:border-slate-900/22 md:inline-flex"
            >
              See JARVIS Work
            </a>
            <a
              href={siteConfig.calendlyLink}
              target="_blank"
              rel="noopener noreferrer"
              className="cta-primary inline-flex h-11 shrink-0 items-center justify-center rounded-full bg-slate-950 px-3 text-[10px] font-black text-white transition hover:-translate-y-0.5 hover:bg-slate-800 sm:px-5 sm:text-xs"
            >
              <span className="sm:hidden">Apply</span>
              <span className="hidden sm:inline">Book a JARVIS Demo</span>
            </a>
          </div>
        </div>
      </motion.nav>

      <div className="container relative z-10 px-4 md:px-6">
        <div className="grid items-center gap-12 lg:min-h-[calc(100vh-7rem)] lg:grid-cols-[0.94fr_1.06fr] lg:gap-14">
          <div className="max-w-3xl">
            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.55 }}
              className="mb-6 inline-flex max-w-full items-center rounded-full border border-sky-900/10 bg-white px-4 py-2 text-sm font-bold leading-snug text-slate-700 shadow-sm"
            >
              <span className="mr-2 h-2 w-2 rounded-full bg-teal-500 shadow-[0_0_0_4px_rgba(20,184,166,0.12)]" />
              VOICE-NATIVE AI OPERATIONS FOR WATER-TREATMENT COMPANIES
            </motion.div>

            <motion.h1
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.7, ease: [0.16, 1, 0.3, 1] }}
              className="max-w-[22rem] break-words text-[2.18rem] font-black leading-[0.99] tracking-tight text-slate-950 sm:max-w-4xl sm:text-6xl md:text-7xl lg:text-[5.75rem]"
            >
              Run your water-treatment company by talking to JARVIS.
            </motion.h1>

            <motion.p
              initial={{ opacity: 0, y: 16 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.1, duration: 0.62 }}
              className="mt-7 max-w-[22rem] text-base font-semibold leading-relaxed text-slate-700 sm:max-w-2xl sm:text-lg md:text-xl"
            >
              Give JARVIS a business outcome. It plans the work, executes across
              your calls, CRM, scheduling, proposals, invoices, inventory,
              technicians and campaigns, asks for approval when the risk
              requires it, and verifies what happened.
            </motion.p>

            <motion.p
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.18, duration: 0.55 }}
              className="mt-5 flex w-full max-w-full rounded-2xl border border-teal-800/14 bg-white px-4 py-3 text-sm font-black leading-relaxed text-slate-700 shadow-sm"
            >
              Speak naturally or type the outcome you need. JARVIS works with
              your existing systems and keeps the team focused on the decisions
              that require their judgment.
            </motion.p>

            <motion.div
              initial={{ opacity: 0, y: 14 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.25, duration: 0.58 }}
              className="mt-8 flex flex-col gap-3 sm:flex-row"
            >
              <Magnetic strength={0.16}>
                <a
                  href={siteConfig.calendlyLink}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-cursor="hover"
                  className="cta-primary inline-flex min-h-[3.75rem] items-center justify-center gap-2 rounded-full bg-slate-950 px-8 py-4 text-sm font-black text-white transition hover:-translate-y-0.5 hover:bg-slate-800"
                >
                  <CalendarDays className="h-4 w-4" />
                  Book a JARVIS Demo
                </a>
              </Magnetic>
              <Magnetic strength={0.14}>
                <a
                  href="#demo-builder"
                  data-cursor="hover"
                  className="cta-secondary inline-flex min-h-[3.75rem] items-center justify-center gap-2 rounded-full border border-slate-900/14 bg-white px-8 py-4 text-sm font-black text-slate-900 transition hover:-translate-y-0.5 hover:border-slate-900/24"
                >
                  <Play className="h-4 w-4 fill-slate-800" />
                  See JARVIS Work
                </a>
              </Magnetic>
            </motion.div>

            <SignalHandoffStrip orbState={orbState} />
          </div>

          <motion.div
            initial={{ opacity: 0, y: 24, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            transition={{
              delay: 0.18,
              duration: 0.78,
              ease: [0.16, 1, 0.3, 1],
            }}
            className="relative"
          >
            <JarvisOrbPanel onStateChange={setOrbState} />
          </motion.div>
        </div>
      </div>

      <MiniStatusBar visible={scrolled} activeIndex={STEP_FOR_STATE[orbState]?.[0] ?? 0} />
    </section>
  );
}

function JarvisOrbPanel({
  onStateChange,
}: {
  onStateChange: (state: string) => void;
}) {
  const [state, setState] = useState("idle");
  return (
    <div className="relative mx-auto max-w-[560px]">
      <div className="absolute -inset-6 rounded-[2.25rem] bg-gradient-to-br from-sky-200/52 via-white/40 to-teal-100/45 blur-2xl" />
      <JarvisProofSurface className="relative overflow-hidden rounded-[2rem] border border-white/10 p-6 shadow-[0_34px_110px_rgba(8,24,39,0.34)] md:p-8">
        <div className="mb-6 flex items-center justify-between">
          <p className="text-xs font-black uppercase tracking-[0.22em] text-[color:var(--j-text-dim)]">
            JARVIS
          </p>
          <span className="inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-white/[0.04] px-3 py-1 text-[10px] font-black uppercase tracking-widest text-[color:var(--j-text-dim)]">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-400/70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal-300" />
            </span>
            Live sample states
          </span>
        </div>
        <div
          className="mx-auto aspect-square w-full max-w-[400px] cursor-pointer"
          title="Click the orb"
        >
          <MarketingOrb
            className="h-full w-full"
            onStateChange={(s) => {
              setState(s);
              onStateChange(s);
            }}
          />
        </div>
        <motion.p
          key={state}
          initial={{ opacity: 0, y: 4 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.5 }}
          className="mt-6 text-center text-sm font-semibold text-[color:var(--j-text-dim)]"
        >
          {ORB_CAPTION[state]}
        </motion.p>
      </JarvisProofSurface>
    </div>
  );
}

function SignalHandoffStrip({ orbState }: { orbState: string }) {
  const active = new Set(STEP_FOR_STATE[orbState] ?? [0]);
  return (
    <motion.div
      initial={{ opacity: 0, y: 14 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ delay: 0.34, duration: 0.58 }}
      className="mt-8 max-w-full rounded-[1.5rem] border border-slate-900/10 bg-white/92 p-4 shadow-[0_18px_42px_rgba(15,38,62,0.08)] md:max-w-2xl"
    >
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2 text-xs font-black uppercase tracking-[0.2em] text-slate-600">
        <span>How an instruction becomes a receipt</span>
        <span className="text-teal-700">Every time, no exceptions</span>
      </div>
      <div className="signal-thread flex min-h-12 flex-wrap items-center justify-start gap-2 rounded-2xl bg-slate-50 px-3 py-2 md:justify-between">
        {loopSteps.map((step, index) => {
          const isActive = active.has(index);
          return (
            <motion.span
              key={step}
              animate={{
                scale: isActive ? 1.05 : 1,
                y: isActive ? -1 : 0,
              }}
              transition={{ duration: 0.5, ease: [0.16, 1, 0.3, 1] }}
              className={`relative z-10 flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-[10px] font-black uppercase tracking-widest shadow-sm transition-colors duration-500 ${
                isActive
                  ? "border-teal-600/30 bg-slate-950 text-white"
                  : "border-slate-200 bg-white text-slate-700"
              }`}
            >
              {isActive && (
                <span className="relative flex h-1.5 w-1.5">
                  <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-300/80" />
                  <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-teal-300" />
                </span>
              )}
              {step}
            </motion.span>
          );
        })}
      </div>
    </motion.div>
  );
}

function MiniStatusBar({
  visible,
  activeIndex,
}: {
  visible: boolean;
  activeIndex: number;
}) {
  return (
    <div
      className={`pointer-events-none fixed bottom-5 left-1/2 z-40 hidden -translate-x-1/2 transition duration-300 lg:block ${
        visible ? "translate-y-0 opacity-100" : "translate-y-4 opacity-0"
      }`}
    >
      <div className="flex items-center gap-2 rounded-full border border-slate-900/10 bg-white/82 p-2 shadow-[0_18px_48px_rgba(31,57,86,0.14)] backdrop-blur-xl">
        {miniStatusItems.map(({ icon: Icon, label }, index) => {
          const isActive = index === activeIndex;
          return (
            <span
              key={label}
              className={`inline-flex items-center gap-2 rounded-full px-4 py-2 text-xs font-black transition-all duration-500 ${
                isActive
                  ? "scale-105 bg-teal-500 text-slate-950 shadow-[0_0_0_4px_rgba(20,184,166,0.18)]"
                  : "bg-slate-950 text-white"
              }`}
            >
              <Icon
                className={`h-3.5 w-3.5 ${isActive ? "text-slate-950" : "text-teal-200"}`}
              />
              {label}
            </span>
          );
        })}
      </div>
    </div>
  );
}
