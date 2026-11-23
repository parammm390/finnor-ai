import { z } from "zod";
import { SPECIALIST_QUALIFICATION_DOMAIN, specialistMechanismSchema,
  specialistModelIdentitySchema } from "../../governed-execution/src/specialist-contract";
import { SourcePinSchema } from "./contracts";

/** Additive domain grammar only. Importing it does not load a native profile. */
export const specialistPortConfigurationSchema = z.object({
  qualificationDomain: z.literal(SPECIALIST_QUALIFICATION_DOMAIN), productionActive: z.literal(false),
  mechanism: specialistMechanismSchema, modelIdentity: specialistModelIdentitySchema,
  sourcePins: z.array(SourcePinSchema).min(1).max(256),
}).strict();
