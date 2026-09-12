"use client";

import { FormEvent, KeyboardEvent, useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowRight,
  Bot,
  CalendarDays,
  CheckCircle2,
  MessageCircle,
  Send,
  Sparkles,
  X,
} from "lucide-react";
import { siteConfig } from "@/config/site";
import { cn } from "@/lib/utils";

type ChatRole = "assistant" | "user";
type ConciergePlan = "Certified PE chain" | "Firm deployment" | "Multi-fund deployment" | "Not enough detail";

type CollectedFields = {
  name: string;
  company: string;
  website: string;
  role: string;
  email: string;
  pain: string;
  operatingScope: string;
  currentSetup: string;
  desiredSystem: string;
  suggestedPlan: ConciergePlan;
};

type FieldKey = keyof CollectedFields;

type LeadSummary = {
  company: string;
  website: string;
  role: string;
  mainPain: string;
  suggestedPlan: ConciergePlan;
  nextStep: "Book an operating review";
};

type ConciergeApiReply = {
  reply?: string;
  suggestedPlan?: ConciergePlan;
  leadSummary?: LeadSummary;
  cta?: {
    label: "Book an operating review";
    url: string;
  };
};

type ChatMessage = {
  id: string;
  role: ChatRole;
  content: string;
  leadSummary?: LeadSummary;
  cta?: ConciergeApiReply["cta"];
};

const quickActions = [
  "What does Finnor do?",
  "What gets configured?",
  "Check my fit",
  "Book an operating review",
];

const THINKING_DELAY_MS = 1000;

const initialMessages: ChatMessage[] = [
  {
    id: "assistant-initial",
    role: "assistant",
    content:
      "FINNOR is Private Equity decision + execution infrastructure. It connects canonical deal truth, underwriting lineage, IC governance, Work, evidence, receipts, and governed AI workers; JARVIS is the owner operating surface. I can explain the system or help scope an operating review.",
  },
];

const emptyCollectedFields: CollectedFields = {
  name: "",
  company: "",
  website: "",
  role: "",
  email: "",
  pain: "",
  operatingScope: "",
  currentSetup: "",
  desiredSystem: "",
  suggestedPlan: "Not enough detail",
};

const fitQuestionOrder = [
  "pain",
  "operatingScope",
  "currentSetup",
  "desiredSystem",
] as const;
type FitFieldKey = (typeof fitQuestionOrder)[number];

