# How to Effectively Work with Claude Agent SDK

## Core Concepts (5 Minutes to Understand)

### 1. **The SDK Does 3 Things**
```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// 1. Provides built-in tools (claude_code preset)
// 2. Handles the tool execution loop automatically
// 3. Supports custom tools via MCP servers

const result = query({ prompt, options });
for await (const message of result) {
  // Stream of: thinking → tool_use → tool_result → text
}
```

### 2. **Two Types of Tools**
- **Built-in** (9 tools): Read, Write, Edit, Bash, Glob, Grep, WebSearch, WebFetch, Skill
- **Custom** (unlimited): Your tools via `createSdkMcpServer()`

### 3. **The Agent Loop**
```
User prompt → Think → Use tool → Get result → Think → Use tool → ... → Final answer
```
SDK handles this automatically. You just process the stream.

---

## Quick Start Pattern (Copy This)

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';

// 1. Basic setup
const result = query({
  prompt: "Read config.json and explain it",
  options: {
    model: 'claude-opus-4-5-20251101',
    cwd: '/path/to/workspace',        // Sandbox for file ops
    tools: { type: 'preset', preset: 'claude_code' },
    maxTurns: 20,                      // Max tool loop iterations
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: 'Custom instructions here'  // Add context
    }
  }
});

// 2. Process stream
let response = '';
for await (const message of result) {
  if (message.type === 'assistant') {
    const content = message.message?.content;
    if (Array.isArray(content)) {
      for (const block of content) {
        if (block.type === 'text') {
          response += block.text;
        }
        if (block.type === 'tool_use') {
          console.log(`Using tool: ${block.name}`);
        }
      }
    }
  }
}

console.log('Final response:', response);
```

---

## Adding Custom Tools (The Power Move)

### Pattern from Pocket Agent:

```typescript
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// 1. Define tool with Zod schema
const browserTool = tool(
  'browser',
  'Control a web browser for automation',
  {
    action: z.enum(['navigate', 'screenshot', 'click']),
    url: z.string().optional(),
    selector: z.string().optional()
  },
  async (args) => {
    // Your implementation
    const result = await handleBrowserAction(args);
    return { content: [{ type: 'text', text: result }] };
  }
);

// 2. Create MCP server
const server = createSdkMcpServer({
  name: 'my-tools',
  version: '1.0.0',
  tools: [browserTool, notifyTool, memoryTool]
});

// 3. Pass to SDK
const result = query({
  prompt: "Take a screenshot of google.com",
  options: {
    tools: { type: 'preset', preset: 'claude_code' },
    mcpServers: { 'my-tools': server },
    allowedTools: [
      'Read', 'Write', 'Bash',  // Built-in
      'mcp__my-tools__browser'   // Custom (format: mcp__<server>__<tool>)
    ]
  }
});
```

---

## Best Practices from Pocket Agent

### 1. **Always Set Working Directory**
```typescript
options: {
  cwd: '/isolated/workspace',  // ✅ Sandbox file operations
  // Without this, agent can access your entire filesystem
}
```

### 2. **Use AllowedTools for Security**
```typescript
options: {
  allowedTools: [
    'Read', 'Write', 'Edit',   // Only what you need
    // Don't expose Bash if you don't need it
  ]
}
```

### 3. **Add Context via System Prompt**
```typescript
options: {
  systemPrompt: {
    type: 'preset',
    preset: 'claude_code',
    append: [
      '## Current Time',
      `It is ${new Date().toLocaleString()}`,
      '',
      '## Your Capabilities',
      'You can read/write files, run commands, browse web',
      '',
      '## User Preferences',
      userProfile,
      '',
      '## Important Facts',
      savedFacts
    ].join('\n')
  }
}
```

### 4. **Handle Abort for Long Operations**
```typescript
const abortController = new AbortController();

// User clicks "Stop" button
stopButton.addEventListener('click', () => {
  abortController.abort();
});

const result = query({
  prompt,
  options: {
    abortController,  // Pass it in
    // ...
  }
});

