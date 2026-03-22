import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { WebSocketServer, type WebSocket } from "ws";

import { T3Code } from "../src/sdk.ts";

class FakeWsServer {
  readonly commands: Array<Record<string, unknown>> = [];
  readonly portPromise: Promise<number>;
  private readonly server = new WebSocketServer({ port: 0, host: "127.0.0.1" });

  constructor(private readonly response: Record<string, unknown> = { result: { sequence: 42 } }) {
    this.portPromise = new Promise((resolvePort) => {
      this.server.on("listening", () => {
        const address = this.server.address();
        if (!address || typeof address === "string") {
          throw new Error("failed to bind websocket test server");
        }
        resolvePort(address.port);
      });
    });
    this.server.on("connection", (socket: WebSocket) => {
      socket.on("message", (data: Buffer) => {
        const message = JSON.parse(data.toString("utf8")) as { id: string; body: { command: Record<string, unknown> } };
        this.commands.push(message.body.command);
        socket.send(JSON.stringify({ id: message.id, ...this.response }));
      });
    });
  }

  async close(): Promise<void> {
    await new Promise<void>((resolveClose, rejectClose) => {
      this.server.close((error?: Error) => {
        if (error) {
          rejectClose(error);
          return;
        }
        resolveClose();
      });
    });
  }
}

const tempRoots: string[] = [];

function makeSdk(): { sdk: T3Code; root: string; workspace: string; db_path: string } {
  const root = join(tmpdir(), `t3-code-cli-test-${Math.random().toString(36).slice(2)}`);
  const workspace = join(root, "workspace");
  const db_path = join(root, "state.sqlite");
  mkdirSync(workspace, { recursive: true });
  tempRoots.push(root);
  return { sdk: new T3Code(db_path), root, workspace, db_path };
}

