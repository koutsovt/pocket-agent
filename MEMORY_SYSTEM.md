# Pocket Agent Memory System

## Overview

The Memory System is a **persistent, multi-layered storage architecture** that enables Pocket Agent to maintain long-term memory, context awareness, and semantic understanding across sessions. It transforms Claude from a stateless AI into a persistent assistant that remembers facts, learns preferences, and recalls relevant context.

---

## Architecture Layers

```
┌─────────────────────────────────────────────────────────┐
│                    Agent SDK Layer                      │
│              (Claude with Tool Access)                  │
└────────────────────┬────────────────────────────────────┘
                     │
                     ├─── MCP Tools: remember, forget, memory_search
                     │
┌────────────────────▼────────────────────────────────────┐
│                 MemoryManager Layer                     │
│           (Core persistence & retrieval)                │
└────────────────────┬────────────────────────────────────┘
                     │
          ┌──────────┼──────────┬──────────┬──────────┐
          │          │          │          │          │
     ┌────▼───┐ ┌───▼────┐ ┌───▼────┐ ┌───▼────┐ ┌──▼───┐
     │Messages│ │  Facts │ │ Embeds │ │  Soul  │ │ Logs │
     │ Table  │ │ Table  │ │ Table  │ │ Table  │ │Table │
     └────────┘ └────────┘ └────────┘ └────────┘ └──────┘
           SQLite Database (better-sqlite3)
```

---

## Key Benefits

### 1. **Persistent Context Across Sessions**
- **Traditional chatbots**: Forget everything when you close the app
- **Pocket Agent**: Remembers conversations, facts, and preferences forever

**Example:**
```
Session 1: "I prefer oat milk in my coffee"
[Agent remembers this fact]

Session 2 (next day): "Where can I get coffee?"
[Agent recalls preference] "Looking for a place with oat milk options?"
```

### 2. **Token-Efficient Context Management**
Instead of sending entire conversation history (expensive, limited), uses **Smart Context**:
- **Recent messages** (last 20 messages)
- **Rolling summaries** (compressed older conversations)
- **Semantic retrieval** (relevant past messages via embeddings)

**Savings:**
- Old approach: 50k tokens for 200-message conversation
- Smart Context: 8k tokens (recent + summary + relevant)
- **83% token reduction** = faster responses + lower costs

### 3. **Semantic Search & Retrieval**
Uses **vector embeddings** (OpenAI text-embedding-3-small) to find semantically similar content:

```typescript
// User asks: "What did I say about my job?"
// System embeds query → searches past messages/facts → finds:
[
  { content: "I work as a software engineer at Acme Corp", similarity: 0.89 },
  { content: "My manager's name is Sarah", similarity: 0.76 },
  { content: "We're migrating to microservices", similarity: 0.71 }
]
```

### 4. **Multi-Session Isolation**
- Desktop chat = `session: default`
- Telegram private = `session: telegram-123456`
- Telegram group = `session: project-alpha`

**Each session has:**
- Independent message history
- Own rolling summaries
- **Shared facts** (global knowledge base)

### 5. **Proactive Memory via MCP Tools**
Agent SDK **automatically decides** when to remember facts via tools:

```typescript
// User: "I live in San Francisco"
// Agent thinks: "This is important user info, I should remember it"
// Agent calls: remember("user_info", "location", "San Francisco")
```

---

## How It Works with Agent SDK

### Integration Flow

