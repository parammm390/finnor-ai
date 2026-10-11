import type {
  CoalitionProgramme, CoalitionSelection, CoalitionAllocationProblem,
  CoalitionAllocationCertificate, CoalitionProposedSchedule,
} from "@r5-owner-contract"
import type { AllocationReservation, AllocationConsumption } from "@r5-allocation-contract"
import type {
  CoalitionProgrammeView, CoalitionSelectionView, CoalitionAllocationView,
  CoalitionConsumptionView, CoalitionScheduleView,
} from "@/components/centropy/canvas/coalition-programme-view"

declare const programme: CoalitionProgramme
declare const selection: CoalitionSelection
declare const allocation: {
  problem: CoalitionAllocationProblem
  certificate: CoalitionAllocationCertificate
  reservation: AllocationReservation | null
}
declare const consumption: AllocationConsumption
declare const schedule: CoalitionProposedSchedule

export const actualOwnerShapes: [
  CoalitionProgrammeView, CoalitionSelectionView, CoalitionAllocationView,
  CoalitionConsumptionView, CoalitionScheduleView,
] = [programme, selection, allocation, consumption, schedule]
