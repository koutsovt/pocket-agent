# Pocket Agent Architecture

## 1. High-Level System Architecture

```mermaid
graph TB
    subgraph UserInterfaces[User Interfaces]
        UI[Desktop UI]
        Tray[System Tray]
        TG[Telegram Bot]
    end

    subgraph ElectronMain[Electron Main Process]
        Main[Main Process]
        Windows[Window Manager]
        IPC[IPC Handlers]
    end

    subgraph CoreAgent[Core Agent System]
        Agent[AgentManager]
        SDK[Claude Agent SDK]
        Config[Configuration]
    end

    subgraph Persistence[Persistence Layer]
        Memory[MemoryManager]
        SQLite[SQLite DB]
        Embeddings[Vector Embeddings]
        Facts[Facts Store]
    end

    subgraph Channels[Communication Channels]
        Desktop[Desktop Channel]
        Telegram[Telegram Channel]
        Router[Channel Router]
    end

    subgraph ToolSystem[Tool System]
        Tools[Tool Registry]
        MCP[MCP Servers]
        Browser[Browser Tools]
        System[System Tools]
        Schedule[Scheduler Tools]
    end

    subgraph External[External Services]
        Anthropic[Anthropic API]
        Chrome[Chrome CDP]
        TGBot[Telegram Bot API]
    end

    UI --> Main
    Tray --> Main
    TG --> Telegram

    Main --> IPC
    IPC --> Desktop
    IPC --> Telegram

    Desktop --> Router
    Telegram --> Router
    Router --> Agent

    Agent --> SDK
    Agent --> Config
    Agent --> Memory

    SDK --> Tools
    SDK --> Anthropic

    Memory --> SQLite
    Memory --> Embeddings
    Memory --> Facts

    Tools --> MCP
    MCP --> Browser
    MCP --> System
    MCP --> Schedule

    Browser --> Chrome
    Telegram --> TGBot

    style Agent fill:#e1f5ff
    style SDK fill:#fff3e0
    style Memory fill:#f3e5f5
    style Tools fill:#e8f5e9
```

## 2. Agent SDK Integration Flow

```mermaid
sequenceDiagram
    participant User
    participant Channel
    participant Agent as AgentManager
    participant Memory as MemoryManager
    participant SDK as Claude Agent SDK
    participant Tools as Tool System
    participant API as Anthropic API

    User->>Channel: Send message
    Channel->>Agent: processMessage(msg, channel, sessionId)

    Agent->>Memory: getSmartContext(sessionId)
    Memory-->>Agent: recent + summary + semantic matches

    Agent->>Memory: getFactsForContext()
    Memory-->>Agent: saved facts

    Agent->>SDK: query({ prompt, options })

    loop Multi-turn Tool Loop
        SDK->>API: POST /messages (streaming)
        API-->>SDK: Stream response chunks

        alt Tool Use Required
            SDK->>Agent: { type: 'assistant', tool_use }
            Agent->>Tools: Execute tool
            Tools-->>Agent: Tool result
            Agent->>SDK: Continue with result
            SDK->>API: POST with tool result
        end

        alt Text Response
            SDK-->>Agent: { type: 'assistant', text }
            Agent->>Channel: Emit status (thinking/tool_start/tool_end)
        end
    end

    SDK-->>Agent: Final response
    Agent->>Memory: saveMessage(user + assistant)
    Agent->>Memory: embedMessage() [background]
    Agent->>Channel: Return response
    Channel->>User: Display message
```

## 3. Tool System Architecture

