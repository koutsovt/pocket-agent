/**
 * AgentManager - Main orchestrator for the Claude Agent SDK
 * Thin wrapper that delegates to specialized modules
 */

import { MemoryManager, Message, SmartContextOptions } from '../memory';
import { buildMCPServers, buildSdkMcpServers, setMemoryManager, setSoulMemoryManager, ToolsConfig, validateToolsConfig, setCurrentSessionId } from '../tools';
import { closeBrowserManager } from '../browser';
import { loadIdentity } from '../config/identity';
import { loadInstructions } from '../config/instructions';
import { SettingsManager } from '../settings';
import { EventEmitter } from 'events';
import { buildCanUseToolCallback, buildPreToolUseHook, setStatusEmitter } from './safety';

// Import from local modules
import { isSimpleQuery, THINKING_BUDGETS } from './complexity';
import { MessageStatusProcessor, extractTextFromMessage } from './message-processor';
import {
  AgentStatus,
  AgentConfig,
  ProcessResult,
  ImageContent,
  AttachmentInfo,
  ProviderType,
  ProviderConfig,
  ContentBlock,
  SDKOptions,
  SDKUserMessage,
  SDKQuery,
} from './types';

// Re-export types for external consumers
export type { AgentStatus, AgentConfig, ProcessResult, ImageContent, AttachmentInfo };

// Smart context defaults
const DEFAULT_RECENT_MESSAGE_LIMIT = 20;
const DEFAULT_ROLLING_SUMMARY_INTERVAL = 50;
const DEFAULT_SEMANTIC_RETRIEVAL_COUNT = 5;

const PROVIDER_CONFIGS: Record<ProviderType, ProviderConfig> = {
  'anthropic': {},
  'moonshot': { baseUrl: 'https://api.moonshot.ai/anthropic/' },
  'glm': { baseUrl: 'https://api.z.ai/api/anthropic/' },
};

const MODEL_PROVIDERS: Record<string, ProviderType> = {
  'claude-opus-4-5-20251101': 'anthropic',
  'claude-sonnet-4-5-20250929': 'anthropic',
  'claude-haiku-4-5-20251001': 'anthropic',
  'kimi-k2.5': 'moonshot',
  'glm-4.7': 'glm',
};

function getProviderForModel(model: string): ProviderType {
  return MODEL_PROVIDERS[model] || 'anthropic';
}

function configureProviderEnvironment(model: string): void {
  const provider = getProviderForModel(model);
  const config = PROVIDER_CONFIGS[provider];

  delete process.env.ANTHROPIC_BASE_URL;
  delete process.env.ANTHROPIC_AUTH_TOKEN;

  if (provider === 'moonshot') {
    const moonshotKey = SettingsManager.get('moonshot.apiKey');
    if (!moonshotKey) {
      throw new Error('Moonshot API key not configured. Please add your key in Settings > Keys.');
    }
    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    process.env.ANTHROPIC_AUTH_TOKEN = moonshotKey;
    delete process.env.ANTHROPIC_API_KEY;
    console.log('[AgentManager] Provider configured: Moonshot (Kimi)');
  } else if (provider === 'glm') {
    const glmKey = SettingsManager.get('glm.apiKey');
    if (!glmKey) {
      throw new Error('Z.AI GLM API key not configured. Please add your key in Settings > LLM.');
    }
    process.env.ANTHROPIC_BASE_URL = config.baseUrl;
    process.env.ANTHROPIC_AUTH_TOKEN = glmKey;
    delete process.env.ANTHROPIC_API_KEY;
    console.log('[AgentManager] Provider configured: Z.AI GLM');
  } else {
    delete process.env.ANTHROPIC_BASE_URL;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    console.log('[AgentManager] Provider configured: Anthropic');
  }
}

function getSmartContextOptions(currentQuery?: string): SmartContextOptions {
  return {
    recentMessageLimit: Number(SettingsManager.get('agent.recentMessageLimit')) || DEFAULT_RECENT_MESSAGE_LIMIT,
    rollingSummaryInterval: Number(SettingsManager.get('agent.rollingSummaryInterval')) || DEFAULT_ROLLING_SUMMARY_INTERVAL,
    semanticRetrievalCount: Number(SettingsManager.get('agent.semanticRetrievalCount')) || DEFAULT_SEMANTIC_RETRIEVAL_COUNT,
    currentQuery,
  };
}

// Dynamic SDK loader
let sdkQuery: ((params: { prompt: string | AsyncIterable<SDKUserMessage>; options?: SDKOptions }) => SDKQuery) | null = null;
let sdkLoadPromise: Promise<typeof sdkQuery> | null = null;

const dynamicImport = new Function('specifier', 'return import(specifier)') as (specifier: string) => Promise<unknown>;