for await (const message of result) {
  if (abortController.signal.aborted) {
    break;  // Stop processing
  }
  // ...
}
```

### 5. **Stream Status to UI**
```typescript
for await (const message of result) {
  // Extract status for real-time updates
  if (message.type === 'assistant') {
    const content = message.message?.content;
    for (const block of content) {
      if (block.type === 'tool_use') {
        updateUI(`Using ${block.name}...`);  // Show progress
      }
    }
  }

  if (message.type === 'user' && hasToolResult(message)) {
    updateUI('Processing result...');
  }
}
```

### 6. **Wrap Tool Handlers with Timeouts**
```typescript
function wrapToolHandler(name, handler, timeout = 30000) {
  return async (args) => {
    const timeoutPromise = new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`Tool ${name} timed out`)), timeout)
    );

    try {
      return await Promise.race([handler(args), timeoutPromise]);
    } catch (error) {
      console.error(`[${name}] Error:`, error);
      throw error;
    }
  };
}

const safeBrowserTool = tool(
  'browser',
  'Browser automation',
  schema,
  wrapToolHandler('browser', browserHandler, 60000)  // 60s timeout
);
```

---

## Common Pitfalls & Solutions

### ❌ Problem: Tools Called Too Many Times
```typescript
// Agent keeps looping, wasting tokens
```
**Solution:** Set `maxTurns`
```typescript
options: {
  maxTurns: 10,  // Limit tool loop iterations
}
```

### ❌ Problem: Slow Responses
```typescript
// Using Opus for everything
```
**Solution:** Use appropriate models
```typescript
// Simple tasks
model: 'claude-haiku-4-5-20251001'  // Fast & cheap

// Complex reasoning
model: 'claude-opus-4-5-20251101'   // Slow & smart

// Balance
model: 'claude-sonnet-4-5-20250929' // Medium
```

### ❌ Problem: Context Too Large
```typescript
// Hitting token limits
```
**Solution:** Smart context assembly (Pocket Agent pattern)
```typescript
// Don't send all messages
const smartContext = {
  recent: last20Messages,           // Recent conversation
  summary: summarizeOlder(older),   // Compressed history
  relevant: vectorSearch(query)     // Semantic retrieval
};

const prompt = buildPrompt(smartContext);
```

### ❌ Problem: No Type Safety for Custom Tools
```typescript
// Tools break at runtime
```
**Solution:** Use Zod schemas
```typescript
const schema = {
  url: z.string().url(),           // Validates URL format
  timeout: z.number().min(0).max(60000),
  required: z.boolean().default(false)
};
```

---

## Architecture Patterns

### Pattern 1: Singleton Manager (Pocket Agent)
```typescript
class AgentManager {
  private static instance: AgentManager;
  private memory: MemoryManager;
  private processingBySession: Map<string, boolean>;

  static getInstance() {
    if (!this.instance) {
      this.instance = new AgentManager();
    }
    return this.instance;
  }

  async processMessage(msg, sessionId) {
    // Queue management
    if (this.processingBySession.get(sessionId)) {
      return this.queueMessage(msg, sessionId);
    }

    // Process
    const result = await this.executeMessage(msg, sessionId);
    return result;
  }
}
```

### Pattern 2: Event-Driven Status
```typescript
class AgentManager extends EventEmitter {
  async processMessage(msg) {
    this.emit('status', { type: 'thinking' });

    for await (const message of queryResult) {
      if (message.type === 'assistant') {
        this.emit('status', { type: 'tool_start', name: '...' });
      }
      if (hasToolResult(message)) {
        this.emit('status', { type: 'tool_end' });
      }
    }

    this.emit('status', { type: 'done' });
  }
}

// UI subscribes
agent.on('status', (status) => {
  updateUI(status.type, status.message);
});
```

### Pattern 3: Memory Integration
```typescript
async processMessage(userMsg, sessionId) {
  // 1. Get context
  const context = await memory.getSmartContext(sessionId);
  const facts = memory.getFacts();

  // 2. Build prompt
  const prompt = `
    [Previous conversation]
    ${context.recent.join('\n')}

    [Important facts]
    ${facts.join('\n')}

    [Current message]
    ${userMsg}
  `;

  // 3. Query SDK
  const result = await query({ prompt, options });

  // 4. Save to memory
  memory.saveMessage('user', userMsg, sessionId);
  memory.saveMessage('assistant', response, sessionId);

  // 5. Extract facts in background
  memory.embedMessage(msgId);  // Don't await
}
```

---

## Debugging Tips

### 1. **Log Everything**
```typescript
console.log('[Agent] Calling query() with model:', options.model);
console.log('[Agent] Tools enabled:', options.allowedTools);

