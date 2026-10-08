import { z } from "zod"

export const CapitalRefViewSchema = z.object({
  owner: z.string(), id: z.string(), version: z.string(),
  contentDigest: z.string().regex(/^[a-f0-9]{64}$/),
})
