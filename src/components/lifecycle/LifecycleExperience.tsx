"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, useReducedMotion } from "framer-motion";
import {
  ArrowRight,
  ChevronLeft,
  ChevronRight,
  Gauge,
  Pause,
  Play,
  RotateCcw,
  Settings2,
  Waves,
  Wrench,
} from "lucide-react";
import {
  recordAtStage,
  type LifecycleScenario,
} from "@/lib/lifecycle/scenario";
import { isPricingTier } from "@/lib/lifecycle/pricing";
import {
  clearLifecycleHandoff,
  readLifecycleHandoff,
} from "@/lib/memory/handoff";
import { RecordPanel } from "@/components/lifecycle/RecordPanel";
import { TimelineScrubber } from "@/components/lifecycle/TimelineScrubber";
import { StageScene } from "@/components/lifecycle/scenes";
import {
  LifecycleSetup,
  type LifecyclePrefill,
} from "@/components/lifecycle/LifecycleSetup";
import { CalendlyCta } from "@/components/demo/CalendlyCta";

const EASE = [0.16, 1, 0.3, 1];
const MONO = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";

type View = "entry" | "setup" | "playing";

export function LifecycleExperience({ sample }: { sample: LifecycleScenario }) {
  const reduceMotion = useReducedMotion();
  const [view, setView] = useState<View>("entry");
  const [scenario, setScenario] = useState<LifecycleScenario>(sample);
  const [chosenSlot, setChosenSlot] = useState<string | undefined>(undefined);
  const [index, setIndex] = useState(0);
  const [direction, setDirection] = useState(1);
  const [playing, setPlaying] = useState(false);
  const [prefill, setPrefill] = useState<LifecyclePrefill | undefined>(
    undefined,
  );
  const indexRef = useRef(index);
  indexRef.current = index;

  // Continuation from the live quoting call: the household record the visitor
  // just created carries straight into the two-year view.
  useEffect(() => {
    const handoff = readLifecycleHandoff();
    if (!handoff) return;
    clearLifecycleHandoff();
    setPrefill({
      zip: handoff.zip,
      shopName: handoff.dealerName,
      tier: isPricingTier(handoff.tier) ? handoff.tier : undefined,
      services: handoff.services,
      onWell: handoff.onWell,
      banner: handoff.customerName
        ? `Continuing the work root from your instruction demo. ${handoff.customerName}${
            handoff.concern ? `, ${handoff.concern.toLowerCase()}` : ""
          }. Same context, next chapters.`
        : "Continuing the work root from your instruction demo. Same context, next chapters.",
    });
    setView("setup");
  }, []);

  const stage = scenario.stages[index];
  const stageCount = scenario.stages.length;
  const record = recordAtStage(scenario, index, chosenSlot);
  const atEnd = index === stageCount - 1;

  const goTo = useCallback(
    (next: number, fromAutoplay = false) => {
      const clamped = Math.max(0, Math.min(stageCount - 1, next));
      const current = indexRef.current;
      if (clamped === current) {
        if (!fromAutoplay) setPlaying(false);
        return;
      }
      setDirection(clamped > current ? 1 : -1);
      setIndex(clamped);
      if (!fromAutoplay) setPlaying(false);
    },
    [stageCount],
  );

  useEffect(() => {
    if (!playing || view !== "playing") return;
    if (index >= stageCount - 1) {
      setPlaying(false);
      return;
    }
    const timer = window.setTimeout(
      () => goTo(index + 1, true),
      reduceMotion ? 5000 : stage.autoMs,
    );
    return () => window.clearTimeout(timer);
  }, [playing, view, index, stage.autoMs, stageCount, goTo, reduceMotion]);

  useEffect(() => {
    if (view !== "playing") return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) return;
      if (event.key === "ArrowRight") goTo(indexRef.current + 1);
      else if (event.key === "ArrowLeft") goTo(indexRef.current - 1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [goTo, view]);

  const startScenario = useCallback(
    (next: LifecycleScenario, autoplay: boolean) => {
      setScenario(next);
      setChosenSlot(undefined);
      setDirection(1);
      setIndex(0);
      setView("playing");
      setPlaying(autoplay);
      window.setTimeout(() => {
        document
          .getElementById("lifecycle-timeline")
          ?.scrollIntoView({ behavior: "smooth", block: "start" });
      }, 350);
    },
    [],
  );

  const handlePlayToggle = () => {
    if (playing) {
      setPlaying(false);
      return;
    }
    if (atEnd) {
      setDirection(-1);
      setIndex(0);
    }
    setPlaying(true);
  };

  return (
    <div className="relative min-h-screen w-full overflow-hidden bg-[#f1efe7] selection:bg-teal-200/35">
      <div className="absolute inset-0 z-0">
        <div className="absolute inset-0 operational-grid opacity-25" />
      </div>

      <div className="container relative z-10 px-4 pb-20 pt-40 md:px-6 md:pt-44">
        <div
          className={`grid grid-cols-1 items-start gap-10 ${
            view === "playing" ? "" : "lg:grid-cols-[1.02fr_0.98fr] lg:gap-14"
          }`}
        >
          <div className="max-w-3xl">
            <motion.div
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              className="mb-7 inline-flex items-center text-xs font-black uppercase tracking-[0.16em] text-sky-900"
            >
              <span className="relative mr-3 flex h-2 w-2">
                <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-teal-500 opacity-35" />
                <span className="relative inline-flex h-2 w-2 rounded-full bg-teal-500" />
              </span>
              One simulated work root · chaptered walkthrough
            </motion.div>

            <motion.h1
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.8, ease: EASE }}
              className="text-[2.35rem] font-black leading-[1.02] tracking-tight text-slate-950 sm:text-[2.75rem] md:text-6xl lg:text-7xl"
            >
              <span className="block">Watch one household become</span>
              <span className="block">an operating history.</span>
            </motion.h1>

            <motion.p
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.12, duration: 0.7 }}
              className="mt-6 max-w-3xl text-lg font-medium leading-relaxed text-slate-600 md:text-xl"
            >
              This chapter isolates FINNOR&apos;s long-running context: one exact
              household work root, projected across acquisition, installation,
              service and follow-up. It is a simulation of one capability—not
              the definition of the full product.
            </motion.p>

            <motion.p
              initial={false}
              animate={{ opacity: 1 }}
              transition={{ delay: 0.2 }}
              className="mt-4 text-xs font-semibold leading-relaxed text-slate-500"
            >
              {scenario.live && view === "playing"
                ? `Computed for ${scenario.dealer.name}, ${scenario.dealer.location}, ${scenario.dealer.tierLabel} pricing. The water data, sizing, and range are live from public records. The household is a composite; the timeline is simulated, and the workflow is exactly what JARVIS runs.`
                : "One composite household on real county water medians. The timeline is simulated, and the workflow is exactly what JARVIS runs."}
            </motion.p>

            {view === "entry" ? (
              <motion.div
                initial={false}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.26 }}
                className="mt-8 rounded-[1.5rem] border border-slate-200 bg-white/70 p-5"
              >
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-teal-700">
                  The 15-second version
                </p>
                <p className="mt-2.5 text-sm font-semibold leading-relaxed text-slate-700">
                  The walkthrough assembles public water context, proposes the
                  next action, holds customer commitments for approval, and
                  keeps later installation, service and follow-up events linked
                  to the same household. Every chapter is simulated and clearly
                  identified; the timeline is a context demonstration, not a
                  customer outcome claim.
                </p>
              </motion.div>
            ) : null}
          </div>

          {view === "entry" ? (
            <motion.div
              initial={false}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: 0.2, duration: 0.75, ease: EASE }}
            >
              <EntryDoors
                onBuild={() => setView("setup")}
                onSample={() => startScenario(sample, true)}
              />
            </motion.div>
          ) : null}

          {view === "setup" ? (
            <motion.div
              initial={{ opacity: 0, y: 18 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.6, ease: EASE }}
            >
              <LifecycleSetup
                prefill={prefill}
                onReady={(generated) => startScenario(generated, false)}
                onRunSample={() => startScenario(sample, true)}
              />
            </motion.div>
          ) : null}
        </div>

        {view === "playing" ? (
          <div id="lifecycle-timeline" className="mt-12 scroll-mt-8">
            <div className="mb-6 flex flex-wrap items-center justify-between gap-4">
              <div className="flex flex-wrap items-center gap-3">
                <p
                  className="text-xs font-black uppercase tracking-widest text-slate-500"
                  style={{ fontFamily: MONO }}
                >
                  {String(index + 1).padStart(2, "0")} /{" "}
                  {String(stageCount).padStart(2, "0")} · {stage.timeLabel}
                </p>
                <span className="inline-flex items-center gap-2 rounded-full border border-slate-200 bg-white/80 px-3.5 py-1.5 text-[10px] font-black uppercase tracking-widest text-slate-600">
                  <Wrench className="h-3 w-3 text-teal-700" />
                  {scenario.dealer.name} · {scenario.dealer.tierLabel}
                </span>
              </div>
              <div className="flex items-center gap-2.5">
                <button
                  type="button"
                  onClick={() => {
                    setPlaying(false);
                    setView("setup");
                  }}
                  data-cursor="hover"
                  className="inline-flex h-11 items-center gap-2 rounded-full border border-slate-200 bg-white px-4 text-[10px] font-black uppercase tracking-widest text-slate-600 shadow-sm transition hover:border-sky-200 hover:text-slate-950"
                >
                  <Settings2 className="h-3.5 w-3.5" />
                  Rebuild
                </button>
                <button
                  type="button"
                  onClick={() => goTo(index - 1)}
                  disabled={index === 0}
                  aria-label="Previous stage"
                  data-cursor="hover"
                  className="grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-sky-200 hover:text-slate-950 disabled:opacity-35 disabled:hover:border-slate-200"
                >
                  <ChevronLeft className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onClick={handlePlayToggle}
                  data-cursor="hover"
                  className="cta-primary inline-flex h-11 items-center gap-2 rounded-full bg-slate-950 px-5 text-xs font-black uppercase tracking-widest text-white transition hover:bg-slate-800"
                >
                  {playing ? (
                    <>
                      <Pause className="h-3.5 w-3.5" />
                      Pause
                    </>
                  ) : atEnd ? (
                    <>
                      <RotateCcw className="h-3.5 w-3.5" />
                      Replay
                    </>
                  ) : (
                    <>
                      <Play className="h-3.5 w-3.5" />
                      Play the two years
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => goTo(index + 1)}
                  disabled={atEnd}
                  aria-label="Next stage"
                  data-cursor="hover"
                  className="grid h-11 w-11 place-items-center rounded-full border border-slate-200 bg-white text-slate-700 shadow-sm transition hover:border-sky-200 hover:text-slate-950 disabled:opacity-35 disabled:hover:border-slate-200"
                >
                  <ChevronRight className="h-4 w-4" />
                </button>
              </div>
            </div>

            <TimelineScrubber
              stages={scenario.stages}
              index={index}
              onSelect={goTo}
            />

            <div className="mt-10 grid grid-cols-1 items-start gap-6 lg:grid-cols-[1.08fr_0.92fr] lg:gap-8">
              <div className="min-w-0">
                <AnimatePresence mode="wait" custom={direction} initial={false}>
                  <motion.div
                    key={`${scenario.dealer.name}-${stage.id}`}
                    custom={direction}
                    variants={{
                      enter: (dir: number) => ({
                        opacity: 0,
                        x: reduceMotion ? 0 : dir >= 0 ? 44 : -44,
                      }),
                      center: { opacity: 1, x: 0 },
                      exit: (dir: number) => ({
                        opacity: 0,
                        x: reduceMotion ? 0 : dir >= 0 ? -44 : 44,
                      }),
                    }}
                    initial="enter"
                    animate="center"
                    exit="exit"
                    transition={{ duration: 0.55, ease: EASE }}
                  >
                    <div className="mb-6">
                      <p
                        className="text-[11px] font-black uppercase tracking-[0.24em] text-sky-800"
                        style={{ fontFamily: MONO }}
                      >
                        {stage.timeLabel}
                      </p>
                      <h2 className="mt-2.5 text-2xl font-black tracking-tight text-slate-950 md:text-4xl">
                        {stage.title}
                      </h2>
                      <p className="mt-3 max-w-2xl text-base font-medium leading-relaxed text-slate-600">
                        {stage.narration}
                      </p>
                    </div>
                    <StageScene
                      scene={stage.scene}
                      customerName={scenario.customer.name}
                      customerPhone={scenario.customer.phone}
                      interaction={{
                        chosenSlot,
                        autoPilot: playing,
                        onChipChosen: setChosenSlot,
                      }}
                    />
                  </motion.div>
                </AnimatePresence>
              </div>

              <div className="lg:sticky lg:top-8">
                <RecordPanel
                  scenario={scenario}
                  record={record}
                  stageIndex={index}
                />
              </div>
            </div>
          </div>
        ) : null}
      </div>

      <section className="relative z-10 border-t border-slate-200 py-16 md:py-20">
        <div className="container px-4 md:px-6">
          <div className="grid grid-cols-1 items-stretch gap-6 lg:grid-cols-[1.08fr_0.92fr]">
            <div className="ops-card rounded-[2rem] p-6 md:p-8">
              <div className="section-kicker">Where this capability matters</div>
              <h3 className="mt-5 text-3xl font-black tracking-tight text-slate-950 md:text-4xl">
                Long-running work needs one accountable history.
              </h3>
              <p className="mt-5 text-base font-semibold leading-relaxed text-slate-700">
                The value is not “remembering a customer.” It is keeping every
                later decision tied to the right household, system, work,
                policy and evidence.
              </p>
              <p className="mt-4 text-base font-medium leading-relaxed text-slate-600">
                Use this chapter to evaluate continuity. Use the main FINNOR
                story to evaluate planning, authority, execution, recovery and
                evidence across the rest of the operation.
              </p>
            </div>
            <div className="flex flex-col justify-between gap-5">
              <CalendlyCta />
              <div className="rounded-[1.35rem] border border-slate-200 bg-white/70 p-5">
                <p className="text-[10px] font-black uppercase tracking-widest text-slate-500">
                  Want to see instruction ingress?
                </p>
                <a
                  href="/demo"
                  className="mt-2 inline-flex items-center gap-2 text-sm font-black text-slate-950 transition hover:text-sky-800"
                  data-cursor="hover"
                >
                  Open the public instruction demo
                  <ArrowRight className="h-4 w-4" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}