async function loadSDK(): Promise<typeof sdkQuery> {
  if (!sdkQuery) {
    if (!sdkLoadPromise) {
      sdkLoadPromise = (async () => {
        const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk') as { query: typeof sdkQuery };
        sdkQuery = sdk.query;
        return sdkQuery;
      })();
    }
    await sdkLoadPromise;
  }
  return sdkQuery;
}

export function prewarmSDK(): void {
  loadSDK().catch(err => console.error('[AgentManager] SDK prewarm failed:', err));
}

/**
 * AgentManager - Singleton wrapper around Claude Agent SDK
 */
class AgentManagerClass extends EventEmitter {
  private static instance: AgentManagerClass | null = null;
  private memory: MemoryManager | null = null;
  private projectRoot: string = process.cwd();
  private workspace: string = process.cwd();
  private model: string = 'claude-opus-4-5-20251101';
  private toolsConfig: ToolsConfig | null = null;
  private initialized: boolean = false;
  private identity: string = '';
  private instructions: string = '';
  private abortControllersBySession: Map<string, AbortController> = new Map();
  private processingBySession: Map<string, boolean> = new Map();
  private lastSuggestedPrompt: string | undefined = undefined;
  private messageQueueBySession: Map<string, Array<{ message: string; channel: string; images?: ImageContent[]; attachmentInfo?: AttachmentInfo; resolve: (result: ProcessResult) => void; reject: (error: Error) => void }>> = new Map();
  private messageStatusProcessor: MessageStatusProcessor;

  private constructor() {
    super();
    this.messageStatusProcessor = new MessageStatusProcessor(this);
  }

  static getInstance(): AgentManagerClass {
    if (!AgentManagerClass.instance) {
      AgentManagerClass.instance = new AgentManagerClass();
    }
    return AgentManagerClass.instance;
  }

  initialize(config: AgentConfig): void {
    this.memory = config.memory;
    this.projectRoot = config.projectRoot || process.cwd();
    this.workspace = config.workspace || this.projectRoot;
    this.model = config.model || 'claude-opus-4-5-20251101';
    this.toolsConfig = config.tools || null;
    this.initialized = true;

    this.identity = loadIdentity();
    this.instructions = loadInstructions();
    this.memory.setSummarizer(this.createSummary.bind(this));
    setMemoryManager(this.memory);
    setSoulMemoryManager(this.memory);

    setStatusEmitter((status) => {
      this.emitStatus(status);
    });

    console.log('[AgentManager] Initialized');
    console.log('[AgentManager] Project root:', this.projectRoot);
    console.log('[AgentManager] Workspace:', this.workspace);
    console.log('[AgentManager] Model:', this.model);
    console.log('[AgentManager] Identity loaded:', this.identity.length, 'chars');
    console.log('[AgentManager] Instructions loaded:', this.instructions.length, 'chars');

    if (this.toolsConfig) {
      const validation = validateToolsConfig(this.toolsConfig);
      if (!validation.valid) {
        console.warn('[AgentManager] Tool config issues:', validation.errors);
      }
      if (this.toolsConfig.browser.enabled) {
        console.log('[AgentManager] Browser: 2-tier (Electron, CDP)');
      }
    }

    this.backfillMessageEmbeddings().catch(e => {
      console.error('[AgentManager] Embedding backfill failed:', e);
    });

    console.log('[AgentManager] Pre-warming SDK...');
    prewarmSDK();
  }

  private async backfillMessageEmbeddings(): Promise<void> {
    if (!this.memory) return;
    const sessions = this.memory.getSessions();
    for (const session of sessions) {
      const embedded = await this.memory.embedRecentMessages(session.id, 100);
      if (embedded > 0) {
        console.log(`[AgentManager] Backfilled ${embedded} embeddings for session ${session.id}`);
      }
    }
  }

  isInitialized(): boolean {
    return this.initialized && this.memory !== null;
  }

  async processMessage(
    userMessage: string,
    channel: string = 'default',
    sessionId: string = 'default',
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    if (this.processingBySession.get(sessionId)) {
      return this.queueMessage(userMessage, channel, sessionId, images, attachmentInfo);
    }

    return this.executeMessage(userMessage, channel, sessionId, images, attachmentInfo);
  }

