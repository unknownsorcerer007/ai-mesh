// Security: Prompt Injection Detection & Message Sanitization

const INJECTION_PATTERNS = [
  /\b(ignore|disregard|forget)\s+(previous|above|all|your)\s+(instructions?|rules?|prompts?)/i,
  /\byou\s+are\s+now\s+(a|an|the)/i,
  /\bact\s+as\s+(if|a|an)/i,
  /\bpretend\s+(you|to\s+be)/i,
  /\bsystem\s*:\s*/i,
  /\buser\s*:\s*/i,
  /\bassistant\s*:\s*/i,
  /\bhuman\s*:\s*/i,
  /\[INST\]/i,
  /\[\/INST\]/i,
  /<\|im_start\|>/i,
  /<\|im_end\|>/i,
  /\bBOS\b.*\bEOS\b/i,
  /\b(exec|eval|system|spawn|shell|bash|cmd|powershell)\s*\(/i,
  /\b(rm\s+-rf|sudo|chmod|chown|wget|curl)\s/i,
  /\b(send|post|upload|exfiltrate)\s+(to|data|all|everything)\b/i,
  /https?:\/\/[^\s]+.*(api|webhook|hook|collect)/i,
];

export function detectInjection(message: string): { safe: boolean; reason?: string } {
  for (const pattern of INJECTION_PATTERNS) {
    if (pattern.test(message)) {
      return {
        safe: false,
        reason: 'Blocked: message contains potential injection pattern',
      };
    }
  }
  return { safe: true };
}

export function sanitizeMessage(message: string): string {
  // Strip control characters (except newlines/tabs)
  let clean = message.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
  // Limit length
  if (clean.length > 10000) {
    clean = clean.slice(0, 10000) + '... [truncated]';
  }
  return clean;
}
