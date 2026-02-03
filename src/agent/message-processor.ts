/**
 * Message processing utilities for the agent
 * Handles extraction, formatting, and status processing from SDK messages
 */

import { EventEmitter } from 'events';
import { AgentStatus } from './types';

/**
 * Extract text response from SDK message
 */
export function extractTextFromMessage(message: unknown, current: string, onSuggestion?: (suggestion: string) => void): string {
  const msg = message as { type?: string; message?: { content?: unknown }; output?: string; result?: string };
  if (msg.type === 'assistant') {
    const content = msg.message?.content;
    if (Array.isArray(content)) {
      const textBlocks = content
        .filter((block: unknown) => (block as { type?: string })?.type === 'text')
        .map((block: unknown) => (block as { text: string }).text);
      const text = textBlocks.join('\n');
      // Extract and strip any trailing "User:" suggested prompts
      const { text: cleanedText, suggestion } = extractSuggestedPrompt(text);
      if (suggestion && onSuggestion) {
        onSuggestion(suggestion);
      }
      return cleanedText;
    }
  }

  if (msg.type === 'result') {
    const result = msg.output || msg.result;
    if (result) {
      // Extract and strip any trailing "User:" suggested prompts from result
      const { text: cleanedText, suggestion } = extractSuggestedPrompt(result);
      if (suggestion && onSuggestion) {
        onSuggestion(suggestion);
      }
      return cleanedText;
    }
  }

  return current;
}

/**
 * Extract and strip trailing suggested user prompts that the SDK might include
 * These appear as "User: ..." at the end of responses
 * Returns both the cleaned text and the extracted suggestion
 */
export function extractSuggestedPrompt(text: string): { text: string; suggestion?: string } {
  if (!text) return { text };

  // Pattern: newlines followed by "User:" (case-insensitive) and any text until end
  const match = text.match(/\n\nuser:\s*(.+)$/is);

  if (match) {
    const suggestion = match[1].trim();
    const cleanedText = text.replace(/\n\nuser:[\s\S]*$/is, '').trim();

    // Validate that the suggestion looks like a user prompt, not an assistant question
    const isValidUserPrompt = validateUserPrompt(suggestion);

    if (isValidUserPrompt) {
      console.log('[MessageProcessor] Extracted suggested prompt:', suggestion);
      return { text: cleanedText, suggestion };
    } else {
      console.log('[MessageProcessor] Rejected invalid suggestion (assistant-style):', suggestion);
      return { text: cleanedText }; // Strip but don't use as suggestion
    }
  }

  return { text: text.trim() };
}

/**
 * Check if a suggestion looks like a valid user prompt
 * Rejects questions and assistant-style speech
 */
export function validateUserPrompt(suggestion: string): boolean {
  if (!suggestion) return false;

  // Reject if it ends with a question mark (assistant asking a question)
  if (suggestion.endsWith('?')) return false;

  // Reject if it starts with common question/assistant words
  const assistantPatterns = /^(what|how|would|do|does|is|are|can|could|shall|should|may|might|let me|i can|i'll|i will|here's|here is)/i;
  if (assistantPatterns.test(suggestion)) return false;

  // Reject if it's too long (likely not a simple user command)
  if (suggestion.length > 100) return false;

  // Accept short, command-like suggestions
  return true;
}

/**
 * Format tool name for display with cat-themed names
 */
export function formatToolName(name: string): string {
  const friendlyNames: Record<string, string> = {
    // SDK built-in tools
    Read: 'sniffing this file',
    Write: 'scratching notes down',
    Edit: 'pawing at some code',
    Bash: 'hacking at the terminal',
    Glob: 'hunting for files',
    Grep: 'digging through code',
    WebSearch: 'prowling the web',
    WebFetch: 'fetching that page',
    Task: 'summoning a helper kitty',
    NotebookEdit: 'editing notebook',

    // Memory tools
    remember: 'stashing in my cat brain',
    forget: 'knocking it off the shelf',
    list_facts: 'checking my memories',
    memory_search: 'sniffing through archives',

    // Browser tool
    browser: 'pouncing on browser',

    // Computer use tool
    computer: 'walking on the keyboard',

    // Scheduler tools
    schedule_task: 'setting an alarm meow',
    list_scheduled_tasks: 'checking the schedule',
    delete_scheduled_task: 'knocking that off',

    // macOS tools
    notify: 'sending a meow',

    // Task tools
    task_add: 'adding to the hunt list',
    task_list: 'checking your tasks',
    task_complete: 'caught it!',
    task_delete: 'batting that away',
    task_due: 'sniffing what\'s due',

    // Calendar tools
    calendar_add: 'marking territory',
    calendar_list: 'checking the calendar',
    calendar_upcoming: 'seeing what\'s coming up',
    calendar_delete: 'scratching that out',
  };
  return friendlyNames[name] || name;
}

/**
 * Format tool input for display
 */