```typescript
// 1. Initialize Memory
const memory = new MemoryManager('/path/to/memory.db');
memory.initializeEmbeddings(OPENAI_API_KEY);
memory.setSummarizer(async (messages) => {
  // Uses Claude to summarize old conversations
  return await generateSummary(messages);
});

// 2. Provide Memory Tools to SDK
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk';

const memoryServer = createSdkMcpServer({
  name: 'memory',
  tools: [
    tool('remember', 'Save facts to long-term memory', schema, rememberHandler),
    tool('forget', 'Delete facts from memory', schema, forgetHandler),
    tool('memory_search', 'Search facts semantically', schema, searchHandler),
    tool('daily_log', 'Add entry to daily journal', schema, logHandler)
  ]
});

// 3. Process User Message
async function processMessage(userMsg, sessionId) {
  // Get smart context from memory
  const smartContext = await memory.getSmartContext(sessionId, {
    recentMessageLimit: 20,
    rollingSummaryInterval: 50,
    semanticRetrievalCount: 5,
    currentQuery: userMsg
  });

  // Build system prompt with memory context
  const systemPrompt = buildSystemPrompt(
    smartContext.recentMessages,      // Last 20 messages
    smartContext.rollingSummary,      // Compressed older messages
    smartContext.relevantMessages,    // Semantically similar past messages
    memory.getFactsForContext(),      // All saved facts
    memory.getSoulContext(),          // Agent's evolving personality
    memory.getDailyLogsContext()      // Recent daily activity
  );

  // Query SDK with memory-enriched context
  const result = query({
    prompt: userMsg,
    options: {
      systemPrompt: { type: 'preset', preset: 'claude_code', append: systemPrompt },
      mcpServers: { memory: memoryServer },
      allowedTools: ['remember', 'forget', 'memory_search', 'Read', 'Write', 'Bash']
    }
  });

  // Process stream
  let response = '';
  for await (const message of result) {
    if (message.type === 'assistant') {
      // Agent may call tools like:
      // - remember("user_info", "name", "John")
      // - memory_search("previous project discussions")
      response += extractText(message);
    }
  }

  // Save conversation to memory
  const userMsgId = memory.saveMessage('user', userMsg, sessionId);
  const assistantMsgId = memory.saveMessage('assistant', response, sessionId);

  // Embed messages asynchronously for future semantic search
  memory.embedMessage(userMsgId);  // Background task
  memory.embedMessage(assistantMsgId);

  return response;
}
```

---

## Smart Context Assembly

### The Problem
Claude has a 200k token context window, but:
- Long conversations exceed this limit
- Sending full history is expensive
- Recent context is more important than old

### The Solution: 3-Tier Context

```typescript
interface SmartContext {
  recentMessages: Message[];        // Last 20 messages (most important)
  rollingSummary: string | null;    // Compressed summary of older messages
  relevantMessages: Message[];      // Semantically relevant past messages
  totalTokens: number;              // Total context size
}
```

**How it works:**

```
Total Messages: 500
├─ Messages 1-450 → Rolling Summary (2k tokens)
│   "User discussed project requirements, asked about best practices,
│    decided to use React for frontend..."
│
├─ Messages 451-480 → Excluded (not recent enough)
│
├─ Messages 481-500 → Recent Context (4k tokens)
│   [Full message history]
│
└─ Semantic Search → Relevant Context (2k tokens)
    [Query: "What framework did we choose?"]
    → Message #235: "I think React is the best choice"
    → Message #402: "Let's go with React for type safety"

Final Context: 8k tokens (recent + summary + relevant)
```

**Benefits:**
- Maintains long-term continuity via summaries
- Prioritizes recent interactions
- Surfaces relevant old context via embeddings
- Token-efficient (stays under limits)

---

## Memory Tools (MCP Integration)

The agent has 5 memory tools exposed via MCP:

### 1. `remember` - Save Facts
```typescript
// Agent decides proactively to remember
remember({
  category: 'user_info',      // user_info, preferences, projects, people, work, notes, decisions
  subject: 'birthday',
  content: 'March 15, 1990'
});

// Stored in facts table + embedded for semantic search
```

### 2. `forget` - Delete Facts
```typescript
forget({
  category: 'preferences',
  subject: 'coffee'
});
// OR
forget({ id: 42 });
```

### 3. `memory_search` - Semantic + Keyword Hybrid Search
```typescript
memory_search({ query: "user's work projects" });
// Returns:
// [
//   { subject: "website_redesign", score: 0.85, content: "..." },
//   { subject: "api_migration", score: 0.71, content: "..." }
// ]
```

