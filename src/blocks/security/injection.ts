// Security: Prompt Injection Detection & Message Sanitization
//
// M6 fix: the original regex list mixed token-level patterns (good — `[INST]`,
// `<|im_start|>` are NEVER legit in a chat message) with semantic patterns
// (bad — "you are now a", "act as", "curl", "sudo" all match legit dev chat).
// Result: false sense of security (real injection paraphrases pass through)
// AND false positives (devs blocked from discussing sudo).
//
// Ponytail rule: "Never simplify away security measures" — keep the guard,
// but only at the token level where it can't false-positive. Semantic
// injection detection belongs in the consumer (the AI agent's system prompt),
// not in a regex. Defense-in-depth via message structure, not pattern matching.
const INJECTION_PATTERNS = [
  // LLM token markers — these are model-specific control tokens that have
  // no legitimate use in a chat message. Their presence means someone is
  // trying to spoof the model's chat template.
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /<\|system\|>/i,
  /<\|user\|>/i,
  /<\|assistant\|>/i,
  // Raw role-prefix markers used by some chat formats. These are line-start
  // only — "system:\n" as a standalone line is suspicious; "system: stopped
  // working" in mid-sentence is normal English.
  /^\s*(system|assistant)\s*:\s*$/im,
];

export function detectInjection(message: string): { safe: boolean; reason?: string } {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      return {
        safe: false,
        reason: 'Blocked: message contains LLM control-token pattern',
      };
    }
  }
  return { safe: true };
}

export function sanitizeMessage(message: string): string {
  // Strip control characters (except newlines/tabs)
  let clean = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // M7 fix: was 10000, schema allows 16384 — sync to schema so truncation
  // only fires when the contract actually says it should.
  if (clean.length > 16384) {
    clean = clean.slice(0, 16384) + '... [truncated]';
  }
  return clean;
}
