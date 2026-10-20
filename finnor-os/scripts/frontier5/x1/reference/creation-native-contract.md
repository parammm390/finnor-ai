# Native owner-creation examples frozen before code

CRM JSON records contain `{id:"fund-7",fundNumber:"FUND-7",fundName:"Fund Seven"}`
and `{id:"vehicle-8",vehicleNumber:"VEH-8",vehicleName:"Vehicle Eight",
fundNumber:"FUND-7",vehicleType:"feeder",
effectiveFrom:"2026-09-01T00:00:00.000Z"}`. An independent Core/PE read
may contain existing scoped Fund/Vehicle identities; if not, the candidate
may propose *provisional* identity witnesses, but none is canonical until
the Fund/Vehicle owner creates it. The independently checked relation is
Vehicle `VEH-8` -> Fund `FUND-7`, never a reversed edge. A raw name by itself
is not a durable identity. The relation's validFrom is original effectiveFrom,
never the compiler's knowledge cut. Without this field only an unresolved
relation is permitted. Both rows are one original CRM source, not
pre-mapped `{kind,entityType,registrationId}` controls.

The creditor/source case has a real missing Deal target, lead and signed LOI.
The Deal remains `DEAL_PREREQUISITES_UNESTABLISHED`, even when Fund/Vehicle
creation succeeds. A failure to create the Deal must not roll back the
independent Fund/Vehicle admission. A conflicting existing Fund with the
same name but a different scoped number must not be reused. Native source
bytes and the target canonical reread are independent expectations.