afterEach(() => {
  for (const root of tempRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe("T3Code TypeScript SDK", () => {
  it("creates and reads projects", async () => {
    const { sdk, workspace } = makeSdk();
    const created = await sdk.projects.create({
      workspace_root: workspace,
      title: "Primary Project",
      default_model: "gpt-5.4",
      scripts: [
        {
          id: "test",
          name: "Run Tests",
          command: "pytest",
          icon: "test",
          runOnWorktreeCreate: false,
        },
      ],
    });

    const fetched = await sdk.projects.get(created.id);
    const listed = await sdk.projects.list();
    const byTitle = await sdk.projects.get_by_title("Primary Project");
    const byWorkspace = await sdk.projects.get_by_workspace_root(workspace);

    expect(fetched?.id).toBe(created.id);
    expect(fetched?.workspace_root).toBe(workspace);
    expect(fetched?.scripts[0]?.command).toBe("pytest");
    expect(listed).toHaveLength(1);
    expect(byTitle?.id).toBe(created.id);
    expect(byWorkspace?.id).toBe(created.id);
  });

  it("reuses an existing project via get_or_create", async () => {
    const { sdk, workspace } = makeSdk();
    const first = await sdk.projects.get_or_create({ workspace_root: workspace });
    const second = await sdk.projects.get_or_create({ workspace_root: workspace });

    expect(first.id).toBe(second.id);
    expect(await sdk.projects.list()).toHaveLength(1);
  });

  it("finds existing threads and chat history", async () => {
    const { sdk, workspace } = makeSdk();
    const project = await sdk.projects.create({ workspace_root: workspace, create_initial_thread: false });
    const thread = await sdk.projects.open(project.id).threads.create({ title: "Agent thread" });
    await sdk.threads.open(thread.id).messages.send("Build a changelog");
    await sdk.threads.open(thread.id).session.set({ status: "running", active_turn_id: "turn-1" });
    await sdk.threads.open(thread.id).messages.record_assistant({
      turn_id: "turn-1",
      text: "Created the changelog draft.",
    });

    const projectThreads = await sdk.projects.open(project.id).threads.list();
    const openedThread = await sdk.projects.open(project.id).threads.open(thread.id).get();
    const messages = await sdk.threads.open(thread.id).messages.list();

    expect(projectThreads).toHaveLength(1);
    expect(projectThreads[0]?.id).toBe(thread.id);
    expect(openedThread.id).toBe(thread.id);
    expect(messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    expect(messages[0]?.text).toBe("Build a changelog");
    expect(messages[1]?.text).toBe("Created the changelog draft.");
  });

  it("creates a project and thread and sends messages", async () => {
    const { sdk, workspace } = makeSdk();
    const project = await sdk.projects.create({ workspace_root: workspace, create_initial_thread: false });
    const thread = await sdk.projects.open(project.id).threads.create({
      title: "Execution",
      model: "gpt-5.4-mini",
      runtime_mode: "full-access",
      interaction_mode: "plan",
    });
    const message = await sdk.threads.open(thread.id).messages.send("Refactor the auth flow", {
      provider: "codex",
      model: "gpt-5.4-mini",
    });
    const session = await sdk.threads.open(thread.id).session.set({
      status: "running",
      provider_name: "codex",
      active_turn_id: "turn-auth-1",
    });
    const assistant = await sdk.threads.open(thread.id).messages.record_assistant({
      turn_id: "turn-auth-1",
      text: "I updated the auth flow and added tests.",
    });

    const refreshed = await sdk.threads.get(thread.id);

    expect(message.role).toBe("user");
    expect(session.active_turn_id).toBe("turn-auth-1");
    expect(assistant.role).toBe("assistant");
    expect(refreshed?.latest_turn?.turn_id).toBe("turn-auth-1");
    expect(refreshed?.messages.at(-1)?.text).toBe("I updated the auth flow and added tests.");
  });

  it("supports the direct model API", async () => {
    const { sdk, workspace } = makeSdk();
    const project = await sdk.projects.create({
      workspace_root: workspace,
      title: "t3sdk",
      create_initial_thread: false,
    });

    const foundProject = await sdk.find_project("t3sdk");
    const thread = await foundProject?.create_thread({ title: "Direct thread" });
    const userMessage = await thread?.send_message("Do the work");
    await thread?.set_session({ status: "running", provider_name: "codex", active_turn_id: "turn-1" });
    const assistantMessage = await thread?.record_assistant_message({ turn_id: "turn-1", text: "Done." });
    const foundThread = await foundProject?.find_thread("Direct thread");
    const allMessages = await foundThread?.get_messages();

    expect(project.id).toBe(foundProject?.id);
    expect(userMessage?.text).toBe("Do the work");
    expect(assistantMessage?.text).toBe("Done.");
    expect(allMessages?.map((message) => message.role)).toEqual(["user", "assistant"]);
  });

  it("searches and writes project files", async () => {
    const { sdk, workspace } = makeSdk();
    const project = await sdk.projects.create({ workspace_root: workspace, create_initial_thread: false });

    const initial = await sdk.projects.open(project.id).files.search_entries("main.py");
    const writeResult = await sdk.projects.open(project.id).files.write_file("src/main.py", "print('hello')\n");
    const afterWrite = await sdk.projects.open(project.id).files.search_entries("main.py");

    expect(initial.entries).toEqual([]);
    expect(writeResult.relative_path).toBe("src/main.py");
    expect(afterWrite.entries[0]?.path).toBe("src/main.py");
    expect(afterWrite.entries[0]?.kind).toBe("file");
  });

  it("handles plans, activities, approvals, and checkpoints", async () => {
    const { sdk, workspace } = makeSdk();
    const project = await sdk.projects.create({ workspace_root: workspace, create_initial_thread: false });
    const thread = await sdk.projects.open(project.id).threads.create({ title: "Workflow" });
    await sdk.threads.open(thread.id).messages.send("Implement the workflow");
    await sdk.threads.open(thread.id).session.set({ status: "running", active_turn_id: "turn-1" });
    await sdk.threads.open(thread.id).messages.record_assistant({
      turn_id: "turn-1",
      text: "Implementation in progress",
      streaming: true,
    });
    const plan = await sdk.threads.open(thread.id).proposed_plans.upsert("1. Add endpoint\n2. Add tests", {
      turn_id: "turn-1",
    });
    const pendingActivity = await sdk.threads.open(thread.id).activities.append({
      kind: "approval.requested",
      summary: "Need approval to run migrations",
      tone: "approval",
      turn_id: "turn-1",
      payload: { requestId: "approval-1", command: "alembic upgrade head" },
    });
    const approval = await sdk.threads.open(thread.id).approvals.respond("approval-1", "accept");
    const resolvedActivity = await sdk.threads.open(thread.id).activities.append({
      kind: "approval.resolved",
      summary: "Approval granted",
      tone: "approval",
      turn_id: "turn-1",
      payload: { requestId: "approval-1", decision: "accept" },
    });
    const checkpointTurn = await sdk.threads.open(thread.id).turns.complete_diff({
      turn_id: "turn-1",
      checkpoint_turn_count: 1,
      checkpoint_ref: "checkpoint-1",
      status: "ready",
      assistant_message_id: thread.id,
      files: [{ path: "src/app.py", kind: "file", additions: 12, deletions: 2 }],
    });

    const refreshed = await sdk.threads.get(thread.id);

    expect(plan.turn_id).toBe("turn-1");
    expect(pendingActivity.kind).toBe("approval.requested");
    expect(resolvedActivity.kind).toBe("approval.resolved");
    expect(approval.status).toBe("resolved");
    expect(checkpointTurn.checkpoint_ref).toBe("checkpoint-1");
    expect(refreshed?.pending_approvals[0]?.decision).toBe("accept");
    expect(refreshed?.checkpoints[0]?.files[0]?.path).toBe("src/app.py");
  });

  it("rejects invalid inputs", async () => {
    const { sdk, workspace } = makeSdk();
    const project = await sdk.projects.create({ workspace_root: workspace, create_initial_thread: false });
    const thread = await sdk.projects.open(project.id).threads.create({ title: "Validation" });

    await expect(sdk.projects.open(project.id).files.write_file("../outside.py", "bad")).rejects.toThrow(
      /relative_path must stay inside the project workspace/,
    );
    await expect(sdk.threads.open(thread.id).messages.send("")).rejects.toThrow(/text must be a non-empty string/);
    await expect(sdk.threads.open(thread.id).set_runtime_mode("unsafe-mode")).rejects.toThrow(/runtime_mode must be one of/);
    await expect(sdk.threads.open(thread.id).approvals.respond("approval-1", "yes")).rejects.toThrow(/decision must be one of/);
  });

  it("dispatches thread.run to a live server", async () => {
    const { workspace, db_path } = makeSdk();
    const server = new FakeWsServer();
    const port = await server.portPromise;
    const sdk = new T3Code(db_path, { server_url: `ws://127.0.0.1:${port}`, prefer_server: false });
    const project = await sdk.projects.create({ workspace_root: workspace, create_initial_thread: false });
    const thread = await project.create_thread({ title: "Live Thread" });
    const message = await thread.run("Execute the task", {
      provider: "codex",
      model: "gpt-5.4",
      timeout: 10,
    });

    expect(message.text).toBe("Execute the task");
    expect(server.commands).toHaveLength(1);
    expect(server.commands[0]?.type).toBe("thread.turn.start");
    expect(server.commands[0]?.threadId).toBe(thread.id);
    expect((server.commands[0]?.message as Record<string, unknown>).text).toBe("Execute the task");
    expect(server.commands[0]?.provider).toBe("codex");
    await server.close();
  });

  it("surfaces the local-only project mismatch for live thread creation", async () => {
    const { workspace, db_path } = makeSdk();
    const sdk = new T3Code(db_path);
    const project = await sdk.projects.create({ workspace_root: workspace, create_initial_thread: false });
    const server = new FakeWsServer({
      error: {
        message: `Error: Orchestration command invariant failed (thread.create): Project '${project.id}' does not exist for command 'thread.create'.`,
      },
    });
    const port = await server.portPromise;
    const liveSdk = new T3Code(db_path, { server_url: `ws://127.0.0.1:${port}` });
    const liveProject = await liveSdk.projects.get(project.id);

    await expect(liveProject?.create_thread({ title: "Live Thread", live: true }) as Promise<unknown>).rejects.toThrow(
      /Create the project with live=True, or disable live dispatch with live=False or T3Code\(..., prefer_server=False\)/,
    );
    await server.close();
  });

  it("enables prefer_server by default when server_url is set", async () => {
    const { db_path } = makeSdk();
    const server = new FakeWsServer();
    const port = await server.portPromise;
    const sdk = new T3Code(db_path, { server_url: `ws://127.0.0.1:${port}` });

    expect(sdk.prefer_server).toBe(true);
    await server.close();
  });
});