export function FinnorAIConcierge() {
  const [isOpen, setIsOpen] = useState(false);
  const [messages, setMessages] = useState<ChatMessage[]>(initialMessages);
  const [collectedFields, setCollectedFields] =
    useState<CollectedFields>(emptyCollectedFields);
  const [activeField, setActiveField] = useState<FieldKey | null>(null);
  const [isFitFlow, setIsFitFlow] = useState(false);
  const [input, setInput] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!isOpen) return;

    const frame = requestAnimationFrame(() => {
      scrollRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
    });

    return () => cancelAnimationFrame(frame);
  }, [isOpen, messages, isLoading]);

  async function submitMessage(rawText: string) {
    const text = rawText.trim();
    if (!text || isLoading) return;

    const userMessage: ChatMessage = {
      id: createMessageId("user"),
      role: "user",
      content: text,
    };
    const fieldsAfterUser = collectFieldsFromUserText(
      text,
      collectedFields,
      activeField,
    );
    const nextMessages = [...messages, userMessage];

    setMessages(nextMessages);
    setCollectedFields(fieldsAfterUser);
    setInput("");

    if (isBookIntent(text)) {
      setIsLoading(true);
      await waitForThinkingDelay();
      addAssistantMessage(buildBookReply());
      setActiveField(null);
      setIsFitFlow(false);
      setIsLoading(false);
      return;
    }

    if (isFitFlow) {
      const nextFitQuestion = getNextFitQuestion(fieldsAfterUser);

      if (nextFitQuestion) {
        setIsLoading(true);
        await waitForThinkingDelay();
        setActiveField(nextFitQuestion.field);
        addAssistantMessage({ content: nextFitQuestion.question });
        setIsLoading(false);
        return;
      }

      const finalFields = applySuggestedPlan(fieldsAfterUser);
      setIsLoading(true);
      await waitForThinkingDelay();
      setCollectedFields(finalFields);
      setActiveField(null);
      setIsFitFlow(false);
      addAssistantMessage(buildFitRecommendation(finalFields));
      setIsLoading(false);
      return;
    }

    setIsLoading(true);

    try {
      const response = await fetch("/api/ai-concierge", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          messages: nextMessages
            .slice(-12)
            .map(({ role, content }) => ({ role, content })),
          collectedFields: fieldsAfterUser,
        }),
      });
      const payload = (await response.json()) as ConciergeApiReply & {
        error?: string;
      };

      if (!response.ok) {
        throw new Error(
          payload.error || "The concierge could not respond right now.",
        );
      }

      const fieldsAfterReply = payload.suggestedPlan
        ? { ...fieldsAfterUser, suggestedPlan: payload.suggestedPlan }
        : fieldsAfterUser;
      setCollectedFields(fieldsAfterReply);
      const nextActiveField = inferAskedField(
        payload.reply || "",
        fieldsAfterReply,
      );
      setActiveField(nextActiveField);
      setMessages((current) => [
        ...current,
        {
          id: createMessageId("assistant"),
          role: "assistant",
          content:
            payload.reply ||
            "I can help map where the workflow is leaking. Tell me the most expensive gap you see today.",
          leadSummary: payload.leadSummary,
          cta: payload.cta,
        },
      ]);
    } catch {
      setMessages((current) => [
        ...current,
        {
          id: createMessageId("assistant"),
          role: "assistant",
          content:
            "I'm having trouble reaching the concierge model. You can still book an operating review to map the company deployment and its first certified operating chain.",
          cta: {
            label: "Book an operating review",
            url: siteConfig.calendlyLink,
          },
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  async function handleQuickAction(action: string) {
    if (isLoading) return;

    const userMessage: ChatMessage = {
      id: createMessageId("user"),
      role: "user",
      content: action,
    };

    setMessages((current) => [...current, userMessage]);
    setInput("");
    setIsLoading(true);

    if (action === "What does Finnor do?") {
      await waitForThinkingDelay();
      addAssistantMessage({
        content:
          "FINNOR connects the PE decision record to the execution record without creating a second source of truth. JARVIS is where owners inspect the Company Brain, direct bounded Work, and review evidence, receipts, proof, and governed agents.",
      });
      setActiveField(null);
      setIsFitFlow(false);
      setIsLoading(false);
      return;
    }

    if (action === "What gets configured?") {
      await waitForThinkingDelay();
      addAssistantMessage({
        content:
          "A deployment can configure PE truth and sources, underwriting and IC lineage, integrations, authority, JARVIS workspaces, Work and execution paths, evidence, receipts, proof, recovery, tenant isolation, production activation, and governed agent scope.",
      });
      setActiveField(null);
      setIsFitFlow(false);
      setIsLoading(false);
      return;
    }

    if (action === "Check my fit") {
      const nextQuestion = getNextFitQuestion(collectedFields);
      await waitForThinkingDelay();
      setIsFitFlow(true);
      setActiveField(nextQuestion?.field || null);
      addAssistantMessage({
        content:
          nextQuestion?.question ||
          "I have the basics. The next move is an operating review so we can map the company and define the first certified chain.",
        leadSummary: nextQuestion
          ? undefined
          : buildLeadSummary(applySuggestedPlan(collectedFields)),
        cta: nextQuestion ? undefined : workflowReviewCta(),
      });
      setIsLoading(false);
      return;
    }

    if (action === "Book an operating review") {
      await waitForThinkingDelay();
      addAssistantMessage(buildBookReply());
      setActiveField(null);
      setIsFitFlow(false);
    }
    setIsLoading(false);
  }

  function addAssistantMessage({
    content,
    leadSummary,
    cta,
  }: {
    content: string;
    leadSummary?: LeadSummary;
    cta?: ConciergeApiReply["cta"];
  }) {
    setMessages((current) => [
      ...current,
      {
        id: createMessageId("assistant"),
        role: "assistant",
        content,
        leadSummary,
        cta,
      },
    ]);
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void submitMessage(input);
  }

  function handleKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      void submitMessage(input);
    }
  }

  return (
    <>
      <AnimatePresence>
        {isOpen ? (
          <motion.aside
            key="concierge-panel"
            initial={{ opacity: 0, y: 22, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 18, scale: 0.96 }}
            transition={{ duration: 0.28, ease: [0.16, 1, 0.3, 1] }}
            data-lenis-prevent
            className="fixed inset-x-3 bottom-24 z-[90] flex h-[min(640px,calc(100dvh-7.25rem))] overflow-hidden rounded-[1.5rem] border border-cyan-200/15 bg-[rgba(3,8,18,0.94)] text-white shadow-[0_28px_90px_rgba(0,0,0,0.5),0_0_70px_rgba(56,189,248,0.12)] backdrop-blur-2xl sm:left-auto sm:right-5 sm:w-[430px]"
            role="dialog"
            aria-label="Finnor AI Concierge"
          >
            <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_16%_0%,rgba(34,211,238,0.16),transparent_34%),radial-gradient(circle_at_92%_18%,rgba(37,99,235,0.16),transparent_32%),linear-gradient(180deg,rgba(255,255,255,0.08),rgba(255,255,255,0.02))]" />
            <div className="pointer-events-none absolute inset-x-10 top-0 h-px bg-gradient-to-r from-transparent via-cyan-200/50 to-transparent" />

            <div className="relative flex min-w-0 flex-1 flex-col">
              <header className="border-b border-white/10 px-4 py-4">
                <div className="flex items-start justify-between gap-3">
                  <div className="flex min-w-0 items-center gap-3">
                    <div className="grid h-11 w-11 shrink-0 place-items-center rounded-2xl border border-cyan-200/20 bg-cyan-300/10 shadow-[0_0_24px_rgba(34,211,238,0.16)]">
                      <Bot className="h-5 w-5 text-cyan-100" />
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-2">
                        <h2 className="truncate text-sm font-black tracking-tight text-white">
                          Finnor AI Concierge
                        </h2>
                        <Sparkles className="h-3.5 w-3.5 shrink-0 text-cyan-200" />
                      </div>
                      <div className="mt-1 inline-flex max-w-full items-center gap-2 rounded-full border border-emerald-300/20 bg-emerald-300/10 px-2.5 py-1 text-[11px] font-bold text-emerald-100">
                        <span className="h-1.5 w-1.5 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]" />
                        <span className="truncate">
                          Online · Deployment scope assistant
                        </span>
                      </div>
                    </div>
                  </div>

                  <button
                    type="button"
                    aria-label="Close Finnor AI Concierge"
                    data-cursor="hover"
                    onClick={() => setIsOpen(false)}
                    className="grid h-9 w-9 shrink-0 place-items-center rounded-full border border-white/10 bg-white/5 text-slate-200 transition hover:border-cyan-200/25 hover:bg-white/10 focus:outline-none focus:ring-2 focus:ring-cyan-200/50"
                  >
                    <X className="h-4 w-4" />
                  </button>
                </div>

                <div className="mt-4 flex items-center justify-between gap-3">
                  <Waveform />
                  <span className="text-[10px] font-black uppercase tracking-[0.18em] text-cyan-100/70">
                    Operating deployment fit
                  </span>
                </div>
              </header>

              <div className="border-b border-white/10 px-4 py-3">
                <div className="grid grid-cols-2 gap-2">
                  {quickActions.map((action) => (
                    <button
                      key={action}
                      type="button"
                      data-cursor="hover"
                      disabled={isLoading}
                      onClick={() => void handleQuickAction(action)}
                      className="min-w-0 rounded-full border border-cyan-200/15 bg-white/[0.06] px-3 py-2 text-center text-xs font-bold leading-tight text-cyan-50 transition hover:border-cyan-200/35 hover:bg-cyan-300/10 disabled:cursor-not-allowed disabled:opacity-50"
                    >
                      {action}
                    </button>
                  ))}
                </div>
              </div>

              <div
                className="flex-1 space-y-4 overflow-y-auto px-4 py-4"
                aria-live="polite"
                data-lenis-prevent
              >
                {messages.map((message) => (
                  <ChatBubble key={message.id} message={message} />
                ))}

                {isLoading ? <TypingPulse /> : null}
                <div ref={scrollRef} />
              </div>

              <form
                onSubmit={handleSubmit}
                className="border-t border-white/10 p-3"
              >
                <div className="flex items-end gap-2 rounded-2xl border border-white/10 bg-black/20 p-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.06)]">
                  <textarea
                    value={input}
                    onChange={(event) => setInput(event.target.value)}
                    onKeyDown={handleKeyDown}
                    rows={1}
                    maxLength={700}
                    placeholder="Ask about the product or deployment..."
                    className="max-h-28 min-h-10 flex-1 resize-none bg-transparent px-2 py-2 text-sm font-semibold leading-5 text-white outline-none placeholder:text-slate-400"
                  />
                  <button
                    type="submit"
                    aria-label="Send message"
                    data-cursor="hover"
                    disabled={!input.trim() || isLoading}
                    className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-cyan-200 text-slate-950 shadow-[0_0_26px_rgba(34,211,238,0.3)] transition hover:bg-white disabled:cursor-not-allowed disabled:opacity-45"
                  >
                    <Send className="h-4 w-4" />
                  </button>
                </div>
              </form>
            </div>
          </motion.aside>
        ) : null}
      </AnimatePresence>

      <motion.button
        type="button"
        aria-label={
          isOpen ? "Close Finnor AI Concierge" : "Open Finnor AI Concierge"
        }
        data-cursor="hover"
        onClick={() => setIsOpen((open) => !open)}
        className="fixed bottom-5 right-5 z-[91] grid h-16 w-16 place-items-center overflow-hidden rounded-full border border-cyan-200/25 bg-[#06111f] text-white shadow-[0_18px_48px_rgba(2,8,23,0.38),0_0_42px_rgba(34,211,238,0.2)] transition hover:border-cyan-100/50 focus:outline-none focus:ring-2 focus:ring-cyan-200/60"
        whileHover={{ y: -2 }}
        whileTap={{ scale: 0.96 }}
      >
        <span className="pointer-events-none absolute inset-0 bg-[radial-gradient(circle_at_30%_15%,rgba(34,211,238,0.35),transparent_35%),linear-gradient(135deg,rgba(255,255,255,0.12),transparent)]" />
        <span className="pointer-events-none absolute inset-[-18px] rounded-full border border-cyan-200/10" />
        <AnimatePresence mode="wait" initial={false}>
          <motion.span
            key={isOpen ? "close" : "open"}
            initial={{ opacity: 0, rotate: -14, scale: 0.84 }}
            animate={{ opacity: 1, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, rotate: 14, scale: 0.84 }}
            transition={{ duration: 0.18 }}
            className="relative"
          >
            {isOpen ? (
              <X className="h-6 w-6" />
            ) : (
              <MessageCircle className="h-6 w-6" />
            )}
          </motion.span>
        </AnimatePresence>
        {!isOpen ? (
          <span className="absolute bottom-3 right-3">
            <span className="block h-2.5 w-2.5 rounded-full bg-emerald-300 shadow-[0_0_12px_rgba(110,231,183,0.9)]" />
          </span>
        ) : null}
      </motion.button>
    </>
  );
}

