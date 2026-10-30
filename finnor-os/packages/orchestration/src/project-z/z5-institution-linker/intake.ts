/** Canonical native Company Brain intake dispatch. It neither creates a second
 * Work nor lets a model make up fixed contracts, grants or native live state. */
import type { TenantContext } from "@finnor/shared-types";
import { handleInstitutionLinkOperation } from "../../../../private-equity/src/project-z/z5-institution-linker/api";
import { SubmitSchema } from "../../../../private-equity/src/project-z/z5-institution-linker/contracts";
export const INSTITUTION_LINK_INTAKE_VERSION = "z5-existing-work-fixed-contract-intake-v1";
export async function intakeInstitutionComposition(auth: TenantContext, input: unknown) {
  const parsed = SubmitSchema.safeParse(input);
  if (!parsed.success) return { status: 400, body: { code: "Z5_FIXED_EXISTING_OWNER_REFERENCES_REQUIRED" } };
  return handleInstitutionLinkOperation({ auth }, "institution-link-submit", parsed.data);
}
