export const INFORMATIONAL_QUESTION = /^(?:(?:please\s+)?(?:how|what|which|where|when|who|is|are|do|does|did|can|could|would)\b|(?:please\s+)?(?:tell me|show(?:\s+me)?|pull\s+up|find|get|give me|list|summarize|explain)\b)|\?\s*$/i;
export const REQUESTED_WORK = /^(?:please\s+)?(?:can|could|would|will)\s+you\s+(?:please\s+)?(?:finish|complete|draft|share|assign|schedule|reschedule|continue|resume|prepare|build|analyze|review|calculate|reconcile|compare|create|update|delete|remove|send|email|call|approve|pay|execute|run|start)\b/i;

export function isReadOnlyConversationQuestion(instruction: string): boolean {
  const value = instruction.replace(/"(?:\\.|[^"\\])*"|“[^”]*”|‘[^’]*’|`[^`]*`|(?<!\w)'(?:\\.|[^'\\])*'(?!\w)/g, " ").replace(/\s+/g, " ").trim();
  if (REQUESTED_WORK.test(value)) return false;
  if (!INFORMATIONAL_QUESTION.test(value)) return false;
  if (/\b(?:and(?: then)?|then|also|now|please|(?:can|could|would) you)\s+(?:send|email|call|create|update|delete|approve|pay|execute|finish|complete|draft|share|assign|schedule|continue|resume)\b/i.test(value)) return false;
  if (/^(?:please\s+)?(?:what\s+(?:is\s+your\s+(?:understanding|interpretation)|do\s+you\s+(?:understand|remember))\s+(?:of|about|from)\b|(?:summarize|rephrase|translate|explain)\s+(?:this|the\s+(?:note|statement|message|passage))\b)/i.test(value)) return true;
  return /\b(?:did|have)\s+(?:i|we)\s+(?:say|tell|mention|specify|ask|discuss|establish|agree|decide)\b/i.test(value)
    || (/^(?:what|which|when|where|who)\b/i.test(value)
      && /\b(?:earlier|previously|remember|recall|last time|in this (?:chat|conversation)|we discussed)\b/i.test(value));
}
