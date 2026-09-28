# Renderer performance measurements

Before running an isolated renderer benchmark, check these failures:

- A synthetic business value, fake active agent, fake receipt or fixture source is presented as canonical business evidence.
- The harness measures a replacement component instead of the actual production component.
- A large input silently renders thousands of relationship controls, or hides a display bound without explaining it.
- The 20-block document violates the actual Canvas schema or duplicates block identities.
- A large underwriting table computes financial results in the frontend.
- Orb rendering continues on mobile, under reduced motion, or while its host is off screen.
- An isolated esbuild harness is mislabeled as the production Next.js route or its bundle size is mislabeled as production bundle impact.
- Timing starts after the expensive render, excludes long tasks, or claims a universal device performance threshold from one local Chromium run.
- A screenshot or output artifact is missing its inputs, source hashes, runtime, steps, and rerun command.

The isolated harness uses production Canvas, relationship and Orb components. All stress rows are explicitly authored, UNKNOWN, and make no business assertion. Business writes and network reads are unavailable there. The compiled authenticated route measurements and real active trace are recorded separately.