export function formatToolInput(input: unknown): string {
  if (!input) return '';
  // Extract meaningful info from tool input
  if (typeof input === 'string') return input.slice(0, 100);
  const inp = input as Record<string, string | number[] | undefined>;

  // File operations
  if (inp.file_path) return inp.file_path as string;
  if (inp.notebook_path) return inp.notebook_path as string;

  // Search/patterns
  if (inp.pattern) return inp.pattern as string;
  if (inp.query) return inp.query as string;

  // Commands
  if (inp.command) return (inp.command as string).slice(0, 80);

  // Web
  if (inp.url) return inp.url as string;

  // Agent/Task
  if (inp.prompt) return (inp.prompt as string).slice(0, 80);
  if (inp.description) return (inp.description as string).slice(0, 80);

  // Memory tools
  if (inp.category && inp.subject) return `${inp.category}/${inp.subject}`;
  if (inp.content) return (inp.content as string).slice(0, 80);

  // Browser tool
  if (inp.action) {
    const browserActions: Record<string, string> = {
      navigate: inp.url ? `→ ${inp.url}` : 'navigating',
      screenshot: 'capturing screen',
      click: inp.selector ? `clicking ${inp.selector}` : 'clicking',
      type: inp.text ? `typing "${(inp.text as string).slice(0, 30)}"` : 'typing',
      evaluate: 'running script',
      extract: (inp.extract_type as string) || 'extracting data',
    };
    return browserActions[inp.action as string] || (inp.action as string);
  }

  // Computer use
  if (inp.coordinate && Array.isArray(inp.coordinate) && inp.coordinate.length >= 2) {
    return `at (${inp.coordinate[0]}, ${inp.coordinate[1]})`;
  }
  if (inp.text) return `"${(inp.text as string).slice(0, 40)}"`;

  return '';
}

/**
 * Get subagent status message
 */
export function getSubagentMessage(agentType: string): string {
  const messages: Record<string, string> = {
    'Explore': 'sent a curious kitten to explore',
    'Plan': 'calling in the architect cat',
    'Bash': 'summoning a terminal tabby',
    'general-purpose': 'summoning a helper kitty',
  };
  return messages[agentType] || `summoning ${agentType} cat friend`;
}

/**
 * Message status processor - handles SDK message events and emits status updates
 */
export class MessageStatusProcessor {
  private emitter: EventEmitter;
  private activeSubagents: Map<string, { type: string; description: string }> = new Map();
  private toolsUsedInQuery: string[] = [];

  constructor(emitter: EventEmitter) {
    this.emitter = emitter;
  }

  /**
   * Reset tool tracking for new query
   */
  resetToolTracking(): void {
    this.toolsUsedInQuery = [];
    this.activeSubagents.clear();
  }

  /**
   * Get tools used in current query
   */
  getToolsUsed(): string[] {
    return this.toolsUsedInQuery;
  }

  /**
   * Emit a status event
   */
  emitStatus(status: AgentStatus): void {
    this.emitter.emit('status', status);
  }

  /**
   * Process SDK message and emit appropriate status
   */
  processMessage(message: unknown): void {
    // Handle tool use from assistant messages
    const msg = message as { type?: string; subtype?: string; message?: { content?: unknown } };
    if (msg.type === 'assistant') {
      const content = msg.message?.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_use') {
            const rawName = block.name as string;
            const toolName = formatToolName(rawName);
            const toolInput = formatToolInput(block.input);

            // Track tool usage for empty response handling
            this.toolsUsedInQuery.push(rawName);

            // Check if this is a Task (subagent) tool
            if (rawName === 'Task') {
              const input = block.input as { subagent_type?: string; description?: string; prompt?: string };
              const agentId = `agent-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
              const agentType = input.subagent_type || 'general';
              const description = input.description || input.prompt?.slice(0, 50) || 'working on it';

              this.activeSubagents.set(agentId, { type: agentType, description });

              this.emitStatus({
                type: 'subagent_start',
                agentId,
                agentType,
                toolInput: description,
                agentCount: this.activeSubagents.size,
                message: getSubagentMessage(agentType),
              });
            } else {
              this.emitStatus({
                type: 'tool_start',
                toolName,
                toolInput,
                message: `batting at ${toolName}...`,
              });
            }
          }
        }
      }
    }

    // Handle tool results
    if (msg.type === 'user' && msg.message?.content) {
      const content = msg.message.content;
      if (Array.isArray(content)) {
        for (const block of content) {
          if (block?.type === 'tool_result') {
            // Check if any subagents completed
            if (this.activeSubagents.size > 0) {
              // Remove one subagent (we don't have exact ID matching, so remove oldest)
              const firstKey = this.activeSubagents.keys().next().value;
              if (firstKey) {
                this.activeSubagents.delete(firstKey);
              }

              if (this.activeSubagents.size > 0) {
                // Still have active subagents
                this.emitStatus({
                  type: 'subagent_update',
                  agentCount: this.activeSubagents.size,
                  message: `${this.activeSubagents.size} kitty${this.activeSubagents.size > 1 ? 'ies' : ''} still hunting`,
                });
              } else {
                this.emitStatus({
                  type: 'subagent_end',
                  agentCount: 0,
                  message: 'squad done! cleaning up...',
                });
              }
            } else {
              this.emitStatus({
                type: 'tool_end',
                message: 'caught it! processing...',
              });
            }
          }
        }
      }
    }

    // Handle system messages
    if (msg.type === 'system') {
      if (msg.subtype === 'init') {
        this.emitStatus({ type: 'thinking', message: 'waking up from a nap...' });
      }
    }
  }
}