**Hybrid scoring:**
- 70% vector similarity (embedding cosine similarity)
- 30% keyword match (SQLite FTS5 BM25)
- Returns top 6 results above 0.35 threshold

### 4. `daily_log` - Activity Journal
```typescript
daily_log({ entry: "Discussed project timeline - moved deadline to Friday" });
// Stored per-day, timestamped, included in context
```

### 5. `list_facts` - Retrieve All Facts
```typescript
list_facts({ category: 'projects' });  // Optional filter
// Returns all facts for review
```

---

## Database Schema

### Core Tables

**messages** - Conversation history (per-session)
```sql
CREATE TABLE messages (
  id INTEGER PRIMARY KEY,
  role TEXT,              -- 'user' | 'assistant' | 'system'
  content TEXT,
  timestamp TEXT,
  token_count INTEGER,
  session_id TEXT,        -- Session isolation
  metadata TEXT           -- JSON: { source, hasAttachment, etc }
);
```

**facts** - Long-term knowledge base (global)
```sql
CREATE TABLE facts (
  id INTEGER PRIMARY KEY,
  category TEXT,          -- user_info, preferences, projects, etc
  subject TEXT,           -- Short identifier
  content TEXT,           -- The actual fact
  created_at TEXT,
  updated_at TEXT
);
```

**message_embeddings** - Semantic search vectors
```sql
CREATE TABLE message_embeddings (
  id INTEGER PRIMARY KEY,
  message_id INTEGER UNIQUE,
  embedding BLOB,         -- 1536-dim vector (text-embedding-3-small)
  created_at TEXT
);
```

**chunks** - Fact embeddings
```sql
CREATE TABLE chunks (
  id INTEGER PRIMARY KEY,
  fact_id INTEGER,
  content TEXT,
  embedding BLOB          -- Vector for semantic fact search
);
```

**rolling_summaries** - Compressed conversation history
```sql
CREATE TABLE rolling_summaries (
  id INTEGER PRIMARY KEY,
  session_id TEXT,
  start_message_id INTEGER,
  end_message_id INTEGER,
  content TEXT,           -- AI-generated summary
  token_count INTEGER
);
```

**soul** - Agent's evolving personality/identity
```sql
CREATE TABLE soul (
  id INTEGER PRIMARY KEY,
  aspect TEXT UNIQUE,     -- 'communication_style', 'values', etc
  content TEXT,
  created_at TEXT,
  updated_at TEXT
);
```

**daily_logs** - Activity journal
```sql
CREATE TABLE daily_logs (
  id INTEGER PRIMARY KEY,
  date TEXT UNIQUE,       -- YYYY-MM-DD
  content TEXT,           -- Timestamped log entries
  updated_at TEXT
);
```

**sessions** - Multi-session support
```sql
CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT,
  updated_at TEXT
);
```

---

## Embedding System

### How Embeddings Work

**Text → Vector → Semantic Similarity**

```typescript
// 1. Generate embedding for text
const embedding = await embed("I love coffee with oat milk");
// Returns: [0.123, -0.456, 0.789, ... ] (1536 numbers)

// 2. Store in SQLite as BLOB
const buffer = serializeEmbedding(embedding);
db.run('INSERT INTO message_embeddings VALUES (?, ?)', [msgId, buffer]);

// 3. Search: embed query and compare
const queryEmbedding = await embed("user's coffee preference");
const results = db.all('SELECT * FROM message_embeddings');

for (const row of results) {
  const storedEmbedding = deserializeEmbedding(row.embedding);
  const similarity = cosineSimilarity(queryEmbedding, storedEmbedding);
  // similarity = 0.87 (high match!) → surface this message
}
```

**Why embeddings?**
- Keyword search: "coffee" only matches "coffee"
- Embedding search: "coffee" matches "latte", "espresso", "caffeine", "morning drink"

### Automatic Embedding Pipeline

```typescript
// After saving message
const msgId = memory.saveMessage('user', content, sessionId);

// Background: embed for future semantic search
memory.embedMessage(msgId).catch(err => {
  console.error('Failed to embed:', err);
});
```