  private queueMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    return new Promise((resolve, reject) => {
      if (!this.messageQueueBySession.has(sessionId)) {
        this.messageQueueBySession.set(sessionId, []);
      }
      const queue = this.messageQueueBySession.get(sessionId)!;
      queue.push({ message: userMessage, channel, images, attachmentInfo, resolve, reject });

      const queuePosition = queue.length;
      console.log(`[AgentManager] Message queued at position ${queuePosition} for session ${sessionId}`);

      this.emitStatus({
        type: 'queued',
        queuePosition,
        queuedMessage: userMessage.slice(0, 100),
        message: `in the litter queue (#${queuePosition})`,
      });
    });
  }

  private async processQueue(sessionId: string): Promise<void> {
    const queue = this.messageQueueBySession.get(sessionId);
    if (!queue || queue.length === 0) return;

    const next = queue.shift()!;
    console.log(`[AgentManager] Processing queued message for session ${sessionId}, ${queue.length} remaining`);

    this.emitStatus({
      type: 'queue_processing',
      queuedMessage: next.message.slice(0, 100),
      message: 'digging it up now...',
    });

    try {
      const result = await this.executeMessage(next.message, next.channel, sessionId, next.images, next.attachmentInfo);
      next.resolve(result);
    } catch (error) {
      next.reject(error instanceof Error ? error : new Error(String(error)));
    }
  }

  private async executeMessage(
    userMessage: string,
    channel: string,
    sessionId: string,
    images?: ImageContent[],
    attachmentInfo?: AttachmentInfo
  ): Promise<ProcessResult> {
    if (!this.memory) {
      throw new Error('AgentManager not initialized - call initialize() first');
    }

    const memory = this.memory;
    this.processingBySession.set(sessionId, true);
    const abortController = new AbortController();
    this.abortControllersBySession.set(sessionId, abortController);
    this.lastSuggestedPrompt = undefined;
    this.messageStatusProcessor.resetToolTracking();
    let wasCompacted = false;

    const queryStartTime = Date.now();
    const isSimple = isSimpleQuery(userMessage);
    console.log(`[AgentManager] Query type: ${isSimple ? 'SIMPLE' : 'complex'} (${userMessage.length} chars)`);
    console.time('[AgentManager] Total query time');

    setCurrentSessionId(sessionId);

    try {
      console.time('[AgentManager] Context building');
      const smartContextOptions = getSmartContextOptions(isSimple ? undefined : userMessage);
      const smartContext = await memory.getSmartContext(sessionId, smartContextOptions);
      console.timeEnd('[AgentManager] Context building');
      const factsContext = memory.getFactsForContext();
      const soulContext = memory.getSoulContext();

      console.log(`[AgentManager] Smart context: ${smartContext.stats.recentCount} recent, ${smartContext.stats.summarizedMessages} summarized, ${smartContext.stats.relevantCount} relevant (${smartContext.totalTokens} tokens)`);

      const fullPromptText = this.buildPromptText(smartContext, userMessage);

      const query = await loadSDK();
      if (!query) throw new Error('Failed to load SDK');

      const userMessages = smartContext.recentMessages.filter(m => m.role === 'user');
      const lastUserMessageTimestamp = userMessages.length > 0
        ? userMessages[userMessages.length - 1].timestamp
        : undefined;

      console.time('[AgentManager] Build options');
      const options = await this.buildOptions(factsContext, soulContext, abortController, lastUserMessageTimestamp, isSimple);
      console.timeEnd('[AgentManager] Build options');

      configureProviderEnvironment(this.model);

      let queryResult;
      console.log('[AgentManager] Calling query() with model:', options.model, 'thinking:', options.maxThinkingTokens || 'default');
      console.time('[AgentManager] SDK query');
      this.emitStatus({ type: 'thinking', message: '*stretches paws* thinking...' });

      if (images && images.length > 0) {
        const contentBlocks: ContentBlock[] = [
          { type: 'text', text: fullPromptText },
          ...images.map(img => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType,
              data: img.data,
            },
          })),
        ];

        async function* messageGenerator() {
          yield {
            type: 'user' as const,
            message: {
              role: 'user' as const,
              content: contentBlocks,
            },
            parent_tool_use_id: null,
            session_id: 'default',
          };
        }

        console.log(`[AgentManager] Calling query() with ${images.length} image(s)`);
        queryResult = query({ prompt: messageGenerator(), options });
      } else {
        queryResult = query({ prompt: fullPromptText, options });
      }

      let response = '';
      let isFirstTextChunk = true;

      for await (const message of queryResult) {
        if (abortController.signal.aborted) {
          console.log('[AgentManager] Query aborted by user');
          throw new Error('Query stopped by user');
        }
        this.messageStatusProcessor.processMessage(message);
        const prevLength = response.length;
        response = extractTextFromMessage(message, response, (suggestion) => {
          this.lastSuggestedPrompt = suggestion;
        });

        if (response.length > prevLength) {
          const delta = response.slice(prevLength);
          this.emitStatus({
            type: 'text_delta',
            textDelta: delta,
            isFirstChunk: isFirstTextChunk,
          });
          isFirstTextChunk = false;
        }
      }
      console.timeEnd('[AgentManager] SDK query');

      this.emitStatus({ type: 'done' });

      if (!response) {
        const toolsUsed = this.messageStatusProcessor.getToolsUsed();
        if (toolsUsed.length > 0) {
          const toolsSummary = toolsUsed.slice(0, 5).join(', ');
          const moreCount = toolsUsed.length > 5 ? ` (+${toolsUsed.length - 5} more)` : '';
          console.log(`[AgentManager] Empty response after tools: ${toolsSummary}${moreCount}`);
          response = `done! used: ${toolsSummary}${moreCount}`;
        } else {
          console.log('[AgentManager] Empty response with no tools - possible glitch');
          response = "hmm, i got confused there. could you rephrase that?";
        }
      }

      const isScheduledJob = channel.startsWith('cron:');
      const isHeartbeat = response.toUpperCase().includes('HEARTBEAT_OK');

      if (isScheduledJob && isHeartbeat) {
        console.log('[AgentManager] Skipping HEARTBEAT_OK from scheduled job - not saving to memory');
      } else {
        let messageToSave = userMessage;
        const heartbeatSuffix = '\n\nIf nothing needs attention, reply with only HEARTBEAT_OK.';
        if (messageToSave.endsWith(heartbeatSuffix)) {
          messageToSave = messageToSave.slice(0, -heartbeatSuffix.length);
        }

        const reminderMatch = messageToSave.match(/^\[SCHEDULED REMINDER - DELIVER NOW\]\nThe user previously asked to be reminded about: "(.+?)"\n\nDeliver this reminder/);
        if (reminderMatch) {
          messageToSave = `Reminder: ${reminderMatch[1]}`;
        }

        let metadata: Record<string, unknown> | undefined;
        if (channel.startsWith('cron:')) {
          metadata = { source: 'scheduler', jobName: channel.slice(5) };
        } else if (channel === 'telegram') {
          const hasAttachment = attachmentInfo?.hasAttachment ?? (images && images.length > 0);
          const attachmentType = attachmentInfo?.attachmentType ?? (images && images.length > 0 ? 'photo' : undefined);
          metadata = { source: 'telegram', hasAttachment, attachmentType };
        }

        const userMsgId = memory.saveMessage('user', messageToSave, sessionId, metadata);
        const assistantMetadata = metadata ? { source: metadata.source } : undefined;
        const assistantMsgId = memory.saveMessage('assistant', response, sessionId, assistantMetadata);
        console.log('[AgentManager] Saved messages to SQLite (session: ' + sessionId + ')');

        memory.embedMessage(userMsgId).catch(e => console.error('[AgentManager] Failed to embed user message:', e));
        memory.embedMessage(assistantMsgId).catch(e => console.error('[AgentManager] Failed to embed assistant message:', e));
      }

      this.extractAndStoreFacts(userMessage);

      const statsAfter = memory.getStats();

      return {
        response,
        tokensUsed: statsAfter.estimatedTokens,
        wasCompacted,
        suggestedPrompt: this.lastSuggestedPrompt,
      };
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('[AgentManager] Query failed:', errorMsg);
      if (error instanceof Error && error.stack) {
        console.error('[AgentManager] Stack trace:', error.stack);
      }
      console.error('[AgentManager] Full error:', JSON.stringify(error, Object.getOwnPropertyNames(error), 2));

      const errorType = this.categorizeError(errorMsg);
      const friendlyMessage = this.getFriendlyErrorMessage(errorType, errorMsg);

      this.emitStatus({
        type: 'error',
        message: friendlyMessage,
        errorType,
        errorDetails: errorMsg,
      });

      if (!abortController.signal.aborted) {
        memory.saveMessage('user', userMessage, sessionId);
      }

      throw error;
    } finally {
      console.timeEnd('[AgentManager] Total query time');
      const totalMs = Date.now() - queryStartTime;
      console.log(`[AgentManager] Query completed in ${totalMs}ms`);
      this.processingBySession.set(sessionId, false);
      this.abortControllersBySession.delete(sessionId);

      setTimeout(() => {
        this.processQueue(sessionId).catch((err) => {
          console.error('[AgentManager] Queue processing failed:', err);
        });
      }, 0);
    }
  }

  private buildPromptText(smartContext: Awaited<ReturnType<MemoryManager['getSmartContext']>>, userMessage: string): string {
    const contextParts: string[] = [];

    if (smartContext.rollingSummary) {
      contextParts.push(`[Summary of previous conversations]\n${smartContext.rollingSummary}`);
    }

    if (smartContext.relevantMessages.length > 0) {
      const relevantText = smartContext.relevantMessages
        .map(m => {
          const timeStr = m.timestamp ? this.formatMessageTimestamp(m.timestamp) : '';
          const prefix = timeStr ? `${m.role.toUpperCase()} [${timeStr}]` : m.role.toUpperCase();
          return `${prefix}: ${m.content}`;
        })
        .join('\n\n');
      contextParts.push(`[Relevant past context]\n${relevantText}`);
    }

    if (smartContext.recentMessages.length > 0) {
      const historyText = smartContext.recentMessages
        .map(m => {
          const timeStr = m.timestamp ? this.formatMessageTimestamp(m.timestamp) : '';
          const prefix = timeStr ? `${m.role.toUpperCase()} [${timeStr}]` : m.role.toUpperCase();
          return `${prefix}: ${m.content}`;
        })
        .join('\n\n');
      contextParts.push(`[Recent conversation]\n${historyText}`);
    }

    return contextParts.length > 0
      ? `${contextParts.join('\n\n---\n\n')}\n\n---\n\nUser: ${userMessage}`
      : userMessage;
  }

  getQueueLength(sessionId: string = 'default'): number {
    return this.messageQueueBySession.get(sessionId)?.length || 0;
  }

  clearQueue(sessionId: string = 'default'): void {
    const queue = this.messageQueueBySession.get(sessionId);
    if (queue && queue.length > 0) {
      for (const item of queue) {
        item.reject(new Error('Queue cleared'));
      }
      this.messageQueueBySession.delete(sessionId);
      console.log(`[AgentManager] Queue cleared for session ${sessionId}`);
    } else if (queue) {
      this.messageQueueBySession.delete(sessionId);
    }
  }

  stopQuery(sessionId?: string, clearQueuedMessages: boolean = true): boolean {
    if (sessionId) {
      if (clearQueuedMessages) {
        this.clearQueue(sessionId);
      }

      const abortController = this.abortControllersBySession.get(sessionId);
      if (this.processingBySession.get(sessionId) && abortController) {
        console.log(`[AgentManager] Stopping query for session ${sessionId}...`);
        abortController.abort();
        return true;
      }
      return false;
    }

    for (const [sid, isProcessing] of this.processingBySession.entries()) {
      if (isProcessing) {
        if (clearQueuedMessages) {
          this.clearQueue(sid);
        }
        const abortController = this.abortControllersBySession.get(sid);
        if (abortController) {
          console.log(`[AgentManager] Stopping query for session ${sid}...`);
          abortController.abort();
          return true;
        }
      }
    }
    return false;
  }

  isQueryProcessing(sessionId?: string): boolean {
    if (sessionId) {
      return this.processingBySession.get(sessionId) || false;
    }
    for (const isProcessing of this.processingBySession.values()) {
      if (isProcessing) return true;
    }
    return false;
  }

  getWorkspace(): string {
    return this.workspace;
  }

  getProjectRoot(): string {
    return this.projectRoot;
  }

  setWorkspace(path: string): void {
    console.log('[AgentManager] Workspace changed:', this.workspace, '->', path);
    this.workspace = path;
  }

  resetWorkspace(): void {
    console.log('[AgentManager] Workspace reset to project root:', this.projectRoot);
    this.workspace = this.projectRoot;
  }

  private async buildOptions(factsContext: string, soulContext: string, abortController: AbortController, lastMessageTimestamp?: string, isSimple?: boolean): Promise<SDKOptions> {
    const appendParts: string[] = [];

    const temporalContext = this.buildTemporalContext(lastMessageTimestamp);
    appendParts.push(temporalContext);

    if (this.instructions) {
      appendParts.push(this.instructions);
    }

    if (this.identity) {
      appendParts.push(this.identity);
    }

    const userProfile = SettingsManager.getFormattedProfile();
    if (userProfile) {
      appendParts.push(userProfile);
    }

    if (factsContext) {
      appendParts.push(factsContext);
    }

    if (soulContext) {
      appendParts.push(soulContext);
    }

    const dailyLogsContext = this.memory?.getDailyLogsContext(3);
    if (dailyLogsContext) {
      appendParts.push(dailyLogsContext);
    }

    const capabilities = this.buildCapabilitiesPrompt();
    if (capabilities) {
      appendParts.push(capabilities);
    }

    const baseThinkingLevel = SettingsManager.get('agent.thinkingLevel') || 'normal';
    const effectiveThinkingLevel = isSimple ? 'minimal' : baseThinkingLevel;
    const thinkingBudget = THINKING_BUDGETS[effectiveThinkingLevel];

    if (isSimple) {
      console.log(`[AgentManager] Using minimal thinking for simple query (${thinkingBudget} tokens)`);
    }

    const options: SDKOptions = {
      model: this.model,
      cwd: this.workspace,
      maxTurns: 20,
      ...(thinkingBudget !== undefined && thinkingBudget > 0 && { maxThinkingTokens: thinkingBudget }),
      abortController,
      tools: { type: 'preset', preset: 'claude_code' },
      settingSources: ['project'],
      canUseTool: buildCanUseToolCallback(),
      hooks: {
        PreToolUse: [buildPreToolUseHook()],
      },
      allowedTools: [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep', 'WebSearch', 'WebFetch',
        'Skill',
        'mcp__pocket-agent__browser',
        'mcp__pocket-agent__notify',
        'mcp__pocket-agent__remember',
        'mcp__pocket-agent__forget',
        'mcp__pocket-agent__list_facts',
        'mcp__pocket-agent__memory_search',
        'mcp__pocket-agent__daily_log',
        'mcp__pocket-agent__soul_set',
        'mcp__pocket-agent__soul_get',
        'mcp__pocket-agent__soul_list',
        'mcp__pocket-agent__soul_delete',
        'mcp__pocket-agent__schedule_task',
        'mcp__pocket-agent__create_reminder',
        'mcp__pocket-agent__list_scheduled_tasks',
        'mcp__pocket-agent__delete_scheduled_task',
        'mcp__pocket-agent__calendar_add',
        'mcp__pocket-agent__calendar_list',
        'mcp__pocket-agent__calendar_upcoming',
        'mcp__pocket-agent__calendar_delete',
        'mcp__pocket-agent__task_add',
        'mcp__pocket-agent__task_list',
        'mcp__pocket-agent__task_complete',
        'mcp__pocket-agent__task_delete',
        'mcp__pocket-agent__task_due',
        'mcp__pocket-agent__set_project',
        'mcp__pocket-agent__get_project',
        'mcp__pocket-agent__clear_project',
      ],
      persistSession: false,
    };

    if (appendParts.length > 0) {
      options.systemPrompt = {
        type: 'preset',
        preset: 'claude_code',
        append: appendParts.join('\n\n'),
      };
    }

    if (this.toolsConfig) {
      const mcpServers = buildMCPServers(this.toolsConfig);
      const sdkMcpServers = await buildSdkMcpServers(this.toolsConfig);

      const allServers = {
        ...mcpServers,
        ...(sdkMcpServers || {}),
      };

      if (Object.keys(allServers).length > 0) {
        options.mcpServers = allServers;
        console.log('[AgentManager] MCP servers:', Object.keys(allServers).join(', '));
      }
    }

    return options;
  }

  private buildCapabilitiesPrompt(): string {
    return `## Your Capabilities as Pocket Agent

You are a persistent personal AI assistant with special capabilities.

### Your Workspace
Your working directory is: ${this.workspace}
This is an isolated environment separate from the application code.
All file operations (reading, writing, creating projects) happen here by default.
Feel free to create subdirectories, projects, and files as needed.

### Scheduling & Reminders
Use the schedule_task tool to create reminders. Three schedule formats are supported:

- One-time: "in 10 minutes", "in 2 hours", "tomorrow 3pm", "monday 9am"
- Interval: "30m", "2h", "1d" (runs every X)
- Cron: "0 9 * * *" (minute hour day month weekday)

Examples:
- schedule_task(name="call_mom", schedule="in 2 hours", prompt="Time to call mom!")
- schedule_task(name="water", schedule="2h", prompt="Time to drink water!")
- schedule_task(name="standup", schedule="0 9 * * 1-5", prompt="Daily standup time")

Use list_scheduled_tasks to see all scheduled tasks.
Use delete_scheduled_task to remove a task.

RULES:
- Use short, clean names (water, standup, break) - NO timestamps
- One-time jobs auto-delete after running

### Calendar Events
Use calendar tools to manage events with reminders:

- calendar_add: Create an event with optional reminder
- calendar_list: List events for a date
- calendar_upcoming: Show upcoming events
- calendar_delete: Remove an event

Time formats: "today 3pm", "tomorrow 9am", "monday 2pm", "in 2 hours", ISO format
Reminders trigger automatically before the event starts.

### Tasks / Todos
Use task tools to manage tasks with due dates and priorities:

- task_add: Create a task with optional due date, priority (low/medium/high), reminder
- task_list: List tasks by status (pending/completed/all)
- task_complete: Mark a task as done
- task_delete: Remove a task
- task_due: Show tasks due soon

Priorities: low, medium, high
Status: pending, in_progress, completed

### Memory & Facts
You have persistent memory! PROACTIVELY save important info when the user shares it.

Use memory tools:
- remember: Save a fact (category, key, value)
- forget: Delete a fact
- list_facts: List all facts or by category
- memory_search: Search facts by keyword

Categories: user_info, preferences, projects, people, work, notes, decisions

IMPORTANT: Save facts PROACTIVELY when user mentions:
- Personal info (name, birthday, location)
- Preferences (favorite things, likes/dislikes)
- Projects they're working on
- People important to them
- Work/job details

### Browser Automation
You have a browser tool for JS rendering and authenticated sessions:

\`\`\`
Actions:
- navigate: Go to URL
- screenshot: Capture page image
- click: Click an element
- type: Enter text in input
- evaluate: Run JavaScript
- extract: Get page data (text/html/links/tables/structured)
- scroll: Scroll page or element (up/down/left/right)
- hover: Hover over element (triggers dropdowns)
- download: Download a file
- upload: Upload file to input
- tabs_list: List open tabs (CDP tier only)
- tabs_open: Open new tab (CDP tier only)
- tabs_close: Close a tab (CDP tier only)
- tabs_focus: Switch to tab (CDP tier only)

Tiers:
- Electron (default): Hidden window for JS rendering
- CDP: Connects to user's Chrome for logged-in sessions + multi-tab

Set requires_auth=true for pages needing login.
For CDP, user must start Chrome with: --remote-debugging-port=9222
\`\`\`

### Native Notifications
You can send native desktop notifications:

\`\`\`bash
# Use the notify tool to alert the user
notify(title="Task Complete", body="Your download has finished")
notify(title="Reminder", body="Meeting in 5 minutes", urgency="critical")
\`\`\`

### Limitations
- Cannot send SMS or make calls
- For full desktop automation, user needs to enable Computer Use (Docker-based)`;
  }

  private emitStatus(status: AgentStatus): void {
    this.emit('status', status);
  }

  private async createSummary(messages: Message[]): Promise<string> {
    if (messages.length === 0) {
      return '';
    }

    const conversationText = messages
      .map(m => `${m.role.toUpperCase()}: ${m.content}`)
      .join('\n\n---\n\n');

    try {
      const query = await loadSDK();
      if (!query) throw new Error('Failed to load SDK');

      const summaryPrompt = `Summarize this conversation concisely, preserving key facts about the user (name, preferences, work), important decisions, ongoing tasks, and context needed to continue the conversation:\n\n${conversationText}`;

      const options: SDKOptions = {
        model: 'claude-haiku-4-5-20251001',
        maxTurns: 1,
        abortController: new AbortController(),
        tools: [],
        persistSession: false,
      };

      const queryResult = query({ prompt: summaryPrompt, options });
      let summary = '';

      for await (const message of queryResult) {
        summary = extractTextFromMessage(message, summary);
      }

      console.log(`[AgentManager] Created summary of ${messages.length} messages`);
      return summary || `Previous conversation (${messages.length} messages) summarized.`;
    } catch (error) {
      console.error('[AgentManager] Summarization failed:', error);

      const userMessages = messages.filter(m => m.role === 'user');
      const snippets = userMessages
        .slice(-10)
        .map(m => m.content.slice(0, 100))
        .join('; ');

      return `Previous conversation (${messages.length} messages). Topics discussed: ${snippets}`;
    }
  }

  private parseDbTimestamp(timestamp: string): Date {
    if (/Z$|[+-]\d{2}:?\d{2}$/.test(timestamp)) {
      return new Date(timestamp);
    }

    const userTimezone = SettingsManager.get('profile.timezone');

    if (userTimezone) {
      const normalized = timestamp.replace(' ', 'T');
      return new Date(normalized + 'Z');
    } else {
      const normalized = timestamp.replace(' ', 'T');
      return new Date(normalized);
    }
  }

  private formatMessageTimestamp(timestamp: string): string {
    try {
      const date = this.parseDbTimestamp(timestamp);
      const now = new Date();
      const diffMs = now.getTime() - date.getTime();
      const diffMins = Math.floor(diffMs / 60000);
      const diffHours = Math.floor(diffMs / 3600000);
      const diffDays = Math.floor(diffMs / 86400000);

      if (diffMins < 1) return 'just now';
      if (diffMins < 60) return `${diffMins}m ago`;
      if (diffHours < 24) return `${diffHours}h ago`;
      if (diffDays < 7) return `${diffDays}d ago`;

      return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    } catch {
      return '';
    }
  }

  private buildTemporalContext(lastMessageTimestamp?: string): string {
    const now = new Date();
    const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
    const dayName = dayNames[now.getDay()];

    const timeStr = now.toLocaleTimeString('en-US', {
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });

    const dateStr = now.toLocaleDateString('en-US', {
      month: 'long',
      day: 'numeric',
      year: 'numeric',
    });

    const lines = [
      '## Current Time',
      `It is ${dayName}, ${dateStr} at ${timeStr}.`,
    ];

    if (lastMessageTimestamp) {
      try {
        const lastDate = this.parseDbTimestamp(lastMessageTimestamp);
        const diffMs = now.getTime() - lastDate.getTime();
        const diffMins = Math.floor(diffMs / 60000);
        const diffHours = Math.floor(diffMs / 3600000);
        const diffDays = Math.floor(diffMs / 86400000);

        let timeSince = '';
        if (diffMins < 1) timeSince = 'just now';
        else if (diffMins < 60) timeSince = `${diffMins} minute${diffMins !== 1 ? 's' : ''} ago`;
        else if (diffHours < 24) timeSince = `${diffHours} hour${diffHours !== 1 ? 's' : ''} ago`;
        else if (diffDays < 7) timeSince = `${diffDays} day${diffDays !== 1 ? 's' : ''} ago`;
        else timeSince = lastDate.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });

        lines.push(`Last message from user was ${timeSince}.`);
      } catch {
        // Ignore timestamp parsing errors
      }
    }

    return lines.join('\n');
  }

  private categorizeError(errorMsg: string): 'api' | 'timeout' | 'rate_limit' | 'auth' | 'network' | 'unknown' {
    const lowerMsg = errorMsg.toLowerCase();

    if (lowerMsg.includes('rate limit') || lowerMsg.includes('429') || lowerMsg.includes('too many requests')) {
      return 'rate_limit';
    }
    if (lowerMsg.includes('timeout') || lowerMsg.includes('timed out') || lowerMsg.includes('deadline exceeded')) {
      return 'timeout';
    }
    if (lowerMsg.includes('unauthorized') || lowerMsg.includes('401') || lowerMsg.includes('invalid api key') || lowerMsg.includes('authentication')) {
      return 'auth';
    }
    if (lowerMsg.includes('network') || lowerMsg.includes('econnrefused') || lowerMsg.includes('enotfound') || lowerMsg.includes('fetch failed') || lowerMsg.includes('connection')) {
      return 'network';
    }
    if (lowerMsg.includes('api') || lowerMsg.includes('500') || lowerMsg.includes('502') || lowerMsg.includes('503') || lowerMsg.includes('overloaded')) {
      return 'api';
    }
    return 'unknown';
  }

  private getFriendlyErrorMessage(errorType: string, originalMsg: string): string {
    switch (errorType) {
      case 'rate_limit':
        return 'Slow down there, tiger! API rate limit hit. Try again in a moment.';
      case 'timeout':
        return 'That took too long and timed out. Try a simpler request?';
      case 'auth':
        return 'Authentication failed. Check your API key in settings.';
      case 'network':
        return 'Network hiccup! Check your internet connection.';
      case 'api':
        return 'The API is having issues right now. Try again shortly.';
      default:
        return originalMsg.length > 100 ? originalMsg.slice(0, 100) + '...' : originalMsg;
    }
  }

  private extractAndStoreFacts(userMessage: string): void {
    if (!this.memory) return;

    const patterns: Array<{ pattern: RegExp; category: string; subject: string }> = [
      { pattern: /my name is (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /call me (\w+)/i, category: 'user_info', subject: 'name' },
      { pattern: /i live in ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i'm from ([^.,]+)/i, category: 'user_info', subject: 'location' },
      { pattern: /i work (?:at|for) ([^.,]+)/i, category: 'work', subject: 'employer' },
      { pattern: /i work as (?:a |an )?([^.,]+)/i, category: 'work', subject: 'role' },
      { pattern: /my job is ([^.,]+)/i, category: 'work', subject: 'role' },
    ];

    for (const { pattern, category, subject } of patterns) {
      const match = userMessage.match(pattern);
      if (match && match[1]) {
        this.memory.saveFact(category, subject, match[1].trim());
        console.log(`[AgentManager] Extracted fact: [${category}] ${subject}: ${match[1]}`);
      }
    }
  }

  // ============ Public API ============

  getStats(sessionId?: string): ReturnType<MemoryManager['getStats']> | null {
    return this.memory?.getStats(sessionId) || null;
  }

  clearConversation(sessionId?: string): void {
    this.memory?.clearConversation(sessionId);
    console.log('[AgentManager] Conversation cleared' + (sessionId ? ` (session: ${sessionId})` : ''));
  }

  getMemory(): MemoryManager | null {
    return this.memory;
  }

  searchFacts(queryStr: string): Array<{ category: string; subject: string; content: string }> {
    return this.memory?.searchFacts(queryStr) || [];
  }

  saveFact(category: string, subject: string, content: string): void {
    this.memory?.saveFact(category, subject, content);
  }

  getAllFacts(): Array<{ id: number; category: string; subject: string; content: string }> {
    return this.memory?.getAllFacts() || [];
  }

  getRecentMessages(limit: number = 10, sessionId: string = 'default'): Message[] {
    return this.memory?.getRecentMessages(limit, sessionId) || [];
  }

  getToolsConfig(): ToolsConfig | null {
    return this.toolsConfig;
  }

  cleanup(): void {
    closeBrowserManager();
    console.log('[AgentManager] Cleanup complete');
  }
}

export const AgentManager = AgentManagerClass.getInstance();
export { AgentManagerClass };
