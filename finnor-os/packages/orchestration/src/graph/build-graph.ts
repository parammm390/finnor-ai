import { StateGraph, START, END, type BaseCheckpointSaver } from "@langchain/langgraph";
import type { ToolRegistry } from "@finnor/tools";
import type { PluginRegistry } from "../plugin-registry";
import { GateStateAnnotation } from "./state";
import {
  makeValidateNode,
  routeAfterValidate,
  makeDraftNode,
  routeAfterDraft,
  makeGateNode,
  routeAfterGate,
  pauseNode,
  routeAfterPause,
  makeExecuteNode,
  makeFailedNode,
  makeRejectedNode,
} from "./nodes";

export function buildGateGraph(plugins: PluginRegistry, tools: ToolRegistry, checkpointer: BaseCheckpointSaver) {
  // Node names must not collide with state channel names (LangGraph constraint) — the
  // "draft" channel holds the DraftAction value, so the node that produces it is
  // named "draftAction".
  const graph = new StateGraph(GateStateAnnotation)
    .addNode("validate", makeValidateNode(plugins))
    .addNode("draftAction", makeDraftNode(plugins))
    .addNode("gate", makeGateNode())
    .addNode("pause", pauseNode)
    .addNode("execute", makeExecuteNode(plugins, tools))
    .addNode("failed", makeFailedNode())
    .addNode("rejected", makeRejectedNode())
    .addEdge(START, "validate")
    .addConditionalEdges("validate", routeAfterValidate, { draft: "draftAction", failed: "failed" })
    .addConditionalEdges("draftAction", routeAfterDraft, { gate: "gate", failed: "failed" })
    .addConditionalEdges("gate", routeAfterGate, { pause: "pause", execute: "execute", failed: "failed" })
    .addConditionalEdges("pause", routeAfterPause, { execute: "execute", rejected: "rejected" })
    .addEdge("execute", END)
    .addEdge("failed", END)
    .addEdge("rejected", END);

  return graph.compile({ checkpointer });
}