```mermaid
graph TB
    subgraph ClaudeSDK[Claude Agent SDK]
        Query[query Function]
        Preset[claude_code Preset]
        MCPLoader[MCP Server Loader]
    end

    subgraph BuiltinTools[Built-in SDK Tools]
        Read[Read]
        Write[Write]
        Edit[Edit]
        Bash[Bash]
        Glob[Glob]
        Grep[Grep]
        WebSearch[WebSearch]
        WebFetch[WebFetch]
        Skill[Skill]
    end

    subgraph CustomMCP[Custom MCP Servers]
        subgraph InProcess[In-Process SDK MCP]
            BrowserTool[browser]
            NotifyTool[notify]
            PtyTool[pty_exec]
            MemTools[Memory Tools]
            SoulTools[Soul Tools]
            SchedTools[Scheduler Tools]
            CalTools[Calendar Tools]
            TaskTools[Task Tools]
        end

        subgraph ChildProcess[Child Process MCP]
            CompUse[computer]
            CustomMCP2[Custom MCP Servers]
        end
    end

    subgraph Handlers[Tool Handlers]
        BrowserMgr[BrowserManager]
        MacOS[macOS APIs]
        MemMgr[MemoryManager]
        CronMgr[CronManager]
    end

    Query --> Preset
    Query --> MCPLoader

    Preset --> Read
    Preset --> Write
    Preset --> Edit
    Preset --> Bash
    Preset --> Glob
    Preset --> Grep
    Preset --> WebSearch
    Preset --> WebFetch
    Preset --> Skill

    MCPLoader --> BrowserTool
    MCPLoader --> NotifyTool
    MCPLoader --> PtyTool
    MCPLoader --> MemTools
    MCPLoader --> SoulTools
    MCPLoader --> SchedTools
    MCPLoader --> CalTools
    MCPLoader --> TaskTools
    MCPLoader --> CompUse
    MCPLoader --> CustomMCP2

    BrowserTool --> BrowserMgr
    NotifyTool --> MacOS
    PtyTool --> MacOS
    MemTools --> MemMgr
    SoulTools --> MemMgr
    SchedTools --> CronMgr
    CalTools --> MemMgr
    TaskTools --> MemMgr

    style Preset fill:#fff3e0
    style MCPLoader fill:#e1f5ff
    style BrowserTool fill:#e8f5e9
    style MemTools fill:#f3e5f5
```

## 4. Memory & Context Management

```mermaid
graph LR
    subgraph Input[Input Processing]
        UserMsg[User Message]
        Query[Current Query]
    end

    subgraph Context[Context Retrieval]
        Recent[Recent Messages]
        Summary[Rolling Summary]
        Semantic[Semantic Retrieval]
        Facts[Facts Context]
        Soul[Soul Context]
        Logs[Daily Logs]
        Profile[User Profile]
    end

    subgraph Builder2[Smart Context Builder]
        Builder[Smart Context]
        Stats[Context Stats]
    end

    subgraph Prompt[System Prompt]
        Temporal[Temporal Context]
        Identity[Identity]
        Instructions[Instructions]
        Capabilities[Capabilities]
        SystemPrompt[Final System Prompt]
    end

    subgraph Query2[SDK Query]
        SDK[Claude Agent SDK]
        API[Anthropic API]
    end

    subgraph Response[Response Processing]
        Extract[Extract Facts]
        Save[Save Messages]
        Embed[Embed Messages]
    end

    UserMsg --> Query
    Query --> Recent
    Query --> Semantic

    Recent --> Builder
    Summary --> Builder
    Semantic --> Builder
    Facts --> Builder
    Soul --> Builder
    Logs --> Builder
    Profile --> Builder

    Builder --> Stats
    Stats --> SystemPrompt

    Temporal --> SystemPrompt
    Identity --> SystemPrompt
    Instructions --> SystemPrompt
    Capabilities --> SystemPrompt

    SystemPrompt --> SDK
    SDK --> API

    API --> Extract
    API --> Save
    Save --> Embed

    style Builder fill:#e1f5ff
    style SystemPrompt fill:#fff3e0
    style Facts fill:#f3e5f5
```

## 5. Browser Automation Architecture

```mermaid
graph TB
    subgraph Entry[Browser Tool Entry Point]
        Tool[browser Tool]
    end

    subgraph BrowserMgr[BrowserManager]
        Manager[Manager Singleton]
        Router{Requires Auth or CDP Action?}
    end

    subgraph ElectronTier[Electron Tier Default]
        EWindow[Hidden BrowserWindow]
        EChromium[Chromium Engine]
        EActions[Basic Actions]
    end

    subgraph CDPTier[CDP Tier Authenticated]
        CDP[Chrome DevTools Protocol]
        Chrome[Users Chrome]
        Tabs[Multi-tab Support]
        Auth[Logged-in Sessions]
        CDPActions[Tab Actions]
    end

    subgraph Cases[Use Cases]
        Simple[Simple Scraping]
        Complex[Authenticated Flows]
    end

    Tool --> Manager
    Manager --> Router

    Router -->|No Auth| EWindow
    Router -->|Auth Required| CDP

    EWindow --> EChromium
    EChromium --> EActions
    EActions --> Simple

    CDP --> Chrome
    Chrome --> Tabs
    Chrome --> Auth
    CDP --> CDPActions
    CDPActions --> Complex

    style Manager fill:#e1f5ff
    style EWindow fill:#e8f5e9
    style CDP fill:#fff3e0
```