**Embedding happens:**
- After every user/assistant message (background)
- When new facts are saved
- Batch backfill for old messages on startup

---

## Rolling Summaries

### Problem: Old Messages Exceed Context Window

```
User: [message 1]
User: [message 2]
...
User: [message 500]  ← Can't send all to Claude
```

### Solution: Incremental Summarization

```typescript
// Every 50 messages, create summary
async getOrCreateRollingSummary(beforeMessageId, sessionId) {
  // Check for existing summary
  const lastSummary = db.get('SELECT * FROM rolling_summaries WHERE end_message_id < ?');

  if (lastSummary) {
    // Get unsummarized messages since last summary
    const newMessages = db.all('SELECT * FROM messages WHERE id > ?', lastSummary.end_message_id);

    if (newMessages.length >= 50) {
      // Summarize with context
      const summary = await this.summarizer([
        { role: 'system', content: `Previous: ${lastSummary.content}` },
        ...newMessages
      ]);

      // Save new rolling summary
      db.run('INSERT INTO rolling_summaries VALUES (?, ?, ?)',
        [sessionId, newMessages[0].id, newMessages[49].id, summary]
      );

      // Return combined summary
      return `${lastSummary.content}\n\n${summary}`;
    }
  }

  return lastSummary?.content || null;
}
```

**Result:**
- Messages 1-50: "User discussed project setup, chose React..."
- Messages 51-100: "Implemented auth flow, added JWT..."
- Messages 101-150: "Refactored API, added tests..."

Entire 500-message conversation → 3 summaries (~6k tokens)

---

## Facts System

### Categories

```typescript
const CATEGORIES = [
  'user_info',      // Personal details (name, location, birthday)
  'preferences',    // Likes, dislikes, communication style
  'projects',       // Work projects, deadlines, requirements
  'people',         // Friends, colleagues, relationships
  'work',          // Job, company, role
  'notes',         // General notes, ideas
  'decisions'      // Commitments, choices made
];
```

### Fact Storage & Retrieval

**Save:**
```typescript
// Agent calls via MCP tool
memory.saveFact('user_info', 'name', 'John Doe');

// Internally:
// 1. Insert/update in facts table
// 2. Embed fact content
// 3. Store embedding in chunks table
// 4. Invalidate facts context cache
```

**Search:**
```typescript
// Hybrid search (70% semantic + 30% keyword)
const results = await memory.searchFactsHybrid('user job');

// Returns:
[
  { fact: { category: 'work', subject: 'job_title', content: 'Software Engineer' },
    score: 0.82,
    vectorScore: 0.85,
    keywordScore: 0.75
  }
]
```

**Context Injection:**
```typescript
// Facts automatically included in every agent query
const factsContext = memory.getFactsForContext();

/*
## Known Facts

### user_info
- **name**: John Doe
- **location**: San Francisco
- **birthday**: March 15, 1990

### preferences
- **coffee**: Prefers oat milk lattes
- **communication**: Direct, no small talk
*/

// This context is added to system prompt → agent knows these facts
```

---

## Soul System

**Purpose:** Agent's evolving personality/identity

Unlike facts (about the user), soul aspects are **about the agent itself**.

```typescript
// Agent learns/adapts over time
memory.setSoulAspect('communication_style', 'Friendly but concise, uses emojis sparingly');
memory.setSoulAspect('humor', 'Dry wit, occasionally sarcastic');
memory.setSoulAspect('values', 'Privacy-focused, transparent about limitations');

// Injected into every query
const soulContext = memory.getSoulContext();
/*
## Soul

### communication_style
Friendly but concise, uses emojis sparingly

### humor
Dry wit, occasionally sarcastic

### values
Privacy-focused, transparent about limitations
*/
```

**Use case:** Agent personality consistency across sessions

---

## Daily Logs

**Purpose:** Activity journal for continuity