for await (const message of result) {
  console.log('[Agent] Message type:', message.type);
  if (message.type === 'assistant') {
    console.log('[Agent] Content:', JSON.stringify(message.message?.content, null, 2));
  }
}
```

### 2. **Inspect Tool Calls**
```typescript
if (block.type === 'tool_use') {
  console.log(`[Tool] ${block.name}`);
  console.log('[Tool] Input:', JSON.stringify(block.input, null, 2));
}
```

### 3. **Track Timing**
```typescript
const start = Date.now();
for await (const message of result) {
  const elapsed = Date.now() - start;
  console.log(`[${elapsed}ms] ${message.type}`);
}
```

### 4. **Test Tools Independently**
```typescript
// Before using in SDK, test tool directly
const result = await browserHandler({
  action: 'navigate',
  url: 'https://google.com'
});
console.log('Tool result:', result);
```

---

## Performance Optimization

### 1. **Use Thinking Budgets**
```typescript
options: {
  maxThinkingTokens: 10000,  // Extended reasoning
  // Or: 2048 (minimal), 32000 (max)
}
```

### 2. **Cache System Prompts** (if repetitive)
```typescript
// If same instructions for every call
const baseOptions = {
  model: 'claude-opus-4',
  tools: { type: 'preset', preset: 'claude_code' },
  systemPrompt: { /* cache this */ }
};

// Reuse
const result = query({ prompt: msg, options: baseOptions });
```

### 3. **Lazy Load SDK**
```typescript
// Don't import at top level (breaks CommonJS)
const dynamicImport = new Function('specifier', 'return import(specifier)');

async function loadSDK() {
  if (!sdkQuery) {
    const sdk = await dynamicImport('@anthropic-ai/claude-agent-sdk');
    sdkQuery = sdk.query;
  }
  return sdkQuery;
}
```

---

## Testing Strategy

```typescript
import { query } from '@anthropic-ai/claude-agent-sdk';
import { describe, it, expect } from 'vitest';

describe('Agent', () => {
  it('should read files', async () => {
    const result = query({
      prompt: 'Read test.txt',
      options: {
        cwd: '/test/workspace',
        tools: { type: 'preset', preset: 'claude_code' }
      }
    });

    let response = '';
    for await (const msg of result) {
      response += extractText(msg);
    }

    expect(response).toContain('test content');
  });

  it('should use custom tools', async () => {
    const mockTool = tool('mock', 'Test tool', {}, async () => {
      return { content: [{ type: 'text', text: 'mocked' }] };
    });

    const server = createSdkMcpServer({
      name: 'test',
      tools: [mockTool]
    });

    const result = query({
      prompt: 'Use the mock tool',
      options: {
        mcpServers: { test: server },
        allowedTools: ['mcp__test__mock']
      }
    });

    // Assert tool was called
  });
});
```

---

## Why Claude Agent SDK vs Alternatives

### Quick Comparison

| Feature | Claude SDK | LangChain | Vercel AI | OpenAI Assistants | Gemini API |
|---------|-----------|-----------|-----------|-------------------|------------|
| **Built-in Tools** | ✅ 9 tools | ❌ DIY | ❌ DIY | ⚠️ 2 tools | ❌ DIY |
| **Auto Tool Loop** | ✅ Yes | ⚠️ Partial | ❌ No | ✅ Yes | ❌ No |
| **Local File Access** | ✅ Yes | ⚠️ DIY | ⚠️ DIY | ❌ Cloud only | ⚠️ DIY |
| **MCP Support** | ✅ Native | ❌ No | ❌ No | ❌ No | ❌ No |
| **Desktop Focus** | ✅ Yes | 🟡 Neutral | ❌ Web | ❌ Cloud | 🟡 Neutral |
| **Multi-model** | ❌ Claude only | ✅ Yes | ✅ Yes | ❌ OpenAI only | ❌ Google only |

### When to Use Claude SDK

✅ **Perfect for:**
- Desktop agents that need file system access
- Apps requiring terminal/bash execution
- Projects using Model Context Protocol (MCP)
- Claude-specific deployments
- Agentic workflows with multiple tool calls

❌ **Not ideal for:**
- Multi-model support required (use LangChain)
- Simple chat interfaces (use Vercel AI SDK)
- Cloud-only deployments (consider OpenAI Assistants)
- Python projects (SDK is TypeScript-focused)

---

## MCP (Model Context Protocol)

### What Makes MCP Special

**MCP = Standard protocol for AI tools**

```typescript
// Without MCP: Different format for each provider
const openaiTool = { type: "function", function: {...} };
const anthropicTool = { name: "...", input_schema: {...} };