## 6. Multi-Session Architecture

```mermaid
graph TB
    subgraph UI[User Interfaces]
        Desktop[Desktop UI]
        TGPrivate[Telegram Private]
        TGGroup1[Telegram Group 1]
        TGGroup2[Telegram Group 2]
    end

    subgraph Router2[Session Router]
        Router[Channel Router]
    end

    subgraph Agent2[AgentManager]
        Queue[Message Queue]
        Processing[Processing State]
    end

    subgraph Memory2[Memory Layer]
        Sessions[Sessions Table]
        Messages[Messages Table]
        Embeddings[Embeddings Table]
        Facts[Facts Table]
    end

    subgraph Contexts[Isolated Contexts]
        S1[Session work]
        S2[Session personal]
        S3[Session project-x]
        Shared[Shared Facts]
    end

    Desktop --> Router
    TGPrivate --> Router
    TGGroup1 --> Router
    TGGroup2 --> Router

    Router --> Queue
    Queue --> Processing

    Processing --> Sessions
    Sessions --> Messages
    Messages --> Embeddings

    Messages --> S1
    Messages --> S2
    Messages --> S3

    S1 --> Shared
    S2 --> Shared
    S3 --> Shared
    Shared --> Facts

    style Queue fill:#e1f5ff
    style Shared fill:#f3e5f5
```

## 7. Data Flow Summary

```mermaid
flowchart TD
    Start([User Input]) --> Channel{Channel Type}

    Channel -->|Desktop| DesktopChan[Desktop Channel]
    Channel -->|Telegram| TGChan[Telegram Channel]

    DesktopChan --> Router[Session Router]
    TGChan --> Router

    Router --> Queue{Already Processing?}
    Queue -->|Yes| QueueMsg[Queue Message]
    Queue -->|No| Execute[Execute Message]

    QueueMsg -.Wait.-> Execute

    Execute --> Memory[Get Smart Context]
    Memory --> Context[Build Context]

    Context --> Build[Build System Prompt]
    Build --> SDK[Call SDK query]

    SDK --> Stream{Stream Events}
    Stream -->|thinking| Status1[Emit thinking]
    Stream -->|tool_use| Status2[Emit tool_start]
    Stream -->|tool_result| Status3[Emit tool_end]
    Stream -->|text| Status4[Emit responding]
    Stream -->|done| Final[Final Response]

    Status1 --> UI[Update UI]
    Status2 --> UI
    Status3 --> UI
    Status4 --> UI

    Final --> Save[Save to Memory]
    Save --> Embed[Embed Messages]
    Save --> Extract[Extract Facts]

    Embed --> Done([Response to User])
    Extract --> Done

    Done --> NextQueue{Queue Empty?}
    NextQueue -->|No| Execute
    NextQueue -->|Yes| End([Wait for Next])

    style SDK fill:#fff3e0
    style Memory fill:#f3e5f5
    style Queue fill:#e1f5ff
```

## Key Architecture Principles

1. **Singleton Pattern**: AgentManager, MemoryManager, BrowserManager (one instance per app lifecycle)

2. **Event-Driven**: Status events flow from Agent → Channels → UI for real-time feedback

3. **Session Isolation**: Each session has independent message history, but shares facts

4. **Queue-Based**: Per-session message queues prevent concurrent SDK queries (API limitation)

5. **Lazy Loading**: SDK loaded dynamically via ESM imports for CommonJS compatibility

6. **Tool Composition**: Built-in SDK tools (claude_code preset) + Custom MCP servers

7. **Smart Context**: Token-aware context assembly (recent + summary + semantic + facts)

8. **Background Tasks**: Embeddings and fact extraction run asynchronously

9. **Provider Abstraction**: Supports multiple LLM providers (Anthropic, Moonshot) via env vars

10. **Two-Tier Browser**: Electron (simple) + CDP (authenticated) based on requirements
