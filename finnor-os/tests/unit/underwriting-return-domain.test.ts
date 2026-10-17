import { describe, expect, it } from "vitest";
import {
  UnderwritingError,
  decimal,
  solvePeriodicIrr,
  solveXirr,
  withinTolerance,
  type SponsorCashFlow,
} from "@finnor/underwriting";

// Failure modes fixed before changing the solver:
// - two nearby roots occur inside one scan interval, leaving one apparent root;
// - an even-multiplicity root never changes sign and is missed by the scan;
// - no discovered root is incorrectly treated as proof that no root exists;
// - a nonconventional stream is claimed to have multiple roots without proof;
// - conventional, uniquely solvable streams are accidentally rejected or mutated;
// - periodic and ACT/365F callers disagree about the same equally spaced flows.
const dates = ["2027-01-01", "2028-01-01", "2028-12-31", "2029-12-31"];
const flows = (amounts: string[]): readonly SponsorCashFlow[] => Object.freeze(
  amounts.map((amount, index) => Object.freeze({
    amount: decimal(amount), date: dates[index]!,
    type: index === 0 ? "initial_investment" as const
      : amount.startsWith("-") ? "subsequent_contribution" as const : "interim_distribution" as const,
  })),
);

function expectUncertified(action: () => unknown): void {
  let thrown: unknown;
  try { action(); } catch (error) { thrown = error; }
  expect(thrown).toBeInstanceOf(UnderwritingError);
  const error = thrown as UnderwritingError;
  expect(error.code).toBe("IRR_AMBIGUOUS");
  expect(error.details.uniquenessEstablished).toBe(false);
}

for (const [name, solve] of [["periodic", solvePeriodicIrr], ["dated ACT/365F", solveXirr]] as const) {
  describe(`${name} IRR supported domain`, () => {
    it("refuses one apparent root when exact roots are 10%, 11%, and 20%", () => {
      // NPV numerator = -100(x-1.10)(x-1.11)(x-1.20), x=1+r.
      expectUncertified(() => solve(flows(["-100", "341", "-387.3", "146.52"])));
    });

    it("refuses one apparent root when another root has even multiplicity", () => {
      // NPV numerator = -100(x-1.10)^2(x-1.20).
      expectUncertified(() => solve(flows(["-100", "340", "-385", "145.2"])));
    });

    it("does not infer absence from a scan that misses both nearby roots", () => {
      // NPV numerator = -100(x-1.10)(x-1.11).
      expectUncertified(() => solve(flows(["-100", "221", "-122.1"])));
    });

    it("keeps unproved uniqueness distinct from proven multiple roots", () => {
      // -100x^3+50x^2-50x+200 has strictly negative derivative for x>0.
      // It has a unique positive root, but the bounded scan cannot certify that.
      expectUncertified(() => solve(flows(["-100", "50", "-50", "200"])));
    });

    it("preserves the conventional 20% return and immutable input", () => {
      const input = flows(["-100", "0", "0", "172.8"]);
      const before = JSON.stringify(input);
      expect(withinTolerance(solve(input), decimal("0.2"), decimal("0.000000000000000001"))).toBe(true);
      expect(JSON.stringify(input)).toBe(before);
    });

    it("still rejects streams without both positive and negative cash flows", () => {
      expect(() => solve(flows(["0", "10", "20"]))).toThrowError(
        expect.objectContaining({ code: "IRR_UNDEFINED" }),
      );
    });
  });
}
