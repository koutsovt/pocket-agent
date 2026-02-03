/**
 * Shared types for the agent module
 */

import { MemoryManager } from '../memory';
import { ToolsConfig } from '../tools';

// Status event types
export type AgentStatus = {
  type: 'thinking' | 'tool_start' | 'tool_end' | 'tool_blocked' | 'responding' | 'done' | 'subagent_start' | 'subagent_update' | 'subagent_end' | 'queued' | 'queue_processing' | 'text_delta' | 'error';
  toolName?: string;
  toolInput?: string;
  message?: string;
  // Subagent tracking
  agentId?: string;
  agentType?: string;
  agentCount?: number;  // Number of active subagents
  // Queue tracking
  queuePosition?: number;
  queuedMessage?: string;
  // Safety blocking
  blockedReason?: string;
  // Streaming text
  textDelta?: string;
  isFirstChunk?: boolean;
  // Error details
  errorType?: 'api' | 'timeout' | 'rate_limit' | 'auth' | 'network' | 'unknown';
  errorDetails?: string;
};

// Image content for multimodal messages
export interface ImageContent {
  type: 'base64';
  mediaType: 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp';
  data: string;  // base64 encoded
}

// Attachment info for tracking attachments in metadata
export interface AttachmentInfo {
  hasAttachment: boolean;
  attachmentType?: 'photo' | 'voice' | 'audio';
}

export interface AgentConfig {
  memory: MemoryManager;
  projectRoot?: string;
  workspace?: string;  // Isolated working directory for agent file operations
  model?: string;
  tools?: ToolsConfig;
}

export interface ProcessResult {
  response: string;
  tokensUsed: number;
  wasCompacted: boolean;
  suggestedPrompt?: string;
}

// Provider configuration for different LLM backends
export type ProviderType = 'anthropic' | 'moonshot' | 'glm';

export interface ProviderConfig {
  baseUrl?: string;
}

// Content block types for SDK
export type TextBlock = { type: 'text'; text: string };
export type ImageBlock = { type: 'image'; source: { type: 'base64'; media_type: string; data: string } };
export type ContentBlock = TextBlock | ImageBlock;

// SDK User Message type for async iterable
export interface SDKUserMessage {
  type: 'user';
  message: {
    role: 'user';
    content: string | ContentBlock[];
  };
  parent_tool_use_id: string | null;
  session_id: string;
}

// SDK types (loaded dynamically)
export type SDKQuery = AsyncGenerator<unknown, void>;
export type CanUseToolCallback = (
  toolName: string,
  input: Record<string, unknown>,
  options: { signal: AbortSignal; toolUseID: string }
) => Promise<{ behavior: 'allow' } | { behavior: 'deny'; message: string; interrupt: boolean }>;
export type PreToolUseHookCallback = (input: { tool_name: string; tool_input: unknown }) => Promise<{
  hookSpecificOutput: {
    hookEventName: 'PreToolUse';
    permissionDecision: 'allow' | 'deny';
    permissionDecisionReason?: string;
  };
}>;
export type SDKOptions = {
  model?: string;
  cwd?: string;
  maxTurns?: number;
  maxThinkingTokens?: number;
  abortController?: AbortController;
  tools?: string[] | { type: 'preset'; preset: 'claude_code' };
  allowedTools?: string[];
  persistSession?: boolean;
  systemPrompt?: string | { type: 'preset'; preset: 'claude_code'; append?: string };
  mcpServers?: Record<string, unknown>;
  settingSources?: ('project' | 'user')[];  // Load skills from .claude/skills/
  canUseTool?: CanUseToolCallback;  // Pre-tool-use validation callback
  hooks?: {
    PreToolUse?: Array<{ hooks: PreToolUseHookCallback[] }>;
  };
};