function getNextFitQuestion(fields: CollectedFields) {
  for (const field of fitQuestionOrder) {
    if (fields[field]) continue;

    return {
      field,
      question: fitQuestions[field],
    };
  }

  return null;
}

function waitForThinkingDelay() {
  return new Promise((resolve) =>
    window.setTimeout(resolve, THINKING_DELAY_MS),
  );
}

const fitQuestions: Record<FitFieldKey, string> = {
  pain: "Which PE workflow is hardest to carry from evidence to decision and verified execution: diligence, underwriting, IC governance, closing, or portfolio work?",
  operatingScope: "How many funds, deal teams, or portfolio-operations teams share this process?",
  currentSetup:
    "Which source systems and teams currently own that truth and work?",
  desiredSystem:
    "Should the first scope center on Company Brain inspection, governed Work, or both?",
};

function collectFieldsFromUserText(
  text: string,
  fields: CollectedFields,
  activeField: FieldKey | null,
): CollectedFields {
  const next = { ...fields };
  const cleaned = cleanFieldValue(text);
  const lower = cleaned.toLowerCase();
  const email = cleaned.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i)?.[0];
  const website = cleaned.match(
    /(?:https?:\/\/)?(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s,]*/i,
  )?.[0];

  if (email && !next.email) next.email = email;
  if (website && !next.website && !email)
    next.website = normalizeWebsite(website);

  if (activeField && activeField !== "suggestedPlan" && cleaned) {
    if (activeField === "pain") next.pain = normalizePain(cleaned);
    else if (activeField === "operatingScope")
      next.operatingScope = normalizeOperatingScope(cleaned);
    else if (activeField === "currentSetup")
      next.currentSetup = normalizeCurrentSetup(cleaned);
    else if (activeField === "desiredSystem")
      next.desiredSystem = normalizeDesiredSystem(cleaned);
    else if (activeField === "company") next.company = cleaned;
    else if (activeField === "website")
      next.website = normalizeWebsite(cleaned);
    else if (activeField === "role") next.role = cleaned;
    else if (activeField === "email") next.email = cleaned;
    else if (activeField === "name") next.name = cleaned;
  }

  if (!next.pain) {
    const pain = inferPain(lower);
    if (pain) next.pain = pain;
  }

  if (!next.operatingScope) {
    const operatingScope = inferOperatingScope(lower);
    if (operatingScope) next.operatingScope = operatingScope;
  }

  if (!next.currentSetup) {
    const setup = inferCurrentSetup(lower);
    if (setup) next.currentSetup = setup;
  }

  if (!next.desiredSystem) {
    const desired = inferDesiredSystem(lower);
    if (desired) next.desiredSystem = desired;
  }

  if (!next.role) {
    const role = inferRole(cleaned);
    if (role) next.role = role;
  }

  return applySuggestedPlan(next);
}

