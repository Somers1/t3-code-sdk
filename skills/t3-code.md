# T3 Code SDK — AI Agent Skill

You have access to the T3 Code Python SDK for managing coding agent sessions. Use this to spawn, monitor, and interact with coding agents (Claude Code / Codex) running in T3 Code.

## Installation

The SDK is available as `t3-code-sdk` (Python). Import with:
```python
from t3_code_sdk import T3Code
sdk = T3Code()  # defaults to ~/.t3/userdata/state.sqlite
```

Or with a live T3 server:
```python
sdk = T3Code(server_url="ws://127.0.0.1:3334")
```

## Core Operations

### Projects

```python
# List all projects
projects = sdk.projects.list()

# Find by name
project = sdk.find_project("sotto")

# Create a new project (creates with initial thread)
project = sdk.projects.get_or_create(
    workspace_root="/root/clawd/projects/sotto",
    title="sotto",
    default_model="claude-sonnet-4-6",
)

# Update project settings
project.update(default_model="claude-opus-4-6")

# Delete
project.delete()
```

### Threads (Coding Sessions)

Each thread is an independent coding session within a project.

```python
# Create a thread for a specific task
thread = project.create_thread(
    title="ticket-15: Implement JWT auth",
    model="claude-sonnet-4-6",
    runtime_mode="full-access",
)

# Find existing threads
threads = project.get_threads()
thread = project.find_thread("ticket-15")

# Get or create (idempotent)
thread = project.get_or_create_thread(title="ticket-15: Implement JWT auth")
```

### Running Coding Agents

```python
# Send a message and start the agent (requires live server)
message = thread.run(
    "Implement JWT authentication. Run tests before committing.",
    provider="claudeAgent",
    model="claude-sonnet-4-6",
)

# Send without running (local only — records the prompt)
message = thread.send_message("Implement JWT auth")

# Check session status
session = thread.get_session()
# session.status: idle | starting | running | ready | stopped | error

# Get agent output
messages = thread.get_messages()
activities = thread.get_activities()
```

### Monitoring Agent Runs

```python
# List all active sessions across all projects
active = sdk.list_active_sessions()

# Check if a thread's agent is still running
session = thread.get_session()
is_running = session and session.status in ("starting", "running")

# Get the latest messages (agent output)
messages = thread.get_messages()
last = messages[-1] if messages else None
```

### Providers

Two provider values:
- `"codex"` — OpenAI Codex
- `"claudeAgent"` — Anthropic Claude Code

### Models

Codex models: `gpt-5.4`, `gpt-5.4-mini`, `gpt-5.3-codex`, `gpt-5.2`
Claude models: `claude-opus-4-6`, `claude-sonnet-4-6`, `claude-haiku-4-5`

## Workflow: Spawn a Coding Agent for a Task

1. Find or create the project
2. Create a thread with the task title
3. Build a prompt with task description + project spec + constraints
4. Run the thread with the prompt
5. Check status on next heartbeat

```python
project = sdk.find_project("sotto")
thread = project.get_or_create_thread(title="ticket-15: Implement JWT auth")
thread.run(
    """## Task
    Implement JWT authentication for the API.

    ## Spec
    Replace session-based auth with JWT tokens...

    ## Constraints
    - Run all tests before committing
    - Work on branch: feature/jwt-auth
    - Use conventional commits
    """,
    provider="claudeAgent",
    model="claude-sonnet-4-6",
)
```

## File Helpers

```python
# Search project files
results = project.search_files("auth")

# Write a file
project.write_file("src/auth.ts", "// new auth module")
```
