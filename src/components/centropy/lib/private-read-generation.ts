"use client"

// Pending responses belong to one traversal of the private workspace. Equal
// resource IDs after navigation do not make an earlier traversal current again.
let generation = 0
export function getPrivateReadGeneration(): number { return generation }
export function advancePrivateReadGeneration(): void { generation += 1 }