// With MCP: One format, works everywhere
const mcpServer = createSdkMcpServer({
  tools: [browserTool, memoryTool]
});
```

### Why This Matters

1. **Reusable Tools**: Build once, use across apps
2. **Community Ecosystem**: Share/discover MCP tools
3. **Future-Proof**: As MCP adoption grows, tools become portable
4. **Claude SDK is the only framework with native MCP support**

### MCP Tools in Pocket Agent

```typescript
// All custom tools use MCP
const server = createSdkMcpServer({
  name: 'pocket-agent-tools',
  tools: [
    browser,      // Web automation
    notify,       // Notifications
    remember,     // Memory/facts
    schedule,     // Cron jobs
    calendar,     // Events
    tasks         // Todo list
  ]
});

// Tool names in SDK: mcp__<server>__<tool>
allowedTools: [
  'mcp__pocket-agent__browser',
  'mcp__pocket-agent__remember',
  // ...
]
```

---

## TL;DR: Effective SDK Usage Checklist

### ✅ Setup
- [ ] Set `cwd` for workspace isolation
- [ ] Use `allowedTools` for security
- [ ] Add context via `systemPrompt.append`
- [ ] Set `maxTurns` to prevent infinite loops

### ✅ Custom Tools
- [ ] Use Zod schemas for validation
- [ ] Wrap handlers with timeouts
- [ ] Return `{ content: [{ type: 'text', text: '...' }] }`
- [ ] Register via `createSdkMcpServer()`

### ✅ Runtime
- [ ] Process stream with `for await`
- [ ] Handle abort via `AbortController`
- [ ] Emit status events for UI
- [ ] Log tool calls for debugging

### ✅ Performance
- [ ] Use Haiku for simple tasks
- [ ] Implement smart context (not full history)
- [ ] Set thinking budgets appropriately
- [ ] Queue concurrent requests per session

### ✅ Architecture
- [ ] Singleton manager pattern
- [ ] Event-driven status updates
- [ ] Memory integration (save/retrieve context)
- [ ] Background tasks (embeddings, fact extraction)

---

## Real-World Example: Pocket Agent Flow

```typescript
// 1. User sends message
User: "Find all TODOs in my code and create a GitHub issue"

// 2. Agent Manager prepares context
const smartContext = await memory.getSmartContext(sessionId);
const prompt = buildPrompt(smartContext, userMessage);

// 3. SDK executes
const result = query({
  prompt,
  options: {
    model: 'claude-opus-4-5-20251101',
    cwd: projectRoot,
    tools: { type: 'preset', preset: 'claude_code' },
    mcpServers: { 'pocket-agent': customToolsServer },
    allowedTools: ['Grep', 'Read', 'Bash'],
    maxTurns: 20,
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: [identity, capabilities, facts].join('\n')
    }
  }
});

// 4. SDK auto-executes tool loop
Tool 1: Grep "TODO" → finds 12 matches
Tool 2: Read file1.ts → extract TODO details
Tool 3: Read file2.ts → extract TODO details
Tool 4: Bash "gh issue create" → create GitHub issue

// 5. Agent Manager saves to memory
memory.saveMessage('user', userMessage, sessionId);
memory.saveMessage('assistant', response, sessionId);
memory.embedMessage(msgId);  // Background

// 6. Return to user
Response: "Found 12 TODOs and created issue #123"
```

---

## Resources

- **SDK Docs**: [github.com/anthropics/anthropic-sdk-typescript](https://github.com/anthropics/anthropic-sdk-typescript)
- **MCP Spec**: [modelcontextprotocol.io](https://modelcontextprotocol.io)
- **Pocket Agent**: Example implementation with all patterns
- **Architecture**: See `ARCHITECTURE.md` for system design

---

**Master these patterns and you'll build powerful AI agents efficiently.** 🚀