function inferAskedField(
  reply: string,
  fields: CollectedFields,
): FieldKey | null {
  const lower = reply.toLowerCase();
  const candidates: Array<[FieldKey, string[]]> = [
    [
      "pain",
      [
        "trying to fix",
        "main leak",
        "biggest leak",
        "first gap",
        "workflow challenge",
      ],
    ],
    [
      "operatingScope",
      ["how many funds", "how many deal teams", "how many investment teams", "portfolio-operations teams"],
    ],
    [
      "currentSetup",
      [
        "source systems",
        "deal system",
        "data room",
        "underwriting model",
        "investment committee",
      ],
    ],
    [
      "desiredSystem",
      [
        "company brain",
        "governed work",
        "decision lineage",
        "execution proof",
      ],
    ],
    ["company", ["company name", "company name", "organization name"]],
    ["website", ["website"]],
    ["role", ["your role", "what is your role"]],
    ["email", ["email"]],
    ["name", ["your name", "who should"]],
  ];

  for (const [field, phrases] of candidates) {
    if (fields[field]) continue;
    if (phrases.some((phrase) => lower.includes(phrase))) return field;
  }

  return null;
}

function applySuggestedPlan(fields: CollectedFields): CollectedFields {
  return {
    ...fields,
    suggestedPlan: recommendPlan(fields),
  };
}

