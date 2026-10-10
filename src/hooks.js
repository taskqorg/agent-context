import { compress } from './core.js';

export async function claudeHook(input, compressor = compress) {
  if (input.hook_event_name !== 'PostToolUse' || input.tool_name !== 'Bash') return {};
  const response = input.tool_response;
  if (!response || typeof response !== 'object' || typeof response.stdout !== 'string' || response.stdout.length < 2048) return {};
  if (typeof input.session_id !== 'string' || !input.session_id) return { systemMessage: 'Agent Context: no session identity; original output kept.' };
  const result = await compressor({ context: response.stdout, query: 'Summarize command outcomes. Preserve exact ERROR/FATAL/Traceback lines verbatim, errors, addresses, numbers, paths and required next actions.', session: input.session_id, agent: 'Claude Code', source: 'hook' });
  if (result.skipped === 'already_seen') return {};
  if (result.skipped) return { systemMessage: `Agent Context: ${result.skipped}; original output kept.` };
  return { hookSpecificOutput: { hookEventName: 'PostToolUse', updatedToolOutput: { ...response, stdout: result.compressed_text } } };
}
