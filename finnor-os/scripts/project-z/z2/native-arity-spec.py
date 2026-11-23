"""Exact native-owner arity edits, emitted only as coordinator-owned patches."""
OWNER = "finnor-os/packages/private-equity/src/interaction-synthesis/"


def specifications():
    return [
        {
            "path": OWNER+"contracts.ts",
            "symbols": ["Party", "ProblemSchema", "NodeSchema"],
            "callers": ["Native API, process, store, S4 terms and participant-local execution"],
            "failureWithout": "Native transport rejects three/four parties or silently truncates economic vectors.",
            "edits": [
                ('const party = z.enum(["P0", "P1"]);',
                 'export const PartySchema = z.enum(["P0", "P1", "P2", "P3"]);\n'
                 'export type Party = z.infer<typeof PartySchema>;\n'
                 'const party = PartySchema;\n'
                 'export const participantIndex = (participant: Party) => Number(participant.slice(1));'),
                ('const recipient = z.enum(["P0", "P1", "PUBLIC"]);',
                 'const recipient = z.enum(["P0", "P1", "P2", "P3", "PUBLIC"]);'),
                ('state: z.tuple([z.union([z.literal(0), z.literal(1)]), z.union([z.literal(0), z.literal(1)])])',
                 'state: z.array(z.union([z.literal(0), z.literal(1)])).min(2).max(4)'),
                ('z.array(recipient).min(1).max(3)', 'z.array(recipient).min(1).max(5)', 2),
                ('payments: z.tuple([rational, rational]), liabilities: z.tuple([rational, rational])',
                 'payments: z.array(rational).min(2).max(4), liabilities: z.array(rational).min(2).max(4)'),
                ('payoff: z.tuple([rational.nullable(), rational.nullable()])',
                 'payoff: z.array(rational.nullable()).min(2).max(4)'),
                ('participants: z.tuple([\n'
                 '    z.object({ id: z.literal("P0"), principalId: z.string().uuid(), outsideOption: QuantitySchema }).strict(),\n'
                 '    z.object({ id: z.literal("P1"), principalId: z.string().uuid(), outsideOption: QuantitySchema }).strict()\n'
                 '  ])',
                 'participants: z.array(z.object({ id: party, principalId: z.string().uuid(), outsideOption: QuantitySchema }).strict()).min(2).max(4)'),
                ('utilities: z.tuple([BasisSchema, BasisSchema])', 'utilities: z.array(BasisSchema).min(2).max(4)'),
                ('absolutePayments: z.tuple([QuantitySchema, QuantitySchema])',
                 'absolutePayments: z.array(QuantitySchema).min(2).max(4)'),
                ('liabilities: z.tuple([QuantitySchema, QuantitySchema])',
                 'liabilities: z.array(QuantitySchema).min(2).max(4)'),
                ('  if (v.participants[0].principalId === v.participants[1].principalId)\n'
                 '    ctx.addIssue({ code: "custom", message: "Y3_DISTINCT_PRINCIPALS_REQUIRED" });',
                 '  const n = v.participants.length, parties = new Set<string>(v.participants.map(p => p.id));\n'
                 '  const issue = (message: string) => ctx.addIssue({ code: "custom", message });\n'
                 '  if (v.participants.some((p, i) => p.id !== "P"+i)) issue("Y3_PARTY_ID");\n'
                 '  if (new Set(v.participants.map(p => p.principalId)).size !== n) issue("Y3_DISTINCT_PRINCIPALS_REQUIRED");\n'
                 '  if ([v.quantityBasis.utilities, v.financialLimits.absolutePayments, v.financialLimits.liabilities].some(a => a.length !== n))\n'
                 '    issue("Y3_PARTICIPANT_VECTOR_DIMENSION");\n'
                 '  const lawful = (recipient: string) => recipient === "PUBLIC" || parties.has(recipient);\n'
                 '  if (v.observationRules.some(r => r.allowedRecipients.some(p => !lawful(p)))) issue("Y3_RECIPIENTS");\n'
                 '  for (const model of v.models) for (const node of model.nodes) {\n'
                 '    if ([node.state, node.payments, node.liabilities, ...(node.kind === "TERMINAL" ? [node.payoff] : [])].some(a => a.length !== n))\n'
                 '      issue("Y3_PARTICIPANT_VECTOR_DIMENSION");\n'
                 '    if (node.kind === "DECISION" && !parties.has(node.participant)) issue("Y3_PARTY_ID");\n'
                 '    if (node.observations.some(o => o.recipients.some(p => !lawful(p)))) issue("Y3_RECIPIENTS");\n'
                 '  }'),
            ],
        },
        {
            "path": OWNER+"game.ts",
            "symbols": ["compileGame", "InformationSet", "CompiledNode"],
            "callers": ["S4 original local history and actions, native producer"],
            "failureWithout": "P2/P3 histories alias P1 or disappear, breaking local execution and perfect recall.",
            "edits": [
                ('type InteractionModel, type Node', 'type InteractionModel, type Node, type Party, participantIndex'),
                ('participant: "P0" | "P1"', 'participant: Party'),
                ('[ObservationToken[], ObservationToken[]]', 'ObservationToken[][]', 3),
                ('[RecallToken[], RecallToken[]]', 'RecallToken[][]', 3),
                ('for (const i of [0, 1] as const) {', 'for (let i = 0; i < problem.participants.length; i++) {', 2),
                ('problem.participants[i].outsideOption', 'problem.participants[i]!.outsideOption'),
                ('const obs: ObservationToken[][] = [[...observed[0]], [...observed[1]]];',
                 'const obs: ObservationToken[][] = observed.map(row => [...row]);'),
                ('for (const i of [0, 1] as const) if (o.recipients.includes(i === 0 ? "P0" : "P1") || o.recipients.includes("PUBLIC")) obs[i].push(token);',
                 'for (const [i, participant] of problem.participants.entries())\n'
                 '        if (o.recipients.includes(participant.id) || o.recipients.includes("PUBLIC")) obs[i]!.push(token);'),
                ('q(n.payments[i])', 'q(n.payments[i]!)'),
                ('problem.financialLimits.absolutePayments[i].value!', 'problem.financialLimits.absolutePayments[i]!.value!'),
                ('q(n.liabilities[i])', 'q(n.liabilities[i]!)'),
                ('problem.financialLimits.liabilities[i].value!', 'problem.financialLimits.liabilities[i]!.value!'),
                ('const p = n.participant === "P0" ? 0 : 1;', 'const p = participantIndex(n.participant);'),
                ('obs[p], recall[p]', 'obs[p]!, recall[p]!'),
                ('observations: obs[p], recall: recall[p]', 'observations: obs[p]!, recall: recall[p]!'),
                ('const nextRecall: RecallToken[][] = [[...recall[0]], [...recall[1]]];',
                 'const nextRecall: RecallToken[][] = recall.map(row => [...row]);'),
                ('nextRecall[n.participant === "P0" ? 0 : 1].push', 'nextRecall[participantIndex(n.participant)]!.push'),
                ('walk(model.root, 0, [[], []], [], [[], []], new Map(), "1");',
                 'walk(model.root, 0, problem.participants.map(() => []), [], problem.participants.map(() => []), new Map(), "1");'),
                ('for (const p of ["P0", "P1"])', 'for (const { id: p } of problem.participants)'),
            ],
        },
        {
            "path": OWNER+"checker.py",
            "symbols": ["schema", "compile_original", "inspect"],
            "callers": ["Native fresh independent checker and Z2 full Y3 floor"],
            "failureWithout": "The complete sequential/common-global-tremble floor remains two-party-only.",
            "edits": [
                ('len(problem["participants"]) == 2', '2 <= len(problem["participants"]) <= 4'),
                ('    for i, participant in enumerate(problem["participants"]):',
                 '    n_parties = len(problem["participants"])\n'
                 '    parties = tuple("P"+str(i) for i in range(n_parties))\n'
                 '    for i, participant in enumerate(problem["participants"]):'),
                ('len(problem["quantityBasis"]["utilities"]) == 2', 'len(problem["quantityBasis"]["utilities"]) == n_parties'),
                ('len(limits[field]) == 2', 'len(limits[field]) == n_parties'),
                ('len(rule["allowedRecipients"]) <= 3 and all(r in ("P0", "P1", "PUBLIC")',
                 'len(rule["allowedRecipients"]) <= n_parties+1 and all(r in (*parties, "PUBLIC")'),
                ('len(n["state"]) == 2', 'len(n["state"]) == n_parties'),
                ('len(o["recipients"]) <= 3', 'len(o["recipients"]) <= n_parties+1'),
                ('len(n[field]) == 2', 'len(n[field]) == n_parties'),
                ('len(n["payoff"]) == 2', 'len(n["payoff"]) == n_parties'),
                ('n["participant"] in ("P0", "P1")', 'n["participant"] in parties'),
                ('for i in (0, 1):', 'for i in range(len(problem["participants"])):', 2),
                ('visit(model["root"], [[], []], [], [[], []], {}, Q(1), 0)',
                 'visit(model["root"], [[] for _ in problem["participants"]], [], [[] for _ in problem["participants"]], {}, Q(1), 0)'),
                ('for participant in ("P0", "P1"):', 'for participant in (p["id"] for p in problem["participants"]):'),
                ('for p in ("P0", "P1", "OWNER")', 'for p in (*[p["id"] for p in problem["participants"]], "OWNER")'),
                ('[str(values["P0"]), str(values["P1"])]', '[str(values[p["id"]]) for p in problem["participants"]]'),
                ('for i in (0, 1))', 'for i in range(len(problem["participants"])))'),
            ],
        },
        {
            "path": OWNER+"reference.py",
            "symbols": ["run"],
            "callers": ["Independent exhaustive original-tree continuation reference"],
            "failureWithout": "Independent continuation reference cannot detect P2/P3 regret or history pooling.",
            "edits": [
                ('This oracle is bounded to eight information sets for either party.',
                 'This oracle is bounded to 4096 complete original pure continuations per participant.'),
                ('enumerate(("P0", "P1"))', 'enumerate(p["id"] for p in problem["participants"])'),
                ('walk(model["root"], [[], []], [], [[], []])',
                 'walk(model["root"], [[] for _ in problem["participants"]], [], [[] for _ in problem["participants"]])'),
                ('            if len(party_infos) > 8:\n                raise ValueError("REFERENCE_SMALL_GAME_BOUND")',
                 '            count = 1\n'
                 '            for _, actions in party_infos:\n'
                 '                count *= len(actions)\n'
                 '            if count > 4096:\n'
                 '                raise ValueError("REFERENCE_ORIGINAL_CONTINUATION_BOUND")'),
            ],
        },
        {
            "path": OWNER+"product-contracts.ts",
            "symbols": ["InteractionIntent", "InteractionHistory"],
            "callers": ["Native persisted actions and participant-local continuation"],
            "failureWithout": "Three/four-party actions cannot retain their original actor identity in native S4.",
            "edits": [
                ('type ConstructionResult,type Check,type RuntimeIdentity,type Y3Ref',
                 'type ConstructionResult,type Check,type RuntimeIdentity,type Y3Ref,type Party'),
                ("participant:'P0'|'P1'", 'participant:Party', 2),
            ],
        },
        {
            "path": OWNER+"profile.json",
            "symbols": ["protocol_horizon_and_deviation_classes"],
            "callers": ["Native process/schema/runtime pins and full owner reconstruction"],
            "failureWithout": "The native profile digest misstates the generalized finite participant domain.",
            "edits": [
                ('"id": "postx-y3-two-party-three-date-perfect-recall-v1"',
                 '"id": "postx-y3-two-to-four-party-three-date-perfect-recall-v2"'),
                ('"parties": 2', '"parties": [2, 4]'),
            ],
        },
    ]


def extend_continuation(spec):
    spec["symbols"] += ["frontier", "localView", "recordInteractionObservation"]
    spec["edits"] += [
        ("import {InteractionFault,digest,fail} from './contracts';",
         "import {InteractionFault,digest,fail,participantIndex,type Party} from './contracts';"),
        ("e.body.participant==='P0'?0:1", "participantIndex(e.body.participant)"),
        ("party:'P0'|'P1'", "party:Party", 2),
        ("party==='P0'?0:1", "participantIndex(party)", 3),
        ("node.observations[participantIndex(e.body.participant)].some",
         "node.observations[participantIndex(e.body.participant)]!.some"),
        ("node.observations[index].filter", "node.observations[index]!.filter"),
        ("f.node.observations[index].some", "f.node.observations[index]!.some"),
        ("f.node.observations[participantIndex(party)].some",
         "f.node.observations[participantIndex(party)]!.some"),
        ("bothNewExactEffectConsentsRequired:true", "allParticipantExactEffectConsentsRequired:true"),
    ]
    return spec