function recommendPlan(fields: CollectedFields): ConciergePlan {
  const signal = [
    fields.pain,
    fields.operatingScope,
    fields.currentSetup,
    fields.desiredSystem,
  ]
    .join(" ")
    .toLowerCase();

  const scopeCount = Number(fields.operatingScope.match(/\d+/)?.[0] || 0);

  if (scopeCount > 1 || /\b(multiple funds|multi-fund|multiple deal teams|portfolio-wide)\b/.test(signal)) return "Multi-fund deployment";
  if (/\b(integration|integrations|deal system|data room|underwriting|workspace|workspaces|agents?|authority|approvals?|multiple workflows|firm-wide)\b/.test(signal)) return "Firm deployment";
  if (fields.pain && fields.currentSetup) return "Certified PE chain";

  return fields.suggestedPlan || "Not enough detail";
}

function buildFitRecommendation(fields: CollectedFields) {
  const plan = fields.suggestedPlan;
  const summary = buildLeadSummary(fields);
  const planLine =
    plan === "Multi-fund deployment"
      ? "This needs a multi-fund deployment review so truth, workflows, teams, and authority remain explicit at each governance boundary."
      : plan === "Firm deployment"
        ? "This needs a firm deployment scope across the PE objects, source systems, decision forums, authority routes, and workspaces involved."
        : plan === "Certified PE chain"
          ? "This is a strong candidate for one certified PE chain from source truth through decision and verified execution."
          : "I need one more operational detail before I would call the plan.";

  return {
    content: `${planLine} The clean next step is an operating review. Production deployments start around $30,000; final pricing follows implementation and ongoing support scope.`,
    leadSummary: summary,
    cta: workflowReviewCta(),
  };
}

function buildBookReply() {
  return {
    content:
      "Best next step is an operating review. Bring the PE workflow that crosses sources, decision makers, and execution teams; we will map the truth and authority boundary and identify the first chain to certify.",
    cta: workflowReviewCta(),
  };
}

function buildLeadSummary(fields: CollectedFields): LeadSummary {
  return {
    company: fields.company,
    website: fields.website,
    role: fields.role,
    mainPain: fields.pain,
    suggestedPlan: fields.suggestedPlan,
    nextStep: "Book an operating review",
  };
}

