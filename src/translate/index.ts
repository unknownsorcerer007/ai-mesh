// AI Native Language ↔ Human Translation
// No external API needed — pure parsing/formatting

export interface AIMessage {
  type: string;
  payload: Record<string, unknown>;
  context?: string;
}

// ─── Parse AI structured message to human readable ───

export function toHuman(message: string, senderAI?: string | null, senderUsername?: string): string {
  // Try to parse as JSON (AI native format)
  try {
    const parsed = JSON.parse(message) as AIMessage;
    return formatAItoHuman(parsed, senderAI, senderUsername);
  } catch {
    // Plain text — return as-is
    return message;
  }
}

function formatAItoHuman(msg: AIMessage, senderAI?: string | null, senderUsername?: string): string {
  const source = senderAI ? `${senderAI} (${senderUsername || 'unknown'})` : senderUsername || 'Agent';
  const lines: string[] = [];

  switch (msg.type) {
    case 'code_change':
      lines.push(`🔔 ${source} changed code`);
      if (msg.payload.files) lines.push(`📁 Files: ${Array.isArray(msg.payload.files) ? msg.payload.files.join(', ') : msg.payload.files}`);
      if (msg.payload.changes) lines.push(`📝 ${msg.payload.changes}`);
      if (msg.payload.breaking) lines.push(`⚠️ Breaking change!`);
      if (msg.payload.impact) lines.push(`🔗 Impact: ${Array.isArray(msg.payload.impact) ? msg.payload.impact.join(', ') : msg.payload.impact}`);
      break;

    case 'task_complete':
      lines.push(`✅ ${source} completed a task`);
      if (msg.payload.task) lines.push(`📋 Task: ${msg.payload.task}`);
      if (msg.payload.result) lines.push(`📊 Result: ${msg.payload.result}`);
      break;

    case 'error':
      lines.push(`❌ ${source} encountered an error`);
      if (msg.payload.error) lines.push(`💥 Error: ${msg.payload.error}`);
      if (msg.payload.file) lines.push(`📁 File: ${msg.payload.file}`);
      break;

    case 'review_request':
      lines.push(`👀 ${source} requests review`);
      if (msg.payload.pr) lines.push(`🔗 PR: ${msg.payload.pr}`);
      if (msg.payload.summary) lines.push(`📝 ${msg.payload.summary}`);
      break;

    case 'question':
      lines.push(`❓ ${source} asks:`);
      if (msg.payload.question) lines.push(`${msg.payload.question}`);
      if (msg.payload.context) lines.push(`Context: ${msg.payload.context}`);
      break;

    case 'status_update':
      lines.push(`📊 ${source} status update`);
      if (msg.payload.status) lines.push(`Status: ${msg.payload.status}`);
      if (msg.payload.progress) lines.push(`Progress: ${msg.payload.progress}`);
      break;

    default:
      lines.push(`🤖 ${source} sent a message`);
      lines.push(JSON.stringify(msg.payload, null, 2));
  }

  if (msg.context) lines.push(`🏷️ Context: ${msg.context}`);
  return lines.join('\n');
}

// ─── Convert human text to AI structured format ───

export function toAI(message: string): AIMessage {
  const lower = message.toLowerCase().trim();

  // Detect common patterns
  if (lower.includes('fix') || lower.includes('bug') || lower.includes('error')) {
    return { type: 'question', payload: { question: message, action_requested: 'fix' } };
  }
  if (lower.includes('review') || lower.includes('check') || lower.includes('look at')) {
    return { type: 'review_request', payload: { summary: message } };
  }
  if (lower.includes('done') || lower.includes('completed') || lower.includes('finished')) {
    return { type: 'task_complete', payload: { result: message } };
  }
  if (lower.includes('status') || lower.includes('update') || lower.includes('progress')) {
    return { type: 'status_update', payload: { status: message } };
  }

  // Default: plain text message
  return { type: 'text', payload: { content: message } };
}

// ─── Translate message (human language switch) ───
// NOTE: No external AI API — uses template-based translation for common phrases
// For real translation, users can pipe through their own AI

const TRANSLATIONS: Record<string, Record<string, string>> = {
  'hi': {
    'code_change': 'ne code change kiya',
    'task_complete': 'ka task complete ho gaya',
    'error': 'ko error aaya',
    'review_request': 'review maang raha hai',
    'sent': 'bhej diya',
    'received': 'mil gaya',
  },
  'en': {
    'code_change': 'changed code',
    'task_complete': 'completed task',
    'error': 'encountered an error',
    'review_request': 'requests review',
    'sent': 'sent',
    'received': 'received',
  },
};

export function translateType(type: string, lang: string = 'en'): string {
  return TRANSLATIONS[lang]?.[type] || TRANSLATIONS['en']?.[type] || type;
}