function EntryDoors({
  onBuild,
  onSample,
}: {
  onBuild: () => void;
  onSample: () => void;
}) {
  return (
    <div className="ops-card soft-edge rounded-[1.8rem] p-6 md:p-7">
      <p className="text-[10px] font-black uppercase tracking-[0.24em] text-sky-800">
        Two ways in
      </p>

      <button
        type="button"
        onClick={onBuild}
        data-cursor="hover"
        className="cta-primary mt-5 flex w-full flex-col rounded-2xl bg-slate-950 p-5 text-left transition hover:-translate-y-0.5 hover:bg-slate-800"
      >
        <span className="flex items-center justify-between text-base font-black text-white">
          Build it around your shop
          <ArrowRight className="h-4 w-4 text-teal-200" />
        </span>
        <span className="mt-1.5 text-xs font-semibold leading-relaxed text-white/70">
          Live water data for your ZIP, sizing math, and a real range at your
          pricing tier in 60 seconds of setup.
        </span>
      </button>

      <button
        type="button"
        onClick={onSample}
        data-cursor="hover"
        className="mt-3 flex w-full flex-col rounded-2xl border border-slate-200 bg-white p-5 text-left transition hover:-translate-y-0.5 hover:border-sky-200"
      >
        <span className="flex items-center justify-between text-base font-black text-slate-950">
          Watch the sample household
          <Play className="h-4 w-4 text-teal-700" />
        </span>
        <span className="mt-1.5 text-xs font-semibold leading-relaxed text-slate-600">
          Zero setup. It presses play on a Shenandoah Valley household and
          drives itself.
        </span>
      </button>

      <div className="mt-5 space-y-2.5 border-t border-slate-200 pt-5">
        {[
          {
            icon: Waves,
            label: "Water data pulled live from EPA / USGS public records",
          },
          { icon: Gauge, label: "Sizing math shown line by line, not implied" },
          {
            icon: Wrench,
            label: "Simulated timeline, real workflow, your prices",
          },
        ].map(({ icon: Icon, label }) => (
          <div key={label} className="flex items-center gap-2.5">
            <Icon className="h-4 w-4 shrink-0 text-teal-700" />
            <p className="text-xs font-bold text-slate-600">{label}</p>
          </div>
        ))}
      </div>
    </div>
  );
}
