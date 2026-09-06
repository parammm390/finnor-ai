// Converted from .eslintrc.json to .cjs so the Phase 7 override below can carry a
// real comment explaining itself (JSON has no comment syntax).
module.exports = {
  root: true,
  extends: ["next/core-web-vitals"],
  overrides: [
    {
      // Phase 7 §7.8 (JARVIS 95% MAESTRO PACK) — truthfulness enforcement in CI: the
      // authenticated JARVIS views may never fake a metric or activity effect.
      // Math.random() specifically is precise and zero-false-positive to lint; a
      // generic "hardcoded metric literal" rule would false-positive on legitimate
      // constants (thresholds, array indices, etc.) and stays a manual-review
      // convention instead of an automated one.
      files: ["src/components/jarvis/**/*.{ts,tsx}", "src/app/jarvis/**/*.{ts,tsx}"],
      rules: {
        "no-restricted-properties": [
          "error",
          {
            object: "Math",
            property: "random",
            message:
              "No Math.random() in the JARVIS cockpit (Phase 7 §7.8: nothing here may fake a metric or activity effect). If you need a real demo/sample value, it must be clearly labeled as sample data, not presented as live.",
          },
        ],
      },
    },

    // ---------------------------------------------------------------------
    // Plan v3 P1.T4 — the two truth rules, enforced in CI.
    //
    // Both are RATCHETS, not big-bang bans. The rule is `error` for every file
    // in the JARVIS tree; the files that already violate it are enumerated in
    // `excludedFiles` below. That means:
    //   - any NEW violation fails lint immediately,
    //   - the debt is a finite, visible, shrinking list rather than a warning
    //     nobody reads,
    //   - `npm run lint` is green at the end of every task, which the P1 exit
    //     gate requires.
    // A file leaves the list when it is migrated (P1.T7, P1.T8) or deleted
    // (P6.T8). The list must only ever get shorter.
    // ---------------------------------------------------------------------

    // Rule 1 — `?? 0` on network data (plan §0.6 hard rule 4).
    // A `?? 0` turns "we do not know" into a confident zero. That is defect
    // C-01: production rendering `$0` with a sparkline off a 401. Numbers must
    // arrive as `Truth<T>` (kernel/types.ts) and render per §5.5.
    {
      files: ["src/components/jarvis/**/*.{ts,tsx}"],
      excludedFiles: [
        // Debt as of P1.T4. Do not add to this list.
        "src/components/jarvis/views.tsx",
        "src/components/jarvis/JarvisCommandCenter.tsx",
        "src/components/jarvis/panels/WorkflowTheater.tsx",
        "src/components/jarvis/panels/AnalyticsRow.tsx",
        "src/components/jarvis/panels/DispatchMap.tsx",
        "src/components/jarvis/panels/CertificationStatus.tsx",
        "src/components/jarvis/bridge/Bridge.tsx",
        "src/components/jarvis/bridge/PulseBar.tsx",
        "src/components/jarvis/bridge/Orb3D.tsx",
        "src/components/jarvis/lib/data-core.ts",
        "src/components/jarvis/lib/frecency.ts",
        "src/components/jarvis/ui/renderers/flagships/BulkNotifyScene.tsx",
        "src/components/jarvis/ui/renderers/flagships/SchedulingScene.tsx",
        "src/components/jarvis/ui/renderers/flagships/QuotationScene.tsx",
      ],
      rules: {
        "no-restricted-syntax": [
          "error",
          {
            selector: 'LogicalExpression[operator="??"] > Literal[value=0].right',
            message:
              "No `?? 0` in the JARVIS cockpit (plan v3 §0.6 rule 4). `?? 0` renders 'we do not know' as a confident zero — that is defect C-01. Take the value as Truth<T> (kernel/types.ts) and render it per §5.5: unknown -> SkeletonStat, denied -> PermissionVeil, unavailable -> ErrorState. A number renders only for known/stale/partial.",
          },
        ],
      },
    },

    // Rule 2 — `useJarvis()` outside the kernel (plan §4.7: one fact, one selector).
    // `useJarvis()` returns raw lane state. Reading it directly in a component is
    // how one fact acquires several contradictory renderings. Components read
    // `kernel/selectors.ts`, which returns `Truth<T>`; only the kernel and the
    // lane runner it wraps may touch `useJarvis()` itself.
    {
      files: ["src/components/jarvis/**/*.{ts,tsx}", "src/app/jarvis/**/*.{ts,tsx}"],
      excludedFiles: [
        // The kernel and the lane runner it wraps — permanently allowed (§4.1).
        "src/components/jarvis/kernel/**/*.{ts,tsx}",
        "src/components/jarvis/lib/data-core.ts",
        // Debt as of P1.T4. Do not add to this list.
        "src/components/jarvis/views.tsx",
        "src/components/jarvis/JarvisCommandCenter.tsx",
        "src/components/jarvis/SinceYouWereAway.tsx",
        "src/components/jarvis/panels/ActivityRail.tsx",
        "src/components/jarvis/panels/AnalyticsRow.tsx",
        "src/components/jarvis/panels/ApprovalDock.tsx",
        "src/components/jarvis/panels/CommandBar.tsx",
        "src/components/jarvis/panels/CommsFeed.tsx",
        "src/components/jarvis/panels/DegradedBanner.tsx",
        "src/components/jarvis/panels/DispatcherBoard.tsx",
        "src/components/jarvis/panels/LiveCallPanel.tsx",
        "src/components/jarvis/panels/OpsTicker.tsx",
        "src/components/jarvis/panels/PipelinePulse.tsx",
        "src/components/jarvis/panels/WorkflowTheater.tsx",
        "src/components/jarvis/bridge/ApprovalCockpit.tsx",
        "src/components/jarvis/bridge/Bridge.tsx",
        "src/components/jarvis/lib/CommandPaletteV2.tsx",
        "src/components/jarvis/ui/motion/flow-index.ts",
      ],
      rules: {
        "no-restricted-imports": [
          "error",
          {
            patterns: [
              {
                group: ["**/data-core", "**/lib/data-core"],
                importNames: ["useJarvis"],
                message:
                  "Do not import useJarvis() outside kernel/ and lib/data-core.ts (plan v3 §4.7: one fact, one selector). useJarvis() is raw lane state; reading it in a component is how one fact acquires several contradictory renderings. Import the selector you need from components/jarvis/kernel/selectors.ts — it returns Truth<T>.",
              },
            ],
          },
        ],
      },
    },
  ],
}