function workflowReviewCta() {
  return {
    label: "Book an operating review" as const,
    url: siteConfig.calendlyLink,
  };
}

function isBookIntent(text: string) {
  return /\b(book|schedule|calendly|workflow review|pilot)\b/i.test(text);
}

function cleanFieldValue(value: string) {
  return value.replace(/\s+/g, " ").trim().slice(0, 220);
}

function normalizeWebsite(value: string) {
  return value.replace(/[.)]+$/, "").trim();
}

function normalizePain(value: string) {
  return cleanFieldValue(value);
}

function normalizeOperatingScope(value: string) {
  const lower = value.toLowerCase();
  if (/\bone\b/.test(lower)) return "1 team";
  if (/\btwo\b/.test(lower)) return "2 teams";
  if (/\bthree\b/.test(lower)) return "3 teams";
  if (/\bfour\b/.test(lower)) return "4 teams";
  const number = value.match(/\d+/)?.[0];
  return number
    ? `${number} ${number === "1" ? "team" : "teams"}`
    : cleanFieldValue(value);
}

function normalizeCurrentSetup(value: string) {
  return cleanFieldValue(value);
}

function normalizeDesiredSystem(value: string) {
  const lower = value.toLowerCase();
  if (lower.includes("company brain") && lower.includes("work")) return "Company Brain + governed Work";
  if (lower.includes("company brain")) return "Company Brain inspection";
  if (lower.includes("work") || lower.includes("execution")) return "Governed Work and execution proof";
  return cleanFieldValue(value);
}

function inferPain(lower: string) {
  const pains = [
    ["diligence", "diligence evidence and work"],
    ["underwriting", "underwriting lineage"],
    ["investment committee", "IC governance"],
    [" ic ", "IC governance"],
    ["closing", "closing readiness"],
    ["dependency", "critical dependencies"],
    ["portfolio", "portfolio execution"],
    ["evidence", "evidence lineage"],
    ["reporting", "portfolio reporting"],
  ];

  return pains.find(([needle]) => lower.includes(needle))?.[1] || "";
}

function inferOperatingScope(lower: string) {
  if (/\bone (?:fund|deal team|investment team|operating team)\b/.test(lower)) return "1 team";
  const match = lower.match(/\b(\d+)\s*(funds?|deal teams?|investment teams?|operating teams?|portfolio companies)\b/);
  if (!match) return "";
  return `${match[1]} ${match[1] === "1" ? "team" : "teams"}`;
}

function inferCurrentSetup(lower: string) {
  if (lower.includes("data room")) return "Virtual data room";
  if (lower.includes("dealcloud")) return "DealCloud";
  if (lower.includes("affinity")) return "Affinity";
  if (lower.includes("sharepoint")) return "SharePoint";
  if (lower.includes("excel") || lower.includes("spreadsheet")) return "Spreadsheet-led process";
  if (lower.includes("email")) return "Email-led process";
  return "";
}

function inferDesiredSystem(lower: string) {
  if (lower.includes("company brain") && lower.includes("work")) return "Company Brain + governed Work";
  if (lower.includes("company brain")) return "Company Brain inspection";
  if (lower.includes("work") || lower.includes("execution")) return "Governed Work and execution proof";
  return "";
}

function inferRole(value: string) {
  const lower = value.toLowerCase();
  const roles = [
    "managing partner",
    "operating partner",
    "investment partner",
    "partner",
    "principal",
    "vice president",
    "associate",
    "investment professional",
    "portfolio operations",
    "chief investment officer",
  ];

  return roles.find((role) => lower.includes(role)) || "";
}

function ChatBubble({ message }: { message: ChatMessage }) {
  const isAssistant = message.role === "assistant";

  return (
    <motion.div
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.22 }}
      className={cn(
        "flex gap-2",
        isAssistant ? "justify-start" : "justify-end",
      )}
    >
      {isAssistant ? (
        <div className="mt-1 grid h-7 w-7 shrink-0 place-items-center rounded-full border border-cyan-200/15 bg-cyan-200/10">
          <Bot className="h-3.5 w-3.5 text-cyan-100" />
        </div>
      ) : null}

      <div
        className={cn("max-w-[85%]", !isAssistant && "flex flex-col items-end")}
      >
        <div
          className={cn(
            "rounded-2xl px-4 py-3 text-sm font-semibold leading-relaxed",
            isAssistant
              ? "rounded-tl-md border border-white/10 bg-white/[0.07] text-slate-100"
              : "rounded-tr-md bg-cyan-200 text-slate-950 shadow-[0_10px_30px_rgba(34,211,238,0.16)]",
          )}
        >
          {message.content}
        </div>

        {message.leadSummary ? (
          <LeadSummaryCard summary={message.leadSummary} cta={message.cta} />
        ) : message.cta ? (
          <ConciergeCta cta={message.cta} className="mt-3" />
        ) : null}
      </div>
    </motion.div>
  );
}