```typescript
// Throughout the day
memory.appendToDailyLog("User asked about project status");
memory.appendToDailyLog("Triggered reminder: Team meeting at 3pm");
memory.appendToDailyLog("Completed website redesign task");

// Next session
const logsContext = memory.getDailyLogsContext(3); // Last 3 days
/*
## Recent Daily Logs

### Today
[09:15] User asked about project status
[14:45] Triggered reminder: Team meeting at 3pm
[16:30] Completed website redesign task

### 2026-01-30
[10:00] Morning check-in
[15:20] Discussed API migration plan
*/
```

**Benefit:** Agent knows what happened recently, even across sessions

---

## Performance Optimizations

### 1. **Caching**
```typescript
// Facts context cached until facts change
private factsContextCache: string | null = null;
private factsContextCacheValid: boolean = false;

getFactsForContext(): string {
  if (this.factsContextCacheValid) {
    return this.factsContextCache!;
  }
  // Rebuild cache
  const facts = this.getAllFacts();
  this.factsContextCache = formatFacts(facts);
  this.factsContextCacheValid = true;
  return this.factsContextCache;
}

// Cache invalidated on fact changes
saveFact(...) {
  db.run('INSERT INTO facts ...');
  this.factsContextCacheValid = false;
}
```

### 2. **Async Embeddings**
```typescript
// Don't block response waiting for embeddings
memory.saveMessage('user', content, sessionId);
memory.saveMessage('assistant', response, sessionId);

// Embed in background
memory.embedMessage(userMsgId).catch(err => console.error(err));
memory.embedMessage(assistantMsgId).catch(err => console.error(err));
```

### 3. **Index Optimization**
```sql
CREATE INDEX idx_messages_session ON messages(session_id, timestamp);
CREATE INDEX idx_message_embeddings_message ON message_embeddings(message_id);
CREATE INDEX idx_rolling_summaries_session ON rolling_summaries(session_id, end_message_id);
CREATE INDEX idx_facts_category ON facts(category);

-- Full-text search index
CREATE VIRTUAL TABLE facts_fts USING fts5(category, subject, content);
```

### 4. **Query Limits**
```typescript
// Prevent loading entire DB into memory
const MAX_MESSAGES_TO_FETCH = 1000;
const MAX_SEMANTIC_COMPARISONS = 200;
const MAX_KEYWORD_COMPARISONS = 15000;

// Paginate large result sets
const recentMessages = db.all('SELECT * FROM messages ORDER BY id DESC LIMIT ?', [MAX_MESSAGES_TO_FETCH]);
```

---

## Key Architectural Decisions

### Why SQLite?
- **Simple deployment**: Single file, no server
- **Portable**: Works on macOS/Windows/Linux
- **Fast**: In-process, no network overhead
- **Reliable**: ACID transactions
- **FTS5**: Built-in full-text search

### Why OpenAI Embeddings (not Claude)?
- OpenAI embedding models are:
  - **Faster**: text-embedding-3-small (10ms vs 500ms)
  - **Cheaper**: $0.00002/1k tokens vs Claude API
  - **Purpose-built**: Optimized for semantic search
- Claude is better for reasoning, OpenAI for embeddings

### Why Hybrid Search?
```
Scenario 1: User asks "coffee preference"
- Vector search: Finds "oat milk latte" (semantically similar)
- Keyword search: Matches "coffee" directly
- Hybrid: Best of both → perfect results

Scenario 2: User asks "API migration project"
- Vector search: Finds related concepts (backend, refactor)
- Keyword search: Exact matches "API migration"
- Hybrid: Precision + recall
```

### Why Rolling Summaries (not RAG)?
- **RAG approach**: Chunk messages → embed → retrieve top-k
  - ❌ Loses chronological narrative
  - ❌ Misses subtle context between messages
  - ❌ Requires careful chunking strategy

- **Rolling summaries**: Compress while preserving narrative
  - ✅ Maintains conversation flow
  - ✅ AI-generated summaries capture nuance
  - ✅ Recent messages preserved verbatim
  - ✅ Older context compressed incrementally

---

## Example: Full Conversation Flow