function LeadSummaryCard({
  summary,
  cta,
}: {
  summary: LeadSummary;
  cta?: ConciergeApiReply["cta"];
}) {
  const rows = [
    ["Company", summary.company],
    ["Role", summary.role],
    ["Main pain", summary.mainPain],
    ["Suggested plan", summary.suggestedPlan],
    ["Next step", summary.nextStep],
  ];

  return (
    <div className="mt-3 overflow-hidden rounded-2xl border border-cyan-200/15 bg-slate-950/70 shadow-[0_18px_44px_rgba(0,0,0,0.25)]">
      <div className="border-b border-white/10 bg-cyan-300/10 px-4 py-3">
        <div className="flex items-center gap-2 text-sm font-black text-white">
          <CheckCircle2 className="h-4 w-4 text-emerald-300" />
          Lead Summary
        </div>
      </div>

      <dl className="space-y-2 px-4 py-3">
        {rows.map(([label, value]) => (
          <div
            key={label}
            className="grid grid-cols-[6.5rem_1fr] gap-3 text-xs leading-relaxed"
          >
            <dt className="font-black uppercase tracking-[0.12em] text-slate-400">
              {label}
            </dt>
            <dd className="font-bold text-slate-100">
              {value || "Not captured"}
            </dd>
          </div>
        ))}
      </dl>

      <div className="border-t border-white/10 p-3">
        <ConciergeCta
          cta={
            cta || {
              label: "Book an operating review",
              url: siteConfig.calendlyLink,
            }
          }
        />
      </div>
    </div>
  );
}

function ConciergeCta({
  cta,
  className,
}: {
  cta: NonNullable<ConciergeApiReply["cta"]>;
  className?: string;
}) {
  return (
    <a
      href={cta.url}
      target="_blank"
      rel="noopener noreferrer"
      data-cursor="hover"
      className={cn(
        "inline-flex w-full items-center justify-center gap-2 rounded-full bg-emerald-300 px-4 py-2.5 text-xs font-black text-slate-950 transition hover:bg-emerald-200",
        className,
      )}
    >
      <CalendarDays className="h-4 w-4" />
      {cta.label}
      <ArrowRight className="h-4 w-4" />
    </a>
  );
}

function TypingPulse() {
  return (
    <div className="flex items-center gap-2">
      <div className="grid h-7 w-7 place-items-center rounded-full border border-cyan-200/15 bg-cyan-200/10">
        <Bot className="h-3.5 w-3.5 text-cyan-100" />
      </div>
      <div className="inline-flex items-center gap-1.5 rounded-2xl rounded-tl-md border border-white/10 bg-white/[0.07] px-4 py-3">
        {[0, 1, 2].map((item) => (
          <motion.span
            key={item}
            className="h-2 w-2 rounded-full bg-cyan-100"
            animate={{ opacity: [0.28, 1, 0.28], y: [0, -3, 0] }}
            transition={{ duration: 0.9, repeat: Infinity, delay: item * 0.12 }}
          />
        ))}
      </div>
    </div>
  );
}

function Waveform() {
  return (
    <div className="flex h-7 items-center gap-1.5" aria-hidden="true">
      {[10, 18, 13, 22, 14, 19, 11].map((height, index) => (
        <motion.span
          key={`${height}-${index}`}
          className="w-1 rounded-full bg-cyan-200/80 shadow-[0_0_10px_rgba(34,211,238,0.35)]"
          style={{ height, transformOrigin: "company" }}
          animate={{ scaleY: [0.35, 1, 0.48] }}
          transition={{
            duration: 1.05,
            repeat: Infinity,
            ease: "easeInOut",
            delay: index * 0.08,
          }}
        />
      ))}
    </div>
  );
}

function createMessageId(prefix: string) {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}