```typescript
// User: "I'm working on a new website project"

// 1. Agent processes message
const smartContext = await memory.getSmartContext('default', {
  recentMessageLimit: 20,
  semanticRetrievalCount: 5,
  currentQuery: "I'm working on a new website project"
});

// 2. Smart context retrieved:
// - Recent: Last 20 messages
// - Summary: "User previously discussed frontend frameworks, prefers React..."
// - Relevant: Message #134: "I love working on web projects"

// 3. Facts context:
// - [work] job_title: Software Engineer
// - [preferences] framework: React
// - [projects] current_project: None

// 4. Agent SDK receives enriched context
const systemPrompt = `
${smartContext.rollingSummary}

Recent messages:
${smartContext.recentMessages.join('\n')}

Relevant past context:
${smartContext.relevantMessages.join('\n')}

${memory.getFactsForContext()}
${memory.getSoulContext()}
`;

// 5. Agent responds with context awareness
Agent: "Great! Since you prefer React, should we use it for this project too?"

// 6. Agent proactively calls remember tool
remember({
  category: 'projects',
  subject: 'website_project',
  content: 'New website project started'
});

// 7. Messages saved
memory.saveMessage('user', "I'm working on a new website project", 'default');
memory.saveMessage('assistant', "Great! Since you prefer React...", 'default');

// 8. Background embedding
memory.embedMessage(userMsgId);
memory.embedMessage(assistantMsgId);

// Next day, user asks: "What was I working on yesterday?"
// Agent searches memory → finds website project fact + embedded messages → recalls perfectly
```

---

## Benefits Summary

| Feature | Without Memory | With Memory System |
|---------|---------------|-------------------|
| **Context Retention** | Forgets after session | Remembers forever |
| **Token Usage** | 50k+ tokens for long chats | 8k tokens (smart context) |
| **Search** | Can't search past conversations | Semantic + keyword hybrid search |
| **Facts** | Must repeat info every session | Learns once, remembers forever |
| **Continuity** | Starts fresh each time | Maintains narrative across sessions |
| **Personalization** | Generic responses | Tailored to user preferences |
| **Cost** | High (full history in context) | Low (compressed summaries) |

---

## Integration with Agent SDK

### Key Connection Points

**1. System Prompt Enrichment**
```typescript
query({
  prompt: userMessage,
  options: {
    systemPrompt: {
      type: 'preset',
      preset: 'claude_code',
      append: [
        smartContext.rollingSummary,
        memory.getFactsForContext(),
        memory.getSoulContext(),
        memory.getDailyLogsContext()
      ].join('\n\n')
    }
  }
});
```

**2. MCP Tool Integration**
```typescript
const memoryServer = createSdkMcpServer({
  name: 'memory',
  tools: [rememberTool, forgetTool, searchTool, logTool]
});

query({
  options: {
    mcpServers: { memory: memoryServer },
    allowedTools: ['remember', 'forget', 'memory_search', ...]
  }
});
```

**3. Post-Processing**
```typescript
for await (const message of result) {
  // Agent uses tools autonomously
  if (message.type === 'tool_use' && message.name === 'remember') {
    // Memory system handles storage + embedding
  }
}

// After response, save to memory
memory.saveMessage('user', userMsg, sessionId);
memory.saveMessage('assistant', response, sessionId);
```

---

## Conclusion

The Memory System transforms Pocket Agent from a **stateless chatbot** into a **persistent AI assistant** by:

1. **Storing** conversations, facts, and context in SQLite
2. **Embedding** content for semantic search
3. **Compressing** old conversations via rolling summaries
4. **Retrieving** relevant context via hybrid search
5. **Exposing** memory operations as MCP tools to the Agent SDK

**Result:** Claude becomes an assistant that:
- ✅ Remembers who you are
- ✅ Recalls past conversations
- ✅ Learns your preferences
- ✅ Maintains continuity across sessions
- ✅ Proactively saves important information
- ✅ Retrieves relevant context on demand

All while staying **token-efficient**, **fast**, and **intelligent**.
