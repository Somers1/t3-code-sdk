import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";

export const DEFAULT_DB_PATH = join(homedir(), ".t3", "userdata", "state.sqlite");
export const DEFAULT_MODEL = "gpt-5.4";
export const DEFAULT_RUNTIME_MODE = "full-access";
export const DEFAULT_INTERACTION_MODE = "default";
export const DEFAULT_PROVIDER = "codex";
export const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered";

const MAX_SEARCH_LIMIT = 200;
const MAX_QUERY_LENGTH = 256;
const MAX_PATH_LENGTH = 512;
const MAX_INPUT_CHARS = 120_000;
const MAX_ATTACHMENTS = 8;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

const RUNTIME_MODES = new Set(["approval-required", "full-access"]);
const INTERACTION_MODES = new Set(["default", "plan"]);
const PROVIDERS = new Set(["codex", "claudeAgent"]);
const ASSISTANT_DELIVERY_MODES = new Set(["buffered", "streaming"]);
const APPROVAL_DECISIONS = new Set(["accept", "acceptForSession", "decline", "cancel"]);
const SESSION_STATUSES = new Set(["idle", "starting", "running", "ready", "interrupted", "stopped", "error"]);
const ACTIVITY_TONES = new Set(["info", "tool", "approval", "error"]);
const PROJECT_SCRIPT_ICONS = new Set(["play", "test", "lint", "configure", "build", "debug"]);
const PROJECTOR_NAMES = [
  "projection.projects",
  "projection.threads",
  "projection.thread-messages",
  "projection.thread-proposed-plans",
  "projection.thread-activities",
  "projection.thread-sessions",
  "projection.thread-turns",
  "projection.checkpoints",
  "projection.pending-approvals",
] as const;

type JsonMap = Record<string, unknown>;
type Row = Record<string, unknown>;

function utcNow(): string {
  return new Date().toISOString();
}

function newId(): string {
  return randomUUID();
}

function trimmed(value: unknown, name: string, options: { allowEmpty?: boolean; maxLength?: number } = {}): string {
  if (typeof value !== "string") {
    throw new TypeError(`${name} must be a string`);
  }
  const normalized = value.trim();
  if (!options.allowEmpty && normalized.length === 0) {
    throw new Error(`${name} must be a non-empty string`);
  }
  if (options.maxLength !== undefined && normalized.length > options.maxLength) {
    throw new Error(`${name} must be at most ${options.maxLength} characters`);
  }
  return normalized;
}

function optionalTrimmed(value: unknown, name: string, maxLength?: number): string | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  return maxLength === undefined ? trimmed(value, name) : trimmed(value, name, { maxLength });
}

function validateEnum<T extends string>(value: unknown, name: string, allowed: Set<T>): T {
  const normalized = trimmed(value, name) as T;
  if (!allowed.has(normalized)) {
    throw new Error(`${name} must be one of: ${[...allowed].sort().join(", ")}`);
  }
  return normalized;
}

function validateJsonMapping(value: unknown, name: string): JsonMap | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${name} must be a dictionary`);
  }
  return value as JsonMap;
}

function jsonLoads<T>(value: unknown, fallback: T): T {
  if (typeof value !== "string" || value.length === 0) {
    return fallback;
  }
  return JSON.parse(value) as T;
}

function coercePath(value: string): string {
  return resolve(value.replace(/^~(?=$|\/)/, homedir()));
}

function relativePath(root: string, input: string): string {
  const normalized = trimmed(input, "relative_path", { maxLength: MAX_PATH_LENGTH });
  const candidate = resolve(root, normalized);
  if (!candidate.startsWith(`${root}/`) && candidate !== root) {
    throw new Error("relative_path must stay inside the project workspace");
  }
  return candidate;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export interface ProjectScript {
  id: string;
  name: string;
  command: string;
  icon: string;
  run_on_worktree_create: boolean;
}

export interface ProjectEntry {
  path: string;
  kind: string;
  parent_path: string | undefined;
}

export interface ProjectSearchResult {
  entries: ProjectEntry[];
  truncated: boolean;
}

export interface FileWriteResult {
  relative_path: string;
}

export interface ImageAttachment {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  type: string;
}

export interface Message {
  id: string;
  thread_id: string;
  turn_id: string | undefined;
  role: string;
  text: string;
  attachments: ImageAttachment[];
  streaming: boolean;
  created_at: string;
  updated_at: string;
}

export interface ProposedPlan {
  id: string;
  thread_id: string;
  turn_id: string | undefined;
  plan_markdown: string;
  implemented_at: string | undefined;
  implementation_thread_id: string | undefined;
  created_at: string;
  updated_at: string;
}

export interface ThreadActivity {
  id: string;
  thread_id: string;
  tone: string;
  kind: string;
  summary: string;
  payload: JsonMap;
  turn_id: string | undefined;
  sequence: number | undefined;
  created_at: string;
}

export interface Session {
  thread_id: string;
  status: string;
  provider_name: string | undefined;
  runtime_mode: string;
  active_turn_id: string | undefined;
  last_error: string | undefined;
  updated_at: string;
}

export interface CheckpointFile {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
}

export interface CheckpointSummary {
  turn_id: string;
  checkpoint_turn_count: number;
  checkpoint_ref: string;
  status: string;
  files: CheckpointFile[];
  assistant_message_id: string | undefined;
  completed_at: string;
}

export interface LatestTurn {
  turn_id: string;
  state: string;
  requested_at: string;
  started_at: string | undefined;
  completed_at: string | undefined;
  assistant_message_id: string | undefined;
  source_proposed_plan_thread_id: string | undefined;
  source_proposed_plan_id: string | undefined;
}

export interface PendingApproval {
  request_id: string;
  thread_id: string;
  turn_id: string | undefined;
  status: string;
  decision: string | undefined;
  created_at: string;
  resolved_at: string | undefined;
}

export interface Turn {
  thread_id: string;
  turn_id: string | undefined;
  pending_message_id: string | undefined;
  source_proposed_plan_thread_id: string | undefined;
  source_proposed_plan_id: string | undefined;
  assistant_message_id: string | undefined;
  state: string;
  requested_at: string;
  started_at: string | undefined;
  completed_at: string | undefined;
  checkpoint_turn_count: number | undefined;
  checkpoint_ref: string | undefined;
  checkpoint_status: string | undefined;
  checkpoint_files: CheckpointFile[];
}

export interface DispatchReceipt {
  command_id: string;
  sequence: number;
}

interface AttachmentInput {
  type?: string;
  id?: string;
  name?: string;
  mimeType?: string;
  sizeBytes?: number;
  dataUrl?: string;
}

function validateAttachments(attachments?: unknown): Array<Record<string, unknown>> {
  if (attachments === undefined || attachments === null) {
    return [];
  }
  if (!Array.isArray(attachments)) {
    throw new TypeError("attachments must be an iterable of dictionaries");
  }
  const normalized = attachments.map((attachment, index) => {
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) {
      throw new TypeError(`attachments[${index}] must be a dictionary`);
    }
    const input = attachment as AttachmentInput;
    const attachmentType = validateEnum(input.type ?? "image", "attachment.type", new Set(["image"]));
    const name = trimmed(input.name ?? "", "attachment.name", { maxLength: 255 });
    const mimeType = trimmed(input.mimeType ?? "", "attachment.mimeType", { maxLength: 100 });
    if (!mimeType.toLowerCase().startsWith("image/")) {
      throw new Error("attachment.mimeType must start with 'image/'");
    }
    if (!Number.isInteger(input.sizeBytes) || (input.sizeBytes ?? -1) < 0 || (input.sizeBytes ?? 0) > MAX_IMAGE_BYTES) {
      throw new Error(`attachment.sizeBytes must be an integer between 0 and ${MAX_IMAGE_BYTES}`);
    }
    return {
      type: attachmentType,
      id: trimmed(input.id ?? newId(), "attachment.id", { maxLength: 128 }),
      name,
      mimeType,
      sizeBytes: input.sizeBytes,
    };
  });
  if (normalized.length > MAX_ATTACHMENTS) {
    throw new Error(`attachments cannot contain more than ${MAX_ATTACHMENTS} items`);
  }
  return normalized;
}

function validateLiveAttachments(attachments?: unknown): Array<Record<string, unknown>> {
  if (attachments === undefined || attachments === null) {
    return [];
  }
  if (!Array.isArray(attachments)) {
    throw new TypeError("attachments must be an iterable of dictionaries");
  }
  const normalized = attachments.map((attachment, index) => {
    if (typeof attachment !== "object" || attachment === null || Array.isArray(attachment)) {
      throw new TypeError(`attachments[${index}] must be a dictionary`);
    }
    const input = attachment as AttachmentInput;
    const type = validateEnum(input.type ?? "image", "attachment.type", new Set(["image"]));
    const name = trimmed(input.name ?? "", "attachment.name", { maxLength: 255 });
    const mimeType = trimmed(input.mimeType ?? "", "attachment.mimeType", { maxLength: 100 });
    const dataUrl = trimmed(input.dataUrl ?? "", "attachment.dataUrl");
    if (!Number.isInteger(input.sizeBytes) || (input.sizeBytes ?? -1) < 0 || (input.sizeBytes ?? 0) > MAX_IMAGE_BYTES) {
      throw new Error(`attachment.sizeBytes must be an integer between 0 and ${MAX_IMAGE_BYTES}`);
    }
    return {
      type,
      name,
      mimeType,
      sizeBytes: input.sizeBytes,
      dataUrl,
    };
  });
  if (normalized.length > MAX_ATTACHMENTS) {
    throw new Error(`attachments cannot contain more than ${MAX_ATTACHMENTS} items`);
  }
  return normalized;
}

function validateScripts(scripts?: unknown): Array<Record<string, unknown>> {
  if (scripts === undefined || scripts === null) {
    return [];
  }
  if (!Array.isArray(scripts)) {
    throw new TypeError("scripts must be an iterable of dictionaries");
  }
  return scripts.map((script, index) => {
    if (typeof script !== "object" || script === null || Array.isArray(script)) {
      throw new TypeError(`scripts[${index}] must be a dictionary`);
    }
    const item = script as Record<string, unknown>;
    const runOnWorktreeCreate = item.runOnWorktreeCreate;
    if (typeof runOnWorktreeCreate !== "boolean") {
      throw new TypeError("script.runOnWorktreeCreate must be a boolean");
    }
    return {
      id: trimmed(item.id ?? "", "script.id"),
      name: trimmed(item.name ?? "", "script.name"),
      command: trimmed(item.command ?? "", "script.command"),
      icon: validateEnum(item.icon ?? "", "script.icon", PROJECT_SCRIPT_ICONS),
      runOnWorktreeCreate,
    };
  });
}

function checkpointFilesFromJson(value: unknown): CheckpointFile[] {
  return jsonLoads<Array<Record<string, unknown>>>(value, []).map((item) => ({
    path: String(item.path ?? ""),
    kind: String(item.kind ?? ""),
    additions: Number(item.additions ?? 0),
    deletions: Number(item.deletions ?? 0),
  }));
}

function imageAttachmentsFromJson(value: unknown): ImageAttachment[] {
  return jsonLoads<Array<Record<string, unknown>>>(value, []).map((item) => ({
    id: String(item.id ?? ""),
    name: String(item.name ?? ""),
    mime_type: String(item.mimeType ?? ""),
    size_bytes: Number(item.sizeBytes ?? 0),
    type: String(item.type ?? "image"),
  }));
}

export class ProjectModel {
  constructor(
    public id: string,
    public title: string,
    public workspace_root: string,
    public default_model: string | undefined,
    public scripts: ProjectScript[],
    public created_at: string,
    public updated_at: string,
    public deleted_at: string | undefined,
    private readonly _sdk: T3Code,
  ) {}

  async refresh(): Promise<ProjectModel> {
    return this._sdk._require_project(this.id);
  }

  async update(options: {
    title?: string;
    workspace_root?: string;
    default_model?: string;
    scripts?: unknown[];
  }): Promise<ProjectModel> {
    return this._sdk.projects.update(this.id, options);
  }

  async delete(): Promise<void> {
    return this._sdk.projects.delete(this.id);
  }

  async create_thread(options: {
    title?: string;
    model?: string;
    runtime_mode?: string;
    interaction_mode?: string;
    branch?: string | undefined;
    worktree_path?: string | undefined;
    live?: boolean | undefined;
    timeout?: number | undefined;
  } = {}): Promise<ThreadModel> {
    return this._sdk.projects.open(this.id).threads.create(options);
  }

  async get_threads(options: { include_deleted?: boolean } = {}): Promise<ThreadModel[]> {
    return this._sdk.projects.open(this.id).threads.list(options);
  }

  async get_thread(thread_id: string, options: { include_deleted?: boolean } = {}): Promise<ThreadModel | undefined> {
    return this._sdk.projects.open(this.id).threads.get(thread_id, options);
  }

  async find_thread(title: string, options: { include_deleted?: boolean } = {}): Promise<ThreadModel | undefined> {
    const normalized = trimmed(title, "title");
    const threads = await this.get_threads(options);
    return threads.find((thread) => thread.title === normalized);
  }

  async get_or_create_thread(options: { title: string; model?: string }): Promise<ThreadModel> {
    return this._sdk.projects.open(this.id).threads.get_or_create(options);
  }

  async search_entries(query: string, options: { limit?: number } = {}): Promise<ProjectSearchResult> {
    return this._sdk.projects.open(this.id).files.search_entries(query, options);
  }

  async write_file(relative_path: string, contents: string): Promise<FileWriteResult> {
    return this._sdk.projects.open(this.id).files.write_file(relative_path, contents);
  }
}

export class ThreadModel {
  constructor(
    public id: string,
    public project_id: string,
    public title: string,
    public model: string,
    public runtime_mode: string,
    public interaction_mode: string,
    public branch: string | undefined,
    public worktree_path: string | undefined,
    public latest_turn: LatestTurn | undefined,
    public messages: Message[],
    public proposed_plans: ProposedPlan[],
    public activities: ThreadActivity[],
    public checkpoints: CheckpointSummary[],
    public turns: Turn[],
    public pending_approvals: PendingApproval[],
    public session: Session | undefined,
    public created_at: string,
    public updated_at: string,
    public deleted_at: string | undefined,
    private readonly _sdk: T3Code,
  ) {}

  async refresh(): Promise<ThreadModel> {
    return this._sdk._require_thread(this.id);
  }

  async update(options: { title?: string; model?: string; branch?: string; worktree_path?: string }): Promise<ThreadModel> {
    return this._sdk.threads.open(this.id).update(options);
  }

  async delete(): Promise<void> {
    return this._sdk.threads.open(this.id).delete();
  }

  async send_message(
    text: string,
    options: {
      run?: boolean;
      message_id?: string;
      attachments?: unknown[];
      provider?: string;
      model?: string;
      model_options?: JsonMap;
      provider_options?: JsonMap;
      assistant_delivery_mode?: string;
      source_proposed_plan_thread_id?: string;
      source_proposed_plan_id?: string;
    } = {},
  ): Promise<Message> {
    return this._sdk.threads.open(this.id).messages.send(text, options);
  }

  async get_messages(options: { limit?: number } = {}): Promise<Message[]> {
    return this._sdk.threads.open(this.id).messages.list(options);
  }

  async record_assistant_message(options: {
    turn_id: string;
    text: string;
    message_id?: string;
    attachments?: unknown[];
    streaming?: boolean;
  }): Promise<Message> {
    return this._sdk.threads.open(this.id).messages.record_assistant(options);
  }

  async get_activities(options: { limit?: number } = {}): Promise<ThreadActivity[]> {
    return this._sdk.threads.open(this.id).activities.list(options);
  }

  async append_activity(options: {
    kind: string;
    summary: string;
    payload?: JsonMap;
    tone?: string;
    turn_id?: string;
    sequence?: number;
    activity_id?: string;
  }): Promise<ThreadActivity> {
    return this._sdk.threads.open(this.id).activities.append(options);
  }

  async get_session(): Promise<Session | undefined> {
    return this._sdk.threads.open(this.id).session.get();
  }

  async set_session(options: {
    status: string;
    provider_name?: string;
    runtime_mode?: string;
    active_turn_id?: string;
    last_error?: string;
  }): Promise<Session> {
    return this._sdk.threads.open(this.id).session.set(options);
  }

  async stop_session(): Promise<void> {
    return this._sdk.threads.open(this.id).session.stop();
  }

  async get_proposed_plans(): Promise<ProposedPlan[]> {
    return this._sdk.threads.open(this.id).proposed_plans.list();
  }

  async upsert_proposed_plan(
    plan_markdown: string,
    options: { plan_id?: string; turn_id?: string; implemented_at?: string; implementation_thread_id?: string } = {},
  ): Promise<ProposedPlan> {
    return this._sdk.threads.open(this.id).proposed_plans.upsert(plan_markdown, options);
  }

  async get_pending_approvals(options: { active_only?: boolean } = {}): Promise<PendingApproval[]> {
    return this._sdk.threads.open(this.id).approvals.list(options);
  }

  async respond_to_approval(request_id: string, decision: string): Promise<PendingApproval> {
    return this._sdk.threads.open(this.id).approvals.respond(request_id, decision);
  }

  async respond_to_user_input(request_id: string, answers: JsonMap): Promise<void> {
    return this._sdk.threads.open(this.id).approvals.respond_to_user_input(request_id, answers);
  }

  async get_turns(): Promise<Turn[]> {
    return this._sdk.threads.open(this.id).turns.list();
  }

  async interrupt_turn(turn_id?: string): Promise<Turn> {
    return this._sdk.threads.open(this.id).turns.interrupt({ turn_id });
  }

  async complete_diff(options: {
    turn_id: string;
    checkpoint_turn_count: number;
    checkpoint_ref: string;
    status: string;
    files?: Array<Record<string, unknown>>;
    assistant_message_id?: string;
    completed_at?: string;
  }): Promise<Turn> {
    return this._sdk.threads.open(this.id).turns.complete_diff(options);
  }

  async get_checkpoints(): Promise<CheckpointSummary[]> {
    return this._sdk.threads.open(this.id).checkpoints.list();
  }

  async revert_to_checkpoint(turn_count: number): Promise<ThreadModel> {
    return this._sdk.threads.open(this.id).checkpoints.revert(turn_count);
  }

  async set_runtime_mode(runtime_mode: string): Promise<ThreadModel> {
    return this._sdk.threads.open(this.id).set_runtime_mode(runtime_mode);
  }

  async set_interaction_mode(interaction_mode: string): Promise<ThreadModel> {
    return this._sdk.threads.open(this.id).set_interaction_mode(interaction_mode);
  }

  async run(
    text: string,
    options: {
      message_id?: string;
      attachments?: unknown[];
      provider?: string;
      model?: string;
      model_options?: JsonMap;
      provider_options?: JsonMap;
      assistant_delivery_mode?: string;
      source_proposed_plan_thread_id?: string;
      source_proposed_plan_id?: string;
      timeout?: number;
    } = {},
  ): Promise<Message> {
    return this._sdk.threads.open(this.id).run(text, options);
  }
}

export class T3ServerClient {
  constructor(
    private readonly server_url?: string,
    private readonly server_token?: string,
    private readonly timeout = 60_000,
  ) {}

  get enabled(): boolean {
    return this.server_url !== undefined;
  }

  require_enabled(): void {
    if (!this.enabled) {
      throw new Error("Live server dispatch is not configured. Pass server_url=... to T3Code(...) to enable agent execution.");
    }
  }

  async dispatch_command(command: JsonMap): Promise<DispatchReceipt> {
    this.require_enabled();
    const response = await this.request("orchestration.dispatchCommand", { command });
    if (typeof response !== "object" || response === null) {
      throw new Error("Invalid response from T3 server");
    }
    const sequence = (response as Record<string, unknown>).sequence;
    if (!Number.isInteger(sequence)) {
      throw new Error("Missing sequence in T3 server response");
    }
    return {
      command_id: String(command.commandId),
      sequence: Number(sequence),
    };
  }

  private build_url(): string {
    if (!this.server_url) {
      throw new Error("server_url is required");
    }
    const url = new URL(this.server_url);
    if (this.server_token && !url.searchParams.has("token")) {
      url.searchParams.set("token", this.server_token);
    }
    return url.toString();
  }

  private async request(method: string, params: JsonMap): Promise<unknown> {
    const url = this.build_url();
    const parsed = new URL(url);
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      throw new Error("server_url must use ws:// or wss://");
    }
    if (!parsed.hostname) {
      throw new Error("server_url is missing a host");
    }
    const requestId = newId();
    return new Promise((resolveRequest, rejectRequest) => {
      const ws = new WebSocket(url);
      const timeoutId = setTimeout(() => {
        try {
          ws.close();
        } catch {}
        rejectRequest(new Error("Timed out waiting for T3 server response"));
      }, this.timeout);

      const cleanup = (): void => {
        clearTimeout(timeoutId);
        ws.onopen = null;
        ws.onerror = null;
        ws.onmessage = null;
        ws.onclose = null;
      };

      ws.onopen = () => {
        ws.send(
          JSON.stringify({
            id: requestId,
            body: { _tag: method, ...params },
          }),
        );
      };

      ws.onerror = () => {
        cleanup();
        rejectRequest(new Error("WebSocket request failed"));
      };

      ws.onmessage = (event) => {
        const raw = typeof event.data === "string" ? event.data : String(event.data);
        const message = JSON.parse(raw) as Record<string, unknown>;
        if (message.type === "push") {
          return;
        }
        if (message.id !== requestId) {
          return;
        }
        cleanup();
        try {
          ws.close();
        } catch {}
        if (message.error !== undefined) {
          const error = message.error as Record<string, unknown>;
          rejectRequest(new Error(typeof error?.message === "string" ? error.message : String(message.error)));
          return;
        }
        resolveRequest(message.result);
      };

      ws.onclose = () => {
        cleanup();
      };
    });
  }
}

export class T3Code {
  public readonly prefer_server: boolean;
  public readonly server: T3ServerClient;
  public readonly projects: ProjectsManager;
  public readonly threads: ThreadsManager;

  constructor(
    public readonly db_path = DEFAULT_DB_PATH,
    options: {
      initialize?: boolean;
      server_url?: string;
      server_token?: string;
      server_timeout?: number;
      prefer_server?: boolean;
    } = {},
  ) {
    this.prefer_server = options.prefer_server ?? (options.server_url !== undefined);
    if (options.initialize ?? true) {
      this.initialize();
    }
    this.server = new T3ServerClient(options.server_url, options.server_token, options.server_timeout ?? 60_000);
    this.projects = new ProjectsManager(this);
    this.threads = new ThreadsManager(this);
  }

  initialize(): void {
    mkdirSync(dirname(this.db_path), { recursive: true });
    const db = this.connect();
    try {
      this.ensure_schema(db);
    } finally {
      db.close();
    }
  }

  connect(): DatabaseSync {
    return new DatabaseSync(this.db_path);
  }

  private ensure_schema(db: DatabaseSync): void {
    db.exec(`
      CREATE TABLE IF NOT EXISTS orchestration_events (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        aggregate_kind TEXT NOT NULL,
        stream_id TEXT NOT NULL,
        stream_version INTEGER NOT NULL,
        event_type TEXT NOT NULL,
        occurred_at TEXT NOT NULL,
        command_id TEXT,
        causation_event_id TEXT,
        correlation_id TEXT,
        actor_kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        metadata_json TEXT NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_events_stream_version
      ON orchestration_events(aggregate_kind, stream_id, stream_version);
      CREATE TABLE IF NOT EXISTS orchestration_command_receipts (
        command_id TEXT PRIMARY KEY,
        aggregate_kind TEXT NOT NULL,
        aggregate_id TEXT NOT NULL,
        accepted_at TEXT NOT NULL,
        result_sequence INTEGER NOT NULL,
        status TEXT NOT NULL,
        error TEXT
      );
      CREATE TABLE IF NOT EXISTS projection_projects (
        project_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        workspace_root TEXT NOT NULL,
        default_model TEXT,
        scripts_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE TABLE IF NOT EXISTS projection_threads (
        thread_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        title TEXT NOT NULL,
        model TEXT NOT NULL,
        branch TEXT,
        worktree_path TEXT,
        latest_turn_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT,
        runtime_mode TEXT NOT NULL DEFAULT 'full-access',
        interaction_mode TEXT NOT NULL DEFAULT 'default'
      );
      CREATE TABLE IF NOT EXISTS projection_thread_messages (
        message_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        role TEXT NOT NULL,
        text TEXT NOT NULL,
        is_streaming INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        attachments_json TEXT
      );
      CREATE TABLE IF NOT EXISTS projection_thread_activities (
        activity_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        tone TEXT NOT NULL,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        sequence INTEGER
      );
      CREATE TABLE IF NOT EXISTS projection_thread_sessions (
        thread_id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        provider_name TEXT,
        provider_session_id TEXT,
        provider_thread_id TEXT,
        active_turn_id TEXT,
        last_error TEXT,
        updated_at TEXT NOT NULL,
        runtime_mode TEXT NOT NULL DEFAULT 'full-access'
      );
      CREATE TABLE IF NOT EXISTS projection_turns (
        row_id INTEGER PRIMARY KEY AUTOINCREMENT,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        pending_message_id TEXT,
        assistant_message_id TEXT,
        state TEXT NOT NULL,
        requested_at TEXT NOT NULL,
        started_at TEXT,
        completed_at TEXT,
        checkpoint_turn_count INTEGER,
        checkpoint_ref TEXT,
        checkpoint_status TEXT,
        checkpoint_files_json TEXT NOT NULL,
        source_proposed_plan_thread_id TEXT,
        source_proposed_plan_id TEXT,
        UNIQUE (thread_id, turn_id),
        UNIQUE (thread_id, checkpoint_turn_count)
      );
      CREATE TABLE IF NOT EXISTS projection_pending_approvals (
        request_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        status TEXT NOT NULL,
        decision TEXT,
        created_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS projection_state (
        projector TEXT PRIMARY KEY,
        last_applied_sequence INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS projection_thread_proposed_plans (
        plan_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        turn_id TEXT,
        plan_markdown TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        implemented_at TEXT,
        implementation_thread_id TEXT
      );
      CREATE TABLE IF NOT EXISTS provider_session_runtime (
        runtime_session_id TEXT PRIMARY KEY,
        thread_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        status TEXT NOT NULL,
        runtime_mode TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
    `);
  }

  transaction<T>(callback: (db: DatabaseSync) => T): T {
    const db = this.connect();
    db.exec("BEGIN IMMEDIATE");
    try {
      const result = callback(db);
      db.exec("COMMIT");
      db.close();
      return result;
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } finally {
        db.close();
      }
      throw error;
    }
  }

  append_event(
    db: DatabaseSync,
    input: {
      aggregate_kind: string;
      aggregate_id: string;
      event_type: string;
      payload: JsonMap;
      command_id?: string;
      occurred_at?: string;
      causation_event_id?: string;
      correlation_id?: string;
      actor_kind?: string;
      metadata?: JsonMap;
    },
  ): { sequence: number; event_id: string; occurred_at: string } {
    const event_id = newId();
    const occurred_at = input.occurred_at ?? utcNow();
    db.prepare(`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
        command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
      )
      VALUES (
        ?, ?, ?,
        COALESCE(
          (SELECT stream_version + 1 FROM orchestration_events WHERE aggregate_kind = ? AND stream_id = ? ORDER BY stream_version DESC LIMIT 1),
          0
        ),
        ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      event_id,
      input.aggregate_kind,
      input.aggregate_id,
      input.aggregate_kind,
      input.aggregate_id,
      input.event_type,
      occurred_at,
      input.command_id ?? null,
      input.causation_event_id ?? null,
      input.correlation_id ?? input.command_id ?? null,
      input.actor_kind ?? "client",
      JSON.stringify(input.payload),
      JSON.stringify(input.metadata ?? {}),
    );
    const row = db.prepare("SELECT last_insert_rowid() AS id").get() as Row;
    return { sequence: Number(row.id), event_id, occurred_at };
  }

  touch_projection_state(db: DatabaseSync, sequence: number, occurred_at: string): void {
    const stmt = db.prepare(`
      INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
      VALUES (?, ?, ?)
      ON CONFLICT(projector)
      DO UPDATE SET last_applied_sequence = excluded.last_applied_sequence, updated_at = excluded.updated_at
    `);
    for (const projector of PROJECTOR_NAMES) {
      stmt.run(projector, sequence, occurred_at);
    }
  }

  project_from_row(row: Row): ProjectModel {
    const scripts = jsonLoads<Array<Record<string, unknown>>>(row.scripts_json, []).map((item) => ({
      id: String(item.id ?? ""),
      name: String(item.name ?? ""),
      command: String(item.command ?? ""),
      icon: String(item.icon ?? ""),
      run_on_worktree_create: Boolean(item.runOnWorktreeCreate),
    }));
    return new ProjectModel(
      String(row.project_id),
      String(row.title),
      String(row.workspace_root),
      row.default_model === null ? undefined : String(row.default_model ?? ""),
      scripts,
      String(row.created_at ?? ""),
      String(row.updated_at ?? ""),
      row.deleted_at === null ? undefined : (row.deleted_at as string | undefined),
      this,
    );
  }

  message_from_row(row: Row): Message {
    return {
      id: String(row.message_id),
      thread_id: String(row.thread_id),
      turn_id: row.turn_id === null ? undefined : (row.turn_id as string | undefined),
      role: String(row.role),
      text: String(row.text ?? ""),
      attachments: imageAttachmentsFromJson(row.attachments_json),
      streaming: Boolean(row.is_streaming),
      created_at: String(row.created_at ?? ""),
      updated_at: String(row.updated_at ?? ""),
    };
  }

  plan_from_row(row: Row): ProposedPlan {
    return {
      id: String(row.plan_id),
      thread_id: String(row.thread_id),
      turn_id: row.turn_id === null ? undefined : (row.turn_id as string | undefined),
      plan_markdown: String(row.plan_markdown),
      implemented_at: row.implemented_at === null ? undefined : (row.implemented_at as string | undefined),
      implementation_thread_id:
        row.implementation_thread_id === null ? undefined : (row.implementation_thread_id as string | undefined),
      created_at: String(row.created_at),
      updated_at: String(row.updated_at),
    };
  }

  activity_from_row(row: Row): ThreadActivity {
    return {
      id: String(row.activity_id),
      thread_id: String(row.thread_id),
      turn_id: row.turn_id === null ? undefined : (row.turn_id as string | undefined),
      tone: String(row.tone),
      kind: String(row.kind),
      summary: String(row.summary),
      payload: jsonLoads<JsonMap>(row.payload_json, {}),
      sequence: row.sequence === null || row.sequence === undefined ? undefined : Number(row.sequence),
      created_at: String(row.created_at),
    };
  }

  session_from_row(row: Row): Session {
    return {
      thread_id: String(row.thread_id),
      status: String(row.status),
      provider_name: row.provider_name === null ? undefined : (row.provider_name as string | undefined),
      runtime_mode: String(row.runtime_mode ?? DEFAULT_RUNTIME_MODE),
      active_turn_id: row.active_turn_id === null ? undefined : (row.active_turn_id as string | undefined),
      last_error: row.last_error === null ? undefined : (row.last_error as string | undefined),
      updated_at: String(row.updated_at),
    };
  }

  approval_from_row(row: Row): PendingApproval {
    return {
      request_id: String(row.request_id),
      thread_id: String(row.thread_id),
      turn_id: row.turn_id === null ? undefined : (row.turn_id as string | undefined),
      status: String(row.status),
      decision: row.decision === null ? undefined : (row.decision as string | undefined),
      created_at: String(row.created_at),
      resolved_at: row.resolved_at === null ? undefined : (row.resolved_at as string | undefined),
    };
  }

  turn_from_row(row: Row): Turn {
    return {
      thread_id: String(row.thread_id),
      turn_id: row.turn_id === null ? undefined : (row.turn_id as string | undefined),
      pending_message_id: row.pending_message_id === null ? undefined : (row.pending_message_id as string | undefined),
      source_proposed_plan_thread_id:
        row.source_proposed_plan_thread_id === null
          ? undefined
          : (row.source_proposed_plan_thread_id as string | undefined),
      source_proposed_plan_id:
        row.source_proposed_plan_id === null ? undefined : (row.source_proposed_plan_id as string | undefined),
      assistant_message_id:
        row.assistant_message_id === null ? undefined : (row.assistant_message_id as string | undefined),
      state: String(row.state),
      requested_at: String(row.requested_at),
      started_at: row.started_at === null ? undefined : (row.started_at as string | undefined),
      completed_at: row.completed_at === null ? undefined : (row.completed_at as string | undefined),
      checkpoint_turn_count:
        row.checkpoint_turn_count === null || row.checkpoint_turn_count === undefined
          ? undefined
          : Number(row.checkpoint_turn_count),
      checkpoint_ref: row.checkpoint_ref === null ? undefined : (row.checkpoint_ref as string | undefined),
      checkpoint_status: row.checkpoint_status === null ? undefined : (row.checkpoint_status as string | undefined),
      checkpoint_files: checkpointFilesFromJson(row.checkpoint_files_json ?? "[]"),
    };
  }

  latest_turn_from_row(row: Row): LatestTurn {
    const state = ["running", "interrupted", "completed", "error"].includes(String(row.state))
      ? String(row.state)
      : "running";
    return {
      turn_id: String(row.turn_id),
      state,
      requested_at: String(row.requested_at),
      started_at: row.started_at === null ? undefined : (row.started_at as string | undefined),
      completed_at: row.completed_at === null ? undefined : (row.completed_at as string | undefined),
      assistant_message_id:
        row.assistant_message_id === null ? undefined : (row.assistant_message_id as string | undefined),
      source_proposed_plan_thread_id:
        row.source_proposed_plan_thread_id === null
          ? undefined
          : (row.source_proposed_plan_thread_id as string | undefined),
      source_proposed_plan_id:
        row.source_proposed_plan_id === null ? undefined : (row.source_proposed_plan_id as string | undefined),
    };
  }

  thread_from_row(db: DatabaseSync, row: Row): ThreadModel {
    const thread_id = String(row.thread_id);
    const messages = (db.prepare(`
      SELECT * FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at ASC, message_id ASC
    `).all(thread_id) as Row[]).map((entry) => this.message_from_row(entry));
    const proposed_plans = (db.prepare(`
      SELECT * FROM projection_thread_proposed_plans WHERE thread_id = ? ORDER BY created_at ASC, plan_id ASC
    `).all(thread_id) as Row[]).map((entry) => this.plan_from_row(entry));
    const activities = (db.prepare(`
      SELECT * FROM projection_thread_activities WHERE thread_id = ? ORDER BY created_at ASC, activity_id ASC
    `).all(thread_id) as Row[]).map((entry) => this.activity_from_row(entry));
    const sessionRow = db.prepare(`SELECT * FROM projection_thread_sessions WHERE thread_id = ?`).get(thread_id) as Row | undefined;
    const turns = (db.prepare(`
      SELECT * FROM projection_turns WHERE thread_id = ? ORDER BY requested_at ASC, row_id ASC
    `).all(thread_id) as Row[]).map((entry) => this.turn_from_row(entry));
    const checkpoints = turns
      .filter((turn) => turn.turn_id !== undefined && turn.checkpoint_turn_count !== undefined)
      .map((turn) => ({
        turn_id: turn.turn_id as string,
        checkpoint_turn_count: turn.checkpoint_turn_count as number,
        checkpoint_ref: turn.checkpoint_ref as string,
        status: turn.checkpoint_status as string,
        files: turn.checkpoint_files,
        assistant_message_id: turn.assistant_message_id,
        completed_at: turn.completed_at ?? turn.requested_at,
      }))
      .sort((a, b) => a.checkpoint_turn_count - b.checkpoint_turn_count);
    const approvals = (db.prepare(`
      SELECT * FROM projection_pending_approvals WHERE thread_id = ? ORDER BY created_at ASC, request_id ASC
    `).all(thread_id) as Row[]).map((entry) => this.approval_from_row(entry));
    let latestTurn: LatestTurn | undefined;
    if (row.latest_turn_id !== null && row.latest_turn_id !== undefined) {
      const latestTurnRow = db
        .prepare(`
          SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id = ? LIMIT 1
        `)
        .get(thread_id, String(row.latest_turn_id)) as Row | undefined;
      if (latestTurnRow) {
        latestTurn = this.latest_turn_from_row(latestTurnRow);
      }
    }
    return new ThreadModel(
      thread_id,
      String(row.project_id),
      String(row.title),
      String(row.model),
      String(row.runtime_mode ?? DEFAULT_RUNTIME_MODE),
      String(row.interaction_mode ?? DEFAULT_INTERACTION_MODE),
      row.branch === null ? undefined : (row.branch as string | undefined),
      row.worktree_path === null ? undefined : (row.worktree_path as string | undefined),
      latestTurn,
      messages,
      proposed_plans,
      activities,
      checkpoints,
      turns,
      approvals,
      sessionRow ? this.session_from_row(sessionRow) : undefined,
      String(row.created_at ?? ""),
      String(row.updated_at ?? ""),
      row.deleted_at === null ? undefined : (row.deleted_at as string | undefined),
      this,
    );
  }

  upsert_thread_row(
    db: DatabaseSync,
    input: {
      thread_id: string;
      project_id: string;
      title: string;
      model: string;
      runtime_mode: string;
      interaction_mode: string;
      branch?: string | undefined;
      worktree_path?: string | undefined;
      latest_turn_id?: string | undefined;
      created_at: string;
      updated_at: string;
      deleted_at?: string | undefined;
    },
  ): void {
    db.prepare(`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model, branch, worktree_path, latest_turn_id,
        created_at, updated_at, deleted_at, runtime_mode, interaction_mode
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(thread_id)
      DO UPDATE SET
        project_id = excluded.project_id,
        title = excluded.title,
        model = excluded.model,
        branch = excluded.branch,
        worktree_path = excluded.worktree_path,
        latest_turn_id = excluded.latest_turn_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at,
        deleted_at = excluded.deleted_at,
        runtime_mode = excluded.runtime_mode,
        interaction_mode = excluded.interaction_mode
    `).run(
      input.thread_id,
      input.project_id,
      input.title,
      input.model,
      input.branch ?? null,
      input.worktree_path ?? null,
      input.latest_turn_id ?? null,
      input.created_at,
      input.updated_at,
      input.deleted_at ?? null,
      input.runtime_mode,
      input.interaction_mode,
    );
  }

  _get_project(project_id: string, include_deleted = false): ProjectModel | undefined {
    const db = this.connect();
    try {
      let sql = "SELECT * FROM projection_projects WHERE project_id = ?";
      if (!include_deleted) {
        sql += " AND deleted_at IS NULL";
      }
      const row = db.prepare(sql).get(trimmed(project_id, "project_id")) as Row | undefined;
      return row ? this.project_from_row(row) : undefined;
    } finally {
      db.close();
    }
  }

  _require_project(project_id: string): ProjectModel {
    const project = this._get_project(project_id, true);
    if (!project) {
      throw new Error(`Project '${project_id}' does not exist`);
    }
    return project;
  }

  _get_thread(thread_id: string, include_deleted = false): ThreadModel | undefined {
    const db = this.connect();
    try {
      let sql = "SELECT * FROM projection_threads WHERE thread_id = ?";
      if (!include_deleted) {
        sql += " AND deleted_at IS NULL";
      }
      const row = db.prepare(sql).get(trimmed(thread_id, "thread_id")) as Row | undefined;
      return row ? this.thread_from_row(db, row) : undefined;
    } finally {
      db.close();
    }
  }

  _require_thread(thread_id: string): ThreadModel {
    const thread = this._get_thread(thread_id, true);
    if (!thread) {
      throw new Error(`Thread '${thread_id}' does not exist`);
    }
    return thread;
  }

  private async wait_for_row(sql: string, params: unknown[], timeout = 5_000): Promise<Row | undefined> {
    const deadline = Date.now() + timeout;
    while (Date.now() <= deadline) {
      const db = this.connect();
      try {
        const row = db.prepare(sql).get(...(params as [])) as Row | undefined;
        if (row) {
          return row;
        }
      } finally {
        db.close();
      }
      await sleep(25);
    }
    return undefined;
  }

  async _wait_for_project(project_id: string, timeout?: number): Promise<ProjectModel | undefined> {
    const row = await this.wait_for_row("SELECT * FROM projection_projects WHERE project_id = ?", [project_id], timeout);
    return row ? this.project_from_row(row) : undefined;
  }

  async _wait_for_thread(thread_id: string, timeout?: number): Promise<ThreadModel | undefined> {
    const row = await this.wait_for_row("SELECT * FROM projection_threads WHERE thread_id = ?", [thread_id], timeout);
    if (!row) {
      return undefined;
    }
    const db = this.connect();
    try {
      const refreshed = db.prepare("SELECT * FROM projection_threads WHERE thread_id = ?").get(thread_id) as Row | undefined;
      return refreshed ? this.thread_from_row(db, refreshed) : undefined;
    } finally {
      db.close();
    }
  }

  async _wait_for_message(message_id: string, timeout?: number): Promise<Message | undefined> {
    const row = await this.wait_for_row("SELECT * FROM projection_thread_messages WHERE message_id = ?", [message_id], timeout);
    return row ? this.message_from_row(row) : undefined;
  }

  async list_projects(): Promise<ProjectModel[]> {
    return this.projects.list();
  }

  async get_project(project_id: string): Promise<ProjectModel | undefined> {
    return this.projects.get(project_id);
  }

  async find_project(title: string): Promise<ProjectModel | undefined> {
    return this.projects.get_by_title(title);
  }

  async get_thread(thread_id: string): Promise<ThreadModel | undefined> {
    return this.threads.get(thread_id);
  }

  async find_thread(title: string, options: { project_id?: string } = {}): Promise<ThreadModel | undefined> {
    const normalized = trimmed(title, "title");
    const threads = await this.threads.list(options.project_id ? { project_id: options.project_id } : {});
    return threads.find((thread) => thread.title === normalized);
  }

  async create_project(workspace_root: string, model = DEFAULT_MODEL): Promise<ProjectModel> {
    return this.projects.create(model ? { workspace_root, default_model: model } : { workspace_root });
  }

  async delete_project(project_id: string): Promise<void> {
    return this.projects.delete(project_id);
  }

  async create_thread(project_id: string, title = "New thread", model?: string): Promise<ThreadModel> {
    return this.projects.open(project_id).threads.create(model ? { title, model } : { title });
  }

  async list_threads(project_id: string): Promise<ThreadModel[]> {
    return this.projects.open(project_id).threads.list();
  }

  async list_messages(thread_id: string, limit = 50): Promise<Message[]> {
    return this.threads.open(thread_id).messages.list({ limit });
  }

  async list_activities(thread_id: string, limit = 50): Promise<ThreadActivity[]> {
    return this.threads.open(thread_id).activities.list({ limit });
  }

  async get_session(thread_id: string): Promise<Session | undefined> {
    return this.threads.open(thread_id).session.get();
  }

  async list_active_sessions(): Promise<Row[]> {
    const db = this.connect();
    try {
      return db.prepare(`
        SELECT * FROM provider_session_runtime WHERE status IN ('starting', 'ready', 'running')
      `).all() as Row[];
    } finally {
      db.close();
    }
  }
}

export class ProjectsManager {
  constructor(private readonly sdk: T3Code) {}

  async list(options: { include_deleted?: boolean } = {}): Promise<ProjectModel[]> {
    const db = this.sdk.connect();
    try {
      let sql = "SELECT * FROM projection_projects";
      if (!options.include_deleted) {
        sql += " WHERE deleted_at IS NULL";
      }
      sql += " ORDER BY created_at ASC, project_id ASC";
      return (db.prepare(sql).all() as Row[]).map((row) => this.sdk.project_from_row(row));
    } finally {
      db.close();
    }
  }

  async get(project_id: string, options: { include_deleted?: boolean } = {}): Promise<ProjectModel | undefined> {
    return this.sdk._get_project(project_id, options.include_deleted);
  }

  async get_by_title(title: string, options: { include_deleted?: boolean } = {}): Promise<ProjectModel | undefined> {
    const db = this.sdk.connect();
    try {
      let sql = "SELECT * FROM projection_projects WHERE title = ?";
      if (!options.include_deleted) {
        sql += " AND deleted_at IS NULL";
      }
      sql += " ORDER BY created_at ASC LIMIT 1";
      const row = db.prepare(sql).get(trimmed(title, "title")) as Row | undefined;
      return row ? this.sdk.project_from_row(row) : undefined;
    } finally {
      db.close();
    }
  }

  async get_by_workspace_root(workspace_root: string, options: { include_deleted?: boolean } = {}): Promise<ProjectModel | undefined> {
    const db = this.sdk.connect();
    try {
      let sql = "SELECT * FROM projection_projects WHERE workspace_root = ?";
      if (!options.include_deleted) {
        sql += " AND deleted_at IS NULL";
      }
      sql += " ORDER BY created_at ASC LIMIT 1";
      const row = db.prepare(sql).get(coercePath(workspace_root)) as Row | undefined;
      return row ? this.sdk.project_from_row(row) : undefined;
    } finally {
      db.close();
    }
  }

  open(project_id: string): ProjectHandle {
    this.sdk._require_project(project_id);
    return new ProjectHandle(this.sdk, trimmed(project_id, "project_id"));
  }

  async create(options: {
    workspace_root: string;
    title?: string;
    default_model?: string;
    scripts?: unknown[];
    create_initial_thread?: boolean;
    initial_thread_title?: string;
    initial_thread_model?: string;
    ensure_workspace_exists?: boolean;
    live?: boolean;
    timeout?: number;
  }): Promise<ProjectModel> {
    const workspace = coercePath(options.workspace_root);
    if (options.ensure_workspace_exists && !existsSync(workspace)) {
      throw new Error(`workspace_root does not exist: ${workspace}`);
    }
    const normalized_title = optionalTrimmed(options.title, "title") ?? workspace.split("/").at(-1) ?? "Project";
    const normalized_model = optionalTrimmed(options.default_model ?? DEFAULT_MODEL, "default_model");
    const normalized_scripts = validateScripts(options.scripts);
    const resolved_live = options.live ?? this.sdk.prefer_server;
    const project_id = newId();
    const created_at = utcNow();
    const command_id = newId();

    if (resolved_live) {
      await this.sdk.server.dispatch_command({
        type: "project.create",
        commandId: command_id,
        projectId: project_id,
        title: normalized_title,
        workspaceRoot: workspace,
        defaultModel: normalized_model,
        createdAt: created_at,
      });
      let project = await this.sdk._wait_for_project(project_id, options.timeout);
      if (!project) {
        throw new Error("Project dispatch succeeded but the project was not visible in the database");
      }
      if (options.create_initial_thread ?? true) {
        await project.create_thread({
          title: options.initial_thread_title ?? "New thread",
          model: options.initial_thread_model ?? normalized_model,
          live: true,
          timeout: options.timeout,
        });
        project = this.sdk._require_project(project_id);
      }
      if (normalized_scripts.length > 0) {
        project = await this.update(project.id, { scripts: normalized_scripts });
      }
      return project;
    }

    this.sdk.transaction((db) => {
      const projectEvent = this.sdk.append_event(db, {
        aggregate_kind: "project",
        aggregate_id: project_id,
        event_type: "project.created",
        command_id,
        occurred_at: created_at,
        payload: {
          projectId: project_id,
          title: normalized_title,
          workspaceRoot: workspace,
          defaultModel: normalized_model ?? null,
          scripts: normalized_scripts,
          createdAt: created_at,
          updatedAt: created_at,
        },
      });
      db.prepare(`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, default_model, scripts_json, created_at, updated_at, deleted_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
      `).run(project_id, normalized_title, workspace, normalized_model ?? null, JSON.stringify(normalized_scripts), created_at, created_at);

      let latestSequence = projectEvent.sequence;
      let latestOccurredAt = projectEvent.occurred_at;
      if (options.create_initial_thread ?? true) {
        const thread_id = newId();
        const thread_model = optionalTrimmed(options.initial_thread_model, "initial_thread_model") ?? normalized_model ?? DEFAULT_MODEL;
        const threadEvent = this.sdk.append_event(db, {
          aggregate_kind: "thread",
          aggregate_id: thread_id,
          event_type: "thread.created",
          command_id: newId(),
          occurred_at: created_at,
          payload: {
            threadId: thread_id,
            projectId: project_id,
            title: trimmed(options.initial_thread_title ?? "New thread", "initial_thread_title"),
            model: thread_model,
            runtimeMode: DEFAULT_RUNTIME_MODE,
            interactionMode: DEFAULT_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: created_at,
            updatedAt: created_at,
          },
        });
        this.sdk.upsert_thread_row(db, {
          thread_id,
          project_id,
          title: trimmed(options.initial_thread_title ?? "New thread", "initial_thread_title"),
          model: thread_model,
          runtime_mode: DEFAULT_RUNTIME_MODE,
          interaction_mode: DEFAULT_INTERACTION_MODE,
          created_at,
          updated_at: created_at,
        });
        latestSequence = threadEvent.sequence;
        latestOccurredAt = threadEvent.occurred_at;
      }
      this.sdk.touch_projection_state(db, latestSequence, latestOccurredAt);
    });
    return this.sdk._require_project(project_id);
  }

  async get_or_create(options: {
    workspace_root: string;
    title?: string;
    default_model?: string;
    scripts?: unknown[];
    create_initial_thread?: boolean;
    initial_thread_title?: string;
    initial_thread_model?: string;
    ensure_workspace_exists?: boolean;
  }): Promise<ProjectModel> {
    const existing = await this.get_by_workspace_root(options.workspace_root);
    if (existing) {
      return existing;
    }
    return this.create(options);
  }

  async update(project_id: string, options: { title?: string; workspace_root?: string; default_model?: string; scripts?: unknown[] }): Promise<ProjectModel> {
    const project = this.sdk._require_project(project_id);
    const next_title = optionalTrimmed(options.title, "title");
    const next_workspace_root = options.workspace_root !== undefined ? coercePath(options.workspace_root) : undefined;
    const next_default_model = options.default_model !== undefined ? optionalTrimmed(options.default_model, "default_model") : undefined;
    const next_scripts = options.scripts !== undefined ? validateScripts(options.scripts) : undefined;
    if (next_title === undefined && next_workspace_root === undefined && options.default_model === undefined && next_scripts === undefined) {
      return project;
    }
    const updated_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "project",
        aggregate_id: project.id,
        event_type: "project.meta-updated",
        command_id: newId(),
        occurred_at: updated_at,
        payload: {
          projectId: project.id,
          ...(next_title !== undefined ? { title: next_title } : {}),
          ...(next_workspace_root !== undefined ? { workspaceRoot: next_workspace_root } : {}),
          ...(options.default_model !== undefined ? { defaultModel: next_default_model ?? null } : {}),
          ...(next_scripts !== undefined ? { scripts: next_scripts } : {}),
          updatedAt: updated_at,
        },
      });
      db.prepare(`
        UPDATE projection_projects
        SET title = ?, workspace_root = ?, default_model = ?, scripts_json = ?, updated_at = ?
        WHERE project_id = ?
      `).run(
        next_title ?? project.title,
        next_workspace_root ?? project.workspace_root,
        options.default_model !== undefined ? (next_default_model ?? null) : (project.default_model ?? null),
        JSON.stringify(
          next_scripts ??
            project.scripts.map((script) => ({
              id: script.id,
              name: script.name,
              command: script.command,
              icon: script.icon,
              runOnWorktreeCreate: script.run_on_worktree_create,
            })),
        ),
        updated_at,
        project.id,
      );
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    return this.sdk._require_project(project.id);
  }

  async delete(project_id: string): Promise<void> {
    const project = this.sdk._require_project(project_id);
    const deleted_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "project",
        aggregate_id: project.id,
        event_type: "project.deleted",
        command_id: newId(),
        occurred_at: deleted_at,
        payload: { projectId: project.id, deletedAt: deleted_at },
      });
      db.prepare("UPDATE projection_projects SET deleted_at = ?, updated_at = ? WHERE project_id = ?").run(
        deleted_at,
        deleted_at,
        project.id,
      );
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
  }
}

export class ProjectHandle {
  public readonly threads: ProjectThreadsManager;
  public readonly files: ProjectFilesManager;

  constructor(private readonly sdk: T3Code, public readonly id: string) {
    this.threads = new ProjectThreadsManager(sdk, id);
    this.files = new ProjectFilesManager(sdk, id);
  }

  async get(): Promise<ProjectModel> {
    return this.sdk._require_project(this.id);
  }

  async refresh(): Promise<ProjectModel> {
    return this.get();
  }

  async update(options: { title?: string; workspace_root?: string; default_model?: string; scripts?: unknown[] }): Promise<ProjectModel> {
    return this.sdk.projects.update(this.id, options);
  }

  async delete(): Promise<void> {
    return this.sdk.projects.delete(this.id);
  }
}

export class ProjectThreadsManager {
  constructor(
    private readonly sdk: T3Code,
    private readonly project_id: string,
  ) {}

  async list(options: { include_deleted?: boolean } = {}): Promise<ThreadModel[]> {
    this.sdk._require_project(this.project_id);
    const db = this.sdk.connect();
    try {
      let sql = "SELECT * FROM projection_threads WHERE project_id = ?";
      if (!options.include_deleted) {
        sql += " AND deleted_at IS NULL";
      }
      sql += " ORDER BY created_at ASC, thread_id ASC";
      return (db.prepare(sql).all(this.project_id) as Row[]).map((row) => this.sdk.thread_from_row(db, row));
    } finally {
      db.close();
    }
  }

  async get(thread_id: string, options: { include_deleted?: boolean } = {}): Promise<ThreadModel | undefined> {
    const thread = this.sdk._get_thread(thread_id, options.include_deleted);
    if (!thread || thread.project_id !== this.project_id) {
      return undefined;
    }
    return thread;
  }

  open(thread_id: string): ThreadHandle {
    const thread = this.sdk._require_thread(thread_id);
    if (thread.project_id !== this.project_id) {
      throw new Error(`Thread '${thread_id}' does not belong to project '${this.project_id}'`);
    }
    return new ThreadHandle(this.sdk, thread_id);
  }

  async create(options: {
    title?: string;
    model?: string;
    runtime_mode?: string;
    interaction_mode?: string;
    branch?: string;
    worktree_path?: string;
    live?: boolean;
    timeout?: number;
  } = {}): Promise<ThreadModel> {
    const project = this.sdk._require_project(this.project_id);
    const normalized_title = trimmed(options.title ?? "New thread", "title");
    const normalized_model = optionalTrimmed(options.model, "model") ?? project.default_model ?? DEFAULT_MODEL;
    const normalized_runtime_mode = validateEnum(options.runtime_mode ?? DEFAULT_RUNTIME_MODE, "runtime_mode", RUNTIME_MODES);
    const normalized_interaction_mode = validateEnum(
      options.interaction_mode ?? DEFAULT_INTERACTION_MODE,
      "interaction_mode",
      INTERACTION_MODES,
    );
    const normalized_branch = optionalTrimmed(options.branch, "branch");
    const normalized_worktree_path = optionalTrimmed(options.worktree_path, "worktree_path");
    const resolved_live = options.live ?? this.sdk.prefer_server;
    const thread_id = newId();
    const created_at = utcNow();

    if (resolved_live) {
      try {
        await this.sdk.server.dispatch_command({
          type: "thread.create",
          commandId: newId(),
          threadId: thread_id,
          projectId: project.id,
          title: normalized_title,
          model: normalized_model,
          runtimeMode: normalized_runtime_mode,
          interactionMode: normalized_interaction_mode,
          branch: normalized_branch ?? null,
          worktreePath: normalized_worktree_path ?? null,
          createdAt: created_at,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (
          message.includes("Orchestration command invariant failed (thread.create)") &&
          message.includes(`Project '${project.id}' does not exist`)
        ) {
          throw new Error(
            "Cannot create a live thread for a project that only exists in the local SDK database. Create the project with live=True, or disable live dispatch with live=False or T3Code(..., prefer_server=False).",
          );
        }
        throw error;
      }
      const thread = await this.sdk._wait_for_thread(thread_id, options.timeout);
      if (!thread) {
        throw new Error("Thread dispatch succeeded but the thread was not visible in the database");
      }
      return thread;
    }

    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread_id,
        event_type: "thread.created",
        command_id: newId(),
        occurred_at: created_at,
        payload: {
          threadId: thread_id,
          projectId: project.id,
          title: normalized_title,
          model: normalized_model,
          runtimeMode: normalized_runtime_mode,
          interactionMode: normalized_interaction_mode,
          branch: normalized_branch ?? null,
          worktreePath: normalized_worktree_path ?? null,
          createdAt: created_at,
          updatedAt: created_at,
        },
      });
      this.sdk.upsert_thread_row(db, {
        thread_id,
        project_id: project.id,
        title: normalized_title,
        model: normalized_model,
        runtime_mode: normalized_runtime_mode,
        interaction_mode: normalized_interaction_mode,
        branch: normalized_branch,
        worktree_path: normalized_worktree_path,
        created_at,
        updated_at: created_at,
      });
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    return this.sdk._require_thread(thread_id);
  }

  async get_or_create(options: { title: string; model?: string }): Promise<ThreadModel> {
    const normalized_title = trimmed(options.title, "title");
    const threads = await this.list();
    const existing = threads.find((thread) => thread.title === normalized_title);
    if (existing) {
      return existing;
    }
    return this.create({ title: normalized_title, model: options.model });
  }
}

export class ProjectFilesManager {
  constructor(
    private readonly sdk: T3Code,
    private readonly project_id: string,
  ) {}

  private workspace_root(): string {
    return this.sdk._require_project(this.project_id).workspace_root;
  }

  async search_entries(query: string, options: { limit?: number } = {}): Promise<ProjectSearchResult> {
    const normalized_query = trimmed(query, "query", { maxLength: MAX_QUERY_LENGTH }).toLowerCase();
    const limit = options.limit ?? 50;
    if (!Number.isInteger(limit) || limit < 1 || limit > MAX_SEARCH_LIMIT) {
      throw new Error(`limit must be between 1 and ${MAX_SEARCH_LIMIT}`);
    }
    const root = this.workspace_root();
    if (!existsSync(root)) {
      throw new Error(`workspace_root does not exist: ${root}`);
    }
    const matches: ProjectEntry[] = [];
    let total = 0;
    const walk = (current: string): void => {
      const names = readdirSync(current).sort();
      for (const name of names) {
        const fullPath = join(current, name);
        const rel = relative(root, fullPath).replaceAll("\\", "/");
        const haystack = `${rel} ${name}`.toLowerCase();
        if (normalized_query.includes("") && haystack.includes(normalized_query)) {
          total += 1;
          if (matches.length < limit) {
            const parent = rel.includes("/") ? rel.split("/").slice(0, -1).join("/") : undefined;
            matches.push({
              path: rel,
              kind: statSync(fullPath).isDirectory() ? "directory" : "file",
              parent_path: parent && parent !== "." ? parent : undefined,
            });
          }
        }
        if (statSync(fullPath).isDirectory()) {
          walk(fullPath);
        }
      }
    };
    walk(root);
    return { entries: matches, truncated: total > matches.length };
  }

  async write_file(relative_path_input: string, contents: string): Promise<FileWriteResult> {
    if (typeof contents !== "string") {
      throw new TypeError("contents must be a string");
    }
    const root = this.workspace_root();
    const target = relativePath(resolve(root), relative_path_input);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, "utf8");
    return { relative_path: relative(resolve(root), target).replaceAll("\\", "/") };
  }
}

export class ThreadsManager {
  constructor(private readonly sdk: T3Code) {}

  async list(options: { project_id?: string; include_deleted?: boolean } = {}): Promise<ThreadModel[]> {
    const db = this.sdk.connect();
    try {
      let sql = "SELECT * FROM projection_threads";
      const clauses: string[] = [];
      const params: unknown[] = [];
      if (options.project_id !== undefined) {
        clauses.push("project_id = ?");
        params.push(trimmed(options.project_id, "project_id"));
      }
      if (!options.include_deleted) {
        clauses.push("deleted_at IS NULL");
      }
      if (clauses.length > 0) {
        sql += ` WHERE ${clauses.join(" AND ")}`;
      }
      sql += " ORDER BY created_at ASC, thread_id ASC";
      return (db.prepare(sql).all(...(params as [])) as Row[]).map((row) => this.sdk.thread_from_row(db, row));
    } finally {
      db.close();
    }
  }

  async get(thread_id: string, options: { include_deleted?: boolean } = {}): Promise<ThreadModel | undefined> {
    return this.sdk._get_thread(thread_id, options.include_deleted);
  }

  open(thread_id: string): ThreadHandle {
    this.sdk._require_thread(thread_id);
    return new ThreadHandle(this.sdk, trimmed(thread_id, "thread_id"));
  }
}

export class ThreadHandle {
  public readonly messages: ThreadMessagesManager;
  public readonly activities: ThreadActivitiesManager;
  public readonly session: ThreadSessionManager;
  public readonly proposed_plans: ThreadProposedPlansManager;
  public readonly approvals: ThreadApprovalsManager;
  public readonly turns: ThreadTurnsManager;
  public readonly checkpoints: ThreadCheckpointsManager;

  constructor(
    private readonly sdk: T3Code,
    public readonly id: string,
  ) {
    this.messages = new ThreadMessagesManager(sdk, id);
    this.activities = new ThreadActivitiesManager(sdk, id);
    this.session = new ThreadSessionManager(sdk, id);
    this.proposed_plans = new ThreadProposedPlansManager(sdk, id);
    this.approvals = new ThreadApprovalsManager(sdk, id);
    this.turns = new ThreadTurnsManager(sdk, id);
    this.checkpoints = new ThreadCheckpointsManager(sdk, id);
  }

  async get(): Promise<ThreadModel> {
    return this.sdk._require_thread(this.id);
  }

  async refresh(): Promise<ThreadModel> {
    return this.get();
  }

  async update(options: { title?: string; model?: string; branch?: string; worktree_path?: string }): Promise<ThreadModel> {
    const thread = this.sdk._require_thread(this.id);
    const next_title = optionalTrimmed(options.title, "title");
    const next_model = optionalTrimmed(options.model, "model");
    const next_branch = options.branch !== undefined ? optionalTrimmed(options.branch, "branch") : undefined;
    const next_worktree_path =
      options.worktree_path !== undefined ? optionalTrimmed(options.worktree_path, "worktree_path") : undefined;
    if (next_title === undefined && next_model === undefined && options.branch === undefined && options.worktree_path === undefined) {
      return thread;
    }
    const updated_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.meta-updated",
        command_id: newId(),
        occurred_at: updated_at,
        payload: {
          threadId: thread.id,
          ...(next_title !== undefined ? { title: next_title } : {}),
          ...(next_model !== undefined ? { model: next_model } : {}),
          ...(options.branch !== undefined ? { branch: next_branch ?? null } : {}),
          ...(options.worktree_path !== undefined ? { worktreePath: next_worktree_path ?? null } : {}),
          updatedAt: updated_at,
        },
      });
      this.sdk.upsert_thread_row(db, {
        thread_id: thread.id,
        project_id: thread.project_id,
        title: next_title ?? thread.title,
        model: next_model ?? thread.model,
        runtime_mode: thread.runtime_mode,
        interaction_mode: thread.interaction_mode,
        branch: options.branch !== undefined ? next_branch : thread.branch,
        worktree_path: options.worktree_path !== undefined ? next_worktree_path : thread.worktree_path,
        latest_turn_id: thread.latest_turn?.turn_id,
        created_at: thread.created_at,
        updated_at,
        deleted_at: thread.deleted_at,
      });
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    return this.sdk._require_thread(thread.id);
  }

  async set_runtime_mode(runtime_mode: string): Promise<ThreadModel> {
    const thread = this.sdk._require_thread(this.id);
    const normalized = validateEnum(runtime_mode, "runtime_mode", RUNTIME_MODES);
    const updated_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.runtime-mode-set",
        command_id: newId(),
        occurred_at: updated_at,
        payload: { threadId: thread.id, runtimeMode: normalized, updatedAt: updated_at },
      });
      this.sdk.upsert_thread_row(db, {
        thread_id: thread.id,
        project_id: thread.project_id,
        title: thread.title,
        model: thread.model,
        runtime_mode: normalized,
        interaction_mode: thread.interaction_mode,
        branch: thread.branch,
        worktree_path: thread.worktree_path,
        latest_turn_id: thread.latest_turn?.turn_id,
        created_at: thread.created_at,
        updated_at,
        deleted_at: thread.deleted_at,
      });
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    return this.sdk._require_thread(thread.id);
  }

  async set_interaction_mode(interaction_mode: string): Promise<ThreadModel> {
    const thread = this.sdk._require_thread(this.id);
    const normalized = validateEnum(interaction_mode, "interaction_mode", INTERACTION_MODES);
    const updated_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.interaction-mode-set",
        command_id: newId(),
        occurred_at: updated_at,
        payload: { threadId: thread.id, interactionMode: normalized, updatedAt: updated_at },
      });
      this.sdk.upsert_thread_row(db, {
        thread_id: thread.id,
        project_id: thread.project_id,
        title: thread.title,
        model: thread.model,
        runtime_mode: thread.runtime_mode,
        interaction_mode: normalized,
        branch: thread.branch,
        worktree_path: thread.worktree_path,
        latest_turn_id: thread.latest_turn?.turn_id,
        created_at: thread.created_at,
        updated_at,
        deleted_at: thread.deleted_at,
      });
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    return this.sdk._require_thread(thread.id);
  }

  async delete(): Promise<void> {
    const thread = this.sdk._require_thread(this.id);
    const deleted_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.deleted",
        command_id: newId(),
        occurred_at: deleted_at,
        payload: { threadId: thread.id, deletedAt: deleted_at },
      });
      this.sdk.upsert_thread_row(db, {
        thread_id: thread.id,
        project_id: thread.project_id,
        title: thread.title,
        model: thread.model,
        runtime_mode: thread.runtime_mode,
        interaction_mode: thread.interaction_mode,
        branch: thread.branch,
        worktree_path: thread.worktree_path,
        latest_turn_id: thread.latest_turn?.turn_id,
        created_at: thread.created_at,
        updated_at: deleted_at,
        deleted_at,
      });
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
  }

  async run(
    text: string,
    options: {
      message_id?: string;
      attachments?: unknown[];
      provider?: string;
      model?: string;
      model_options?: JsonMap;
      provider_options?: JsonMap;
      assistant_delivery_mode?: string;
      source_proposed_plan_thread_id?: string;
      source_proposed_plan_id?: string;
      timeout?: number;
    } = {},
  ): Promise<Message> {
    const thread = this.sdk._require_thread(this.id);
    if (typeof text !== "string") {
      throw new TypeError("text must be a string");
    }
    if (!text.trim()) {
      throw new Error("text must be a non-empty string");
    }
    if (text.length > MAX_INPUT_CHARS) {
      throw new Error(`text must be at most ${MAX_INPUT_CHARS} characters`);
    }
    const normalized_provider = options.provider ? validateEnum(options.provider, "provider", PROVIDERS) : undefined;
    const normalized_model = optionalTrimmed(options.model, "model");
    const normalized_model_options = validateJsonMapping(options.model_options, "model_options");
    const normalized_provider_options = validateJsonMapping(options.provider_options, "provider_options");
    const normalized_delivery_mode = validateEnum(
      options.assistant_delivery_mode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
      "assistant_delivery_mode",
      ASSISTANT_DELIVERY_MODES,
    );
    const source_thread_id = optionalTrimmed(options.source_proposed_plan_thread_id, "source_proposed_plan_thread_id");
    const source_plan_id = optionalTrimmed(options.source_proposed_plan_id, "source_proposed_plan_id");
    if ((source_thread_id === undefined) !== (source_plan_id === undefined)) {
      throw new Error("source_proposed_plan_thread_id and source_proposed_plan_id must be provided together");
    }
    const message_id = optionalTrimmed(options.message_id, "message_id") ?? newId();
    const created_at = utcNow();
    await this.sdk.server.dispatch_command({
      type: "thread.turn.start",
      commandId: newId(),
      threadId: thread.id,
      message: {
        messageId: message_id,
        role: "user",
        text,
        attachments: validateLiveAttachments(options.attachments),
      },
      ...(normalized_provider ? { provider: normalized_provider } : {}),
      ...(normalized_model ? { model: normalized_model } : {}),
      ...(normalized_model_options ? { modelOptions: normalized_model_options } : {}),
      ...(normalized_provider_options ? { providerOptions: normalized_provider_options } : {}),
      assistantDeliveryMode: normalized_delivery_mode,
      runtimeMode: thread.runtime_mode,
      interactionMode: thread.interaction_mode,
      ...(source_thread_id && source_plan_id
        ? {
            sourceProposedPlan: {
              threadId: source_thread_id,
              planId: source_plan_id,
            },
          }
        : {}),
      createdAt: created_at,
    });
    const message = await this.sdk._wait_for_message(message_id, options.timeout);
    if (message) {
      return message;
    }
    return {
      id: message_id,
      thread_id: thread.id,
      turn_id: undefined,
      role: "user",
      text,
      attachments: [],
      streaming: false,
      created_at,
      updated_at: created_at,
    };
  }
}

export class ThreadMessagesManager {
  constructor(
    private readonly sdk: T3Code,
    private readonly thread_id: string,
  ) {}

  async list(options: { limit?: number } = {}): Promise<Message[]> {
    this.sdk._require_thread(this.thread_id);
    const db = this.sdk.connect();
    try {
      const rows = db.prepare(`
        SELECT * FROM projection_thread_messages WHERE thread_id = ? ORDER BY created_at ASC, message_id ASC
      `).all(this.thread_id) as Row[];
      const messages = rows.map((row) => this.sdk.message_from_row(row));
      if (options.limit === undefined) {
        return messages;
      }
      if (!Number.isInteger(options.limit) || (options.limit ?? 0) < 1) {
        throw new Error("limit must be a positive integer");
      }
      return messages.slice(-Number(options.limit));
    } finally {
      db.close();
    }
  }

  async send(
    text: string,
    options: {
      run?: boolean;
      message_id?: string;
      attachments?: unknown[];
      provider?: string;
      model?: string;
      model_options?: JsonMap;
      provider_options?: JsonMap;
      assistant_delivery_mode?: string;
      source_proposed_plan_thread_id?: string;
      source_proposed_plan_id?: string;
    } = {},
  ): Promise<Message> {
    if (options.run) {
      return new ThreadHandle(this.sdk, this.thread_id).run(text, options);
    }
    const thread = this.sdk._require_thread(this.thread_id);
    if (typeof text !== "string") {
      throw new TypeError("text must be a string");
    }
    if (!text.trim()) {
      throw new Error("text must be a non-empty string");
    }
    if (text.length > MAX_INPUT_CHARS) {
      throw new Error(`text must be at most ${MAX_INPUT_CHARS} characters`);
    }
    const normalized_attachments = validateAttachments(options.attachments);
    const normalized_provider = options.provider ? validateEnum(options.provider, "provider", PROVIDERS) : undefined;
    const normalized_model = optionalTrimmed(options.model, "model");
    const normalized_model_options = validateJsonMapping(options.model_options, "model_options");
    const normalized_provider_options = validateJsonMapping(options.provider_options, "provider_options");
    const normalized_delivery_mode = validateEnum(
      options.assistant_delivery_mode ?? DEFAULT_ASSISTANT_DELIVERY_MODE,
      "assistant_delivery_mode",
      ASSISTANT_DELIVERY_MODES,
    );
    const source_thread_id = optionalTrimmed(options.source_proposed_plan_thread_id, "source_proposed_plan_thread_id");
    const source_plan_id = optionalTrimmed(options.source_proposed_plan_id, "source_proposed_plan_id");
    if ((source_thread_id === undefined) !== (source_plan_id === undefined)) {
      throw new Error("source_proposed_plan_thread_id and source_proposed_plan_id must be provided together");
    }
    const now = utcNow();
    const message_id = optionalTrimmed(options.message_id, "message_id") ?? newId();
    const command_id = newId();

    this.sdk.transaction((db) => {
      const user_event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.message-sent",
        command_id,
        occurred_at: now,
        payload: {
          threadId: thread.id,
          messageId: message_id,
          role: "user",
          text,
          attachments: normalized_attachments,
          turnId: null,
          streaming: false,
          createdAt: now,
          updatedAt: now,
        },
      });
      db.prepare(`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at
        )
        VALUES (?, ?, NULL, 'user', ?, ?, 0, ?, ?)
        ON CONFLICT(message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = excluded.attachments_json,
          is_streaming = excluded.is_streaming,
          created_at = excluded.created_at,
          updated_at = excluded.updated_at
      `).run(message_id, thread.id, text, normalized_attachments.length > 0 ? JSON.stringify(normalized_attachments) : null, now, now);

      const turn_event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.turn-start-requested",
        command_id,
        occurred_at: now,
        causation_event_id: user_event.event_id,
        payload: {
          threadId: thread.id,
          messageId: message_id,
          ...(normalized_provider ? { provider: normalized_provider } : {}),
          ...(normalized_model ? { model: normalized_model } : {}),
          ...(normalized_model_options ? { modelOptions: normalized_model_options } : {}),
          ...(normalized_provider_options ? { providerOptions: normalized_provider_options } : {}),
          assistantDeliveryMode: normalized_delivery_mode,
          runtimeMode: thread.runtime_mode,
          interactionMode: thread.interaction_mode,
          ...(source_thread_id && source_plan_id
            ? { sourceProposedPlan: { threadId: source_thread_id, planId: source_plan_id } }
            : {}),
          createdAt: now,
        },
      });

      db.prepare(`
        DELETE FROM projection_turns
        WHERE thread_id = ? AND turn_id IS NULL AND state = 'pending' AND checkpoint_turn_count IS NULL
      `).run(thread.id);
      db.prepare(`
        INSERT INTO projection_turns (
          thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id, source_proposed_plan_id,
          assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_turn_count,
          checkpoint_ref, checkpoint_status, checkpoint_files_json
        )
        VALUES (?, NULL, ?, ?, ?, NULL, 'pending', ?, NULL, NULL, NULL, NULL, NULL, '[]')
      `).run(thread.id, message_id, source_thread_id ?? null, source_plan_id ?? null, now);
      db.prepare(`UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?`).run(now, thread.id);
      this.sdk.touch_projection_state(db, turn_event.sequence, turn_event.occurred_at);
    });

    const db = this.sdk.connect();
    try {
      const row = db.prepare("SELECT * FROM projection_thread_messages WHERE message_id = ?").get(message_id) as Row;
      return this.sdk.message_from_row(row);
    } finally {
      db.close();
    }
  }

  async record_assistant(options: {
    turn_id: string;
    text: string;
    message_id?: string;
    attachments?: unknown[];
    streaming?: boolean;
  }): Promise<Message> {
    const thread = this.sdk._require_thread(this.thread_id);
    const normalized_turn_id = trimmed(options.turn_id, "turn_id");
    if (typeof options.text !== "string") {
      throw new TypeError("text must be a string");
    }
    const normalized_attachments = validateAttachments(options.attachments);
    const message_id = optionalTrimmed(options.message_id, "message_id") ?? newId();
    const now = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.message-sent",
        command_id: `server:${newId()}`,
        occurred_at: now,
        payload: {
          threadId: thread.id,
          messageId: message_id,
          role: "assistant",
          text: options.text,
          ...(normalized_attachments.length > 0 ? { attachments: normalized_attachments } : {}),
          turnId: normalized_turn_id,
          streaming: Boolean(options.streaming),
          createdAt: now,
          updatedAt: now,
        },
      });
      const existing = db.prepare("SELECT * FROM projection_thread_messages WHERE message_id = ?").get(message_id) as Row | undefined;
      const next_text =
        existing && options.streaming ? `${String(existing.text ?? "")}${options.text}` : options.text || String(existing?.text ?? "");
      const next_attachments =
        normalized_attachments.length > 0 ? normalized_attachments : existing ? jsonLoads(existing.attachments_json, []) : undefined;
      db.prepare(`
        INSERT INTO projection_thread_messages (
          message_id, thread_id, turn_id, role, text, attachments_json, is_streaming, created_at, updated_at
        )
        VALUES (?, ?, ?, 'assistant', ?, ?, ?, ?, ?)
        ON CONFLICT(message_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          role = excluded.role,
          text = excluded.text,
          attachments_json = COALESCE(excluded.attachments_json, projection_thread_messages.attachments_json),
          is_streaming = excluded.is_streaming,
          created_at = projection_thread_messages.created_at,
          updated_at = excluded.updated_at
      `).run(
        message_id,
        thread.id,
        normalized_turn_id,
        next_text,
        next_attachments ? JSON.stringify(next_attachments) : null,
        options.streaming ? 1 : 0,
        existing ? String(existing.created_at ?? now) : now,
        now,
      );
      const turn_row = db.prepare("SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id = ?").get(thread.id, normalized_turn_id) as Row | undefined;
      if (!turn_row) {
        db.prepare(`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id, source_proposed_plan_id,
            assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_turn_count,
            checkpoint_ref, checkpoint_status, checkpoint_files_json
          )
          VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]')
        `).run(
          thread.id,
          normalized_turn_id,
          message_id,
          options.streaming ? "running" : "completed",
          now,
          now,
          options.streaming ? null : now,
        );
      } else {
        let next_state = String(turn_row.state);
        if (!options.streaming && next_state !== "interrupted" && next_state !== "error") {
          next_state = "completed";
        }
        db.prepare(`
          UPDATE projection_turns
          SET assistant_message_id = ?, state = ?, started_at = COALESCE(started_at, ?),
              requested_at = COALESCE(requested_at, ?), completed_at = ?
          WHERE thread_id = ? AND turn_id = ?
        `).run(
          message_id,
          next_state,
          now,
          now,
          options.streaming ? null : String(turn_row.completed_at ?? now),
          thread.id,
          normalized_turn_id,
        );
      }
      db.prepare("UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?").run(
        normalized_turn_id,
        now,
        thread.id,
      );
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });

    const db = this.sdk.connect();
    try {
      const row = db.prepare("SELECT * FROM projection_thread_messages WHERE message_id = ?").get(message_id) as Row;
      return this.sdk.message_from_row(row);
    } finally {
      db.close();
    }
  }
}

export class ThreadActivitiesManager {
  constructor(
    private readonly sdk: T3Code,
    private readonly thread_id: string,
  ) {}

  async list(options: { limit?: number } = {}): Promise<ThreadActivity[]> {
    const activities = this.sdk._require_thread(this.thread_id).activities;
    if (options.limit === undefined) {
      return activities;
    }
    if (!Number.isInteger(options.limit) || (options.limit ?? 0) < 1) {
      throw new Error("limit must be a positive integer");
    }
    return activities.slice(-Number(options.limit));
  }

  async append(options: {
    kind: string;
    summary: string;
    payload?: JsonMap;
    tone?: string;
    turn_id?: string;
    sequence?: number;
    activity_id?: string;
  }): Promise<ThreadActivity> {
    const thread = this.sdk._require_thread(this.thread_id);
    const normalized_kind = trimmed(options.kind, "kind");
    const normalized_summary = trimmed(options.summary, "summary");
    const normalized_payload = options.payload ?? {};
    if (typeof normalized_payload !== "object" || Array.isArray(normalized_payload)) {
      throw new TypeError("payload must be a dictionary");
    }
    const normalized_tone = validateEnum(options.tone ?? "info", "tone", ACTIVITY_TONES);
    const normalized_turn_id = optionalTrimmed(options.turn_id, "turn_id");
    if (options.sequence !== undefined && (!Number.isInteger(options.sequence) || options.sequence < 0)) {
      throw new Error("sequence must be a non-negative integer");
    }
    const activity_id = optionalTrimmed(options.activity_id, "activity_id") ?? newId();
    const created_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.activity-appended",
        command_id: `server:${newId()}`,
        occurred_at: created_at,
        metadata: typeof normalized_payload.requestId === "string" ? { requestId: normalized_payload.requestId } : {},
        payload: {
          threadId: thread.id,
          activity: {
            id: activity_id,
            tone: normalized_tone,
            kind: normalized_kind,
            summary: normalized_summary,
            payload: normalized_payload,
            turnId: normalized_turn_id ?? null,
            ...(options.sequence !== undefined ? { sequence: options.sequence } : {}),
            createdAt: created_at,
          },
        },
      });
      db.prepare(`
        INSERT INTO projection_thread_activities (
          activity_id, thread_id, turn_id, tone, kind, summary, payload_json, created_at, sequence
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(activity_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          tone = excluded.tone,
          kind = excluded.kind,
          summary = excluded.summary,
          payload_json = excluded.payload_json,
          created_at = excluded.created_at,
          sequence = excluded.sequence
      `).run(
        activity_id,
        thread.id,
        normalized_turn_id ?? null,
        normalized_tone,
        normalized_kind,
        normalized_summary,
        JSON.stringify(normalized_payload),
        created_at,
        options.sequence ?? null,
      );

      const request_id = normalized_payload.requestId;
      if (typeof request_id === "string") {
        const existing = db.prepare("SELECT * FROM projection_pending_approvals WHERE request_id = ?").get(request_id) as Row | undefined;
        if (normalized_kind === "approval.resolved") {
          const decision = typeof normalized_payload.decision === "string" && APPROVAL_DECISIONS.has(normalized_payload.decision)
            ? normalized_payload.decision
            : null;
          db.prepare(`
            INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status, decision, created_at, resolved_at)
            VALUES (?, ?, ?, 'resolved', ?, ?, ?)
            ON CONFLICT(request_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              status = excluded.status,
              decision = excluded.decision,
              created_at = projection_pending_approvals.created_at,
              resolved_at = excluded.resolved_at
          `).run(
            request_id,
            existing ? String(existing.thread_id ?? thread.id) : thread.id,
            existing?.turn_id !== undefined && existing?.turn_id !== null
              ? String(existing.turn_id)
              : (normalized_turn_id ?? null),
            decision,
            existing ? String(existing.created_at ?? created_at) : created_at,
            created_at,
          );
        } else if (!existing || existing.status !== "resolved") {
          db.prepare(`
            INSERT INTO projection_pending_approvals (request_id, thread_id, turn_id, status, decision, created_at, resolved_at)
            VALUES (?, ?, ?, 'pending', NULL, ?, NULL)
            ON CONFLICT(request_id)
            DO UPDATE SET
              thread_id = excluded.thread_id,
              turn_id = excluded.turn_id,
              status = excluded.status,
              decision = NULL,
              created_at = projection_pending_approvals.created_at,
              resolved_at = NULL
          `).run(
            request_id,
            thread.id,
            normalized_turn_id ?? null,
            existing ? String(existing.created_at ?? created_at) : created_at,
          );
        }
      }

      db.prepare("UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?").run(created_at, thread.id);
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    const db = this.sdk.connect();
    try {
      const row = db.prepare("SELECT * FROM projection_thread_activities WHERE activity_id = ?").get(activity_id) as Row;
      return this.sdk.activity_from_row(row);
    } finally {
      db.close();
    }
  }
}

export class ThreadSessionManager {
  constructor(
    private readonly sdk: T3Code,
    private readonly thread_id: string,
  ) {}

  async get(): Promise<Session | undefined> {
    return this.sdk._require_thread(this.thread_id).session;
  }

  async set(options: {
    status: string;
    provider_name?: string;
    runtime_mode?: string;
    active_turn_id?: string;
    last_error?: string;
  }): Promise<Session> {
    const thread = this.sdk._require_thread(this.thread_id);
    const normalized_status = validateEnum(options.status, "status", SESSION_STATUSES);
    const normalized_provider_name = optionalTrimmed(options.provider_name, "provider_name");
    const normalized_runtime_mode =
      options.runtime_mode !== undefined
        ? validateEnum(options.runtime_mode, "runtime_mode", RUNTIME_MODES)
        : thread.runtime_mode;
    const normalized_active_turn_id = optionalTrimmed(options.active_turn_id, "active_turn_id");
    const normalized_last_error = options.last_error !== undefined ? optionalTrimmed(options.last_error, "last_error") : undefined;
    const updated_at = utcNow();

    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.session-set",
        command_id: `server:${newId()}`,
        occurred_at: updated_at,
        payload: {
          threadId: thread.id,
          session: {
            threadId: thread.id,
            status: normalized_status,
            providerName: normalized_provider_name ?? null,
            runtimeMode: normalized_runtime_mode,
            activeTurnId: normalized_active_turn_id ?? null,
            lastError: normalized_last_error ?? null,
            updatedAt: updated_at,
          },
        },
      });
      db.prepare(`
        INSERT INTO projection_thread_sessions (
          thread_id, status, provider_name, runtime_mode, active_turn_id, last_error, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(thread_id)
        DO UPDATE SET
          status = excluded.status,
          provider_name = excluded.provider_name,
          runtime_mode = excluded.runtime_mode,
          active_turn_id = excluded.active_turn_id,
          last_error = excluded.last_error,
          updated_at = excluded.updated_at
      `).run(thread.id, normalized_status, normalized_provider_name ?? null, normalized_runtime_mode, normalized_active_turn_id ?? null, normalized_last_error ?? null, updated_at);

      if (normalized_active_turn_id && normalized_status === "running") {
        const pending = db.prepare(`
          SELECT * FROM projection_turns
          WHERE thread_id = ? AND turn_id IS NULL AND state = 'pending' AND checkpoint_turn_count IS NULL
          ORDER BY requested_at DESC LIMIT 1
        `).get(thread.id) as Row | undefined;
        const existing_turn = db.prepare(`
          SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id = ?
        `).get(thread.id, normalized_active_turn_id) as Row | undefined;
        const requested_at = String(pending?.requested_at ?? updated_at);
        const pending_message_id = pending?.pending_message_id ?? null;
        const source_plan_thread = pending?.source_proposed_plan_thread_id ?? null;
        const source_plan_id = pending?.source_proposed_plan_id ?? null;
        if (!existing_turn) {
          db.prepare(`
            INSERT INTO projection_turns (
              thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id, source_proposed_plan_id,
              assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_turn_count,
              checkpoint_ref, checkpoint_status, checkpoint_files_json
            )
            VALUES (?, ?, ?, ?, ?, NULL, 'running', ?, ?, NULL, NULL, NULL, NULL, '[]')
          `).run(
            thread.id,
            normalized_active_turn_id,
            pending_message_id === null ? null : String(pending_message_id),
            source_plan_thread === null ? null : String(source_plan_thread),
            source_plan_id === null ? null : String(source_plan_id),
            requested_at,
            requested_at,
          );
        } else {
          db.prepare(`
            UPDATE projection_turns
            SET
              pending_message_id = COALESCE(pending_message_id, ?),
              source_proposed_plan_thread_id = COALESCE(source_proposed_plan_thread_id, ?),
              source_proposed_plan_id = COALESCE(source_proposed_plan_id, ?),
              state = CASE WHEN state IN ('completed', 'error') THEN state ELSE 'running' END,
              requested_at = COALESCE(requested_at, ?),
              started_at = COALESCE(started_at, ?)
            WHERE thread_id = ? AND turn_id = ?
          `).run(
            pending_message_id === null ? null : String(pending_message_id),
            source_plan_thread === null ? null : String(source_plan_thread),
            source_plan_id === null ? null : String(source_plan_id),
            requested_at,
            requested_at,
            thread.id,
            normalized_active_turn_id,
          );
        }
        if (pending?.row_id !== undefined) {
          db.prepare(`DELETE FROM projection_turns WHERE row_id = ?`).run(Number(pending.row_id));
        }
        db.prepare(`UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?`).run(
          normalized_active_turn_id,
          updated_at,
          thread.id,
        );
      } else {
        db.prepare(`UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?`).run(updated_at, thread.id);
      }
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    const session = await this.get();
    if (!session) {
      throw new Error("failed to load session after write");
    }
    return session;
  }

  async stop(): Promise<void> {
    const thread = this.sdk._require_thread(this.thread_id);
    const created_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.session-stop-requested",
        command_id: newId(),
        occurred_at: created_at,
        payload: { threadId: thread.id, createdAt: created_at },
      });
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
  }
}

export class ThreadProposedPlansManager {
  constructor(
    private readonly sdk: T3Code,
    private readonly thread_id: string,
  ) {}

  async list(): Promise<ProposedPlan[]> {
    return this.sdk._require_thread(this.thread_id).proposed_plans;
  }

  async upsert(
    plan_markdown: string,
    options: { plan_id?: string; turn_id?: string; implemented_at?: string; implementation_thread_id?: string } = {},
  ): Promise<ProposedPlan> {
    const thread = this.sdk._require_thread(this.thread_id);
    const normalized_plan_id = optionalTrimmed(options.plan_id, "plan_id") ?? newId();
    const normalized_turn_id = optionalTrimmed(options.turn_id, "turn_id");
    const normalized_markdown = trimmed(plan_markdown, "plan_markdown");
    const normalized_implemented_at = optionalTrimmed(options.implemented_at, "implemented_at");
    const normalized_implementation_thread_id = optionalTrimmed(options.implementation_thread_id, "implementation_thread_id");
    const now = utcNow();
    this.sdk.transaction((db) => {
      const existing = db.prepare("SELECT * FROM projection_thread_proposed_plans WHERE plan_id = ?").get(normalized_plan_id) as Row | undefined;
      const created_at = String(existing?.created_at ?? now);
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.proposed-plan-upserted",
        command_id: `server:${newId()}`,
        occurred_at: now,
        payload: {
          threadId: thread.id,
          proposedPlan: {
            id: normalized_plan_id,
            turnId: normalized_turn_id ?? null,
            planMarkdown: normalized_markdown,
            implementedAt: normalized_implemented_at ?? null,
            implementationThreadId: normalized_implementation_thread_id ?? null,
            createdAt: created_at,
            updatedAt: now,
          },
        },
      });
      db.prepare(`
        INSERT INTO projection_thread_proposed_plans (
          plan_id, thread_id, turn_id, plan_markdown, implemented_at, implementation_thread_id, created_at, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(plan_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          plan_markdown = excluded.plan_markdown,
          implemented_at = excluded.implemented_at,
          implementation_thread_id = excluded.implementation_thread_id,
          created_at = projection_thread_proposed_plans.created_at,
          updated_at = excluded.updated_at
      `).run(
        normalized_plan_id,
        thread.id,
        normalized_turn_id ?? null,
        normalized_markdown,
        normalized_implemented_at ?? null,
        normalized_implementation_thread_id ?? null,
        created_at,
        now,
      );
      db.prepare(`UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?`).run(now, thread.id);
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    const db = this.sdk.connect();
    try {
      const row = db.prepare("SELECT * FROM projection_thread_proposed_plans WHERE plan_id = ?").get(normalized_plan_id) as Row;
      return this.sdk.plan_from_row(row);
    } finally {
      db.close();
    }
  }
}

export class ThreadApprovalsManager {
  constructor(
    private readonly sdk: T3Code,
    private readonly thread_id: string,
  ) {}

  async list(options: { active_only?: boolean } = {}): Promise<PendingApproval[]> {
    const approvals = this.sdk._require_thread(this.thread_id).pending_approvals;
    return options.active_only ? approvals.filter((approval) => approval.status === "pending") : approvals;
  }

  async respond(request_id: string, decision: string): Promise<PendingApproval> {
    const thread = this.sdk._require_thread(this.thread_id);
    const normalized_request_id = trimmed(request_id, "request_id");
    const normalized_decision = validateEnum(decision, "decision", APPROVAL_DECISIONS);
    const created_at = utcNow();
    this.sdk.transaction((db) => {
      const existing = db.prepare("SELECT * FROM projection_pending_approvals WHERE request_id = ?").get(normalized_request_id) as Row | undefined;
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.approval-response-requested",
        command_id: newId(),
        occurred_at: created_at,
        payload: {
          threadId: thread.id,
          requestId: normalized_request_id,
          decision: normalized_decision,
          createdAt: created_at,
        },
      });
      db.prepare(`
        INSERT INTO projection_pending_approvals (
          request_id, thread_id, turn_id, status, decision, created_at, resolved_at
        )
        VALUES (?, ?, ?, 'resolved', ?, ?, ?)
        ON CONFLICT(request_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = COALESCE(projection_pending_approvals.turn_id, excluded.turn_id),
          status = excluded.status,
          decision = excluded.decision,
          created_at = projection_pending_approvals.created_at,
          resolved_at = excluded.resolved_at
      `).run(
        normalized_request_id,
        existing ? String(existing.thread_id ?? thread.id) : thread.id,
        existing?.turn_id !== undefined && existing?.turn_id !== null ? String(existing.turn_id) : null,
        normalized_decision,
        existing ? String(existing.created_at ?? created_at) : created_at,
        created_at,
      );
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    const db = this.sdk.connect();
    try {
      const row = db.prepare("SELECT * FROM projection_pending_approvals WHERE request_id = ?").get(normalized_request_id) as Row;
      return this.sdk.approval_from_row(row);
    } finally {
      db.close();
    }
  }

  async respond_to_user_input(request_id: string, answers: JsonMap): Promise<void> {
    const thread = this.sdk._require_thread(this.thread_id);
    const normalized_request_id = trimmed(request_id, "request_id");
    if (typeof answers !== "object" || answers === null || Array.isArray(answers)) {
      throw new TypeError("answers must be a dictionary");
    }
    const created_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.user-input-response-requested",
        command_id: newId(),
        occurred_at: created_at,
        payload: {
          threadId: thread.id,
          requestId: normalized_request_id,
          answers,
          createdAt: created_at,
        },
      });
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
  }
}

export class ThreadTurnsManager {
  constructor(
    private readonly sdk: T3Code,
    private readonly thread_id: string,
  ) {}

  async list(): Promise<Turn[]> {
    return this.sdk._require_thread(this.thread_id).turns;
  }

  async interrupt(options: { turn_id?: string } = {}): Promise<Turn> {
    const thread = this.sdk._require_thread(this.thread_id);
    const normalized_turn_id = optionalTrimmed(options.turn_id, "turn_id");
    const created_at = utcNow();
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.turn-interrupt-requested",
        command_id: newId(),
        occurred_at: created_at,
        payload: {
          threadId: thread.id,
          ...(normalized_turn_id ? { turnId: normalized_turn_id } : {}),
          createdAt: created_at,
        },
      });
      if (normalized_turn_id) {
        const existing = db.prepare("SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id = ?").get(thread.id, normalized_turn_id) as Row | undefined;
        if (!existing) {
          db.prepare(`
            INSERT INTO projection_turns (
              thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id, source_proposed_plan_id,
              assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_turn_count,
              checkpoint_ref, checkpoint_status, checkpoint_files_json
            )
            VALUES (?, ?, NULL, NULL, NULL, NULL, 'interrupted', ?, ?, ?, NULL, NULL, NULL, '[]')
          `).run(thread.id, normalized_turn_id, created_at, created_at, created_at);
        } else {
          db.prepare(`
            UPDATE projection_turns
            SET state = 'interrupted',
                started_at = COALESCE(started_at, ?),
                requested_at = COALESCE(requested_at, ?),
                completed_at = COALESCE(completed_at, ?)
            WHERE thread_id = ? AND turn_id = ?
          `).run(created_at, created_at, created_at, thread.id, normalized_turn_id);
          db.prepare(`UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?`).run(
            normalized_turn_id,
            created_at,
            thread.id,
          );
        }
      }
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    if (!normalized_turn_id) {
      const turns = await this.list();
      if (turns.length === 0) {
        throw new Error("interrupt recorded but no turns exist on thread");
      }
      return turns.at(-1) as Turn;
    }
    const turns = await this.list();
    const turn = turns.find((entry) => entry.turn_id === normalized_turn_id);
    if (!turn) {
      throw new Error("interrupt recorded but target turn is missing");
    }
    return turn;
  }

  async complete_diff(options: {
    turn_id: string;
    checkpoint_turn_count: number;
    checkpoint_ref: string;
    status: string;
    files?: Array<Record<string, unknown>>;
    assistant_message_id?: string;
    completed_at?: string;
  }): Promise<Turn> {
    const thread = this.sdk._require_thread(this.thread_id);
    const normalized_turn_id = trimmed(options.turn_id, "turn_id");
    if (!Number.isInteger(options.checkpoint_turn_count) || options.checkpoint_turn_count < 0) {
      throw new Error("checkpoint_turn_count must be a non-negative integer");
    }
    const normalized_checkpoint_ref = trimmed(options.checkpoint_ref, "checkpoint_ref");
    const normalized_status = validateEnum(options.status, "status", new Set(["ready", "missing", "error"]));
    const normalized_assistant_message_id = optionalTrimmed(options.assistant_message_id, "assistant_message_id");
    const normalized_completed_at = optionalTrimmed(options.completed_at, "completed_at") ?? utcNow();
    const normalized_files = (options.files ?? []).map((item, index) => {
      if (typeof item !== "object" || item === null || Array.isArray(item)) {
        throw new TypeError(`files[${index}] must be a dictionary`);
      }
      const additions = (item as Record<string, unknown>).additions;
      const deletions = (item as Record<string, unknown>).deletions;
      if (!Number.isInteger(additions) || Number(additions) < 0) {
        throw new Error("checkpoint file additions must be a non-negative integer");
      }
      if (!Number.isInteger(deletions) || Number(deletions) < 0) {
        throw new Error("checkpoint file deletions must be a non-negative integer");
      }
      return {
        path: trimmed((item as Record<string, unknown>).path ?? "", "files.path"),
        kind: trimmed((item as Record<string, unknown>).kind ?? "", "files.kind"),
        additions: Number(additions),
        deletions: Number(deletions),
      };
    });
    this.sdk.transaction((db) => {
      const event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.turn-diff-completed",
        command_id: `server:${newId()}`,
        occurred_at: normalized_completed_at,
        payload: {
          threadId: thread.id,
          turnId: normalized_turn_id,
          checkpointTurnCount: options.checkpoint_turn_count,
          checkpointRef: normalized_checkpoint_ref,
          status: normalized_status,
          files: normalized_files,
          assistantMessageId: normalized_assistant_message_id ?? null,
          completedAt: normalized_completed_at,
        },
      });
      db.prepare(`
        UPDATE projection_turns
        SET checkpoint_turn_count = NULL, checkpoint_ref = NULL, checkpoint_status = NULL, checkpoint_files_json = '[]'
        WHERE thread_id = ? AND checkpoint_turn_count = ? AND (turn_id IS NULL OR turn_id <> ?)
      `).run(thread.id, options.checkpoint_turn_count, normalized_turn_id);
      const existing = db.prepare("SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id = ?").get(thread.id, normalized_turn_id) as Row | undefined;
      const next_state = normalized_status === "error" ? "error" : "completed";
      if (!existing) {
        db.prepare(`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id, source_proposed_plan_id,
            assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_turn_count,
            checkpoint_ref, checkpoint_status, checkpoint_files_json
          )
          VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          thread.id,
          normalized_turn_id,
          normalized_assistant_message_id ?? null,
          next_state,
          normalized_completed_at,
          normalized_completed_at,
          normalized_completed_at,
          options.checkpoint_turn_count,
          normalized_checkpoint_ref,
          normalized_status,
          JSON.stringify(normalized_files),
        );
      } else {
        db.prepare(`
          UPDATE projection_turns
          SET assistant_message_id = ?, state = ?, started_at = COALESCE(started_at, ?),
              requested_at = COALESCE(requested_at, ?), completed_at = ?, checkpoint_turn_count = ?,
              checkpoint_ref = ?, checkpoint_status = ?, checkpoint_files_json = ?
          WHERE thread_id = ? AND turn_id = ?
        `).run(
          normalized_assistant_message_id ?? null,
          next_state,
          normalized_completed_at,
          normalized_completed_at,
          normalized_completed_at,
          options.checkpoint_turn_count,
          normalized_checkpoint_ref,
          normalized_status,
          JSON.stringify(normalized_files),
          thread.id,
          normalized_turn_id,
        );
      }
      db.prepare(`UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?`).run(
        normalized_turn_id,
        normalized_completed_at,
        thread.id,
      );
      this.sdk.touch_projection_state(db, event.sequence, event.occurred_at);
    });
    const turns = await this.list();
    const turn = turns.find((entry) => entry.turn_id === normalized_turn_id);
    if (!turn) {
      throw new Error("turn diff completion recorded but turn is missing");
    }
    return turn;
  }
}

export class ThreadCheckpointsManager {
  constructor(
    private readonly sdk: T3Code,
    private readonly thread_id: string,
  ) {}

  async list(): Promise<CheckpointSummary[]> {
    return this.sdk._require_thread(this.thread_id).checkpoints;
  }

  async revert(turn_count: number): Promise<ThreadModel> {
    if (!Number.isInteger(turn_count) || turn_count < 0) {
      throw new Error("turn_count must be a non-negative integer");
    }
    const thread = this.sdk._require_thread(this.thread_id);
    const created_at = utcNow();
    this.sdk.transaction((db) => {
      const request_event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.checkpoint-revert-requested",
        command_id: newId(),
        occurred_at: created_at,
        payload: { threadId: thread.id, turnCount: turn_count, createdAt: created_at },
      });
      const reverted_event = this.sdk.append_event(db, {
        aggregate_kind: "thread",
        aggregate_id: thread.id,
        event_type: "thread.reverted",
        command_id: `server:${newId()}`,
        occurred_at: created_at,
        payload: { threadId: thread.id, turnCount: turn_count },
      });
      const existing_turns = db.prepare("SELECT * FROM projection_turns WHERE thread_id = ?").all(thread.id) as Row[];
      const kept = existing_turns.filter((row) => row.turn_id !== null && row.checkpoint_turn_count !== null && Number(row.checkpoint_turn_count) <= turn_count);
      const retained_turn_ids = new Set(kept.map((row) => String(row.turn_id)));
      db.prepare("DELETE FROM projection_turns WHERE thread_id = ?").run(thread.id);
      for (const row of kept) {
        db.prepare(`
          INSERT INTO projection_turns (
            thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id, source_proposed_plan_id,
            assistant_message_id, state, requested_at, started_at, completed_at, checkpoint_turn_count,
            checkpoint_ref, checkpoint_status, checkpoint_files_json
          )
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
          String(row.thread_id),
          row.turn_id === null ? null : String(row.turn_id),
          row.pending_message_id === null ? null : String(row.pending_message_id),
          row.source_proposed_plan_thread_id === null ? null : String(row.source_proposed_plan_thread_id),
          row.source_proposed_plan_id === null ? null : String(row.source_proposed_plan_id),
          row.assistant_message_id === null ? null : String(row.assistant_message_id),
          String(row.state),
          String(row.requested_at),
          row.started_at === null ? null : String(row.started_at),
          row.completed_at === null ? null : String(row.completed_at),
          row.checkpoint_turn_count === null ? null : Number(row.checkpoint_turn_count),
          row.checkpoint_ref === null ? null : String(row.checkpoint_ref),
          row.checkpoint_status === null ? null : String(row.checkpoint_status),
          String(row.checkpoint_files_json),
        );
      }
      if (retained_turn_ids.size > 0) {
        const placeholders = [...retained_turn_ids].map(() => "?").join(", ");
        db.prepare(`
          DELETE FROM projection_thread_messages
          WHERE thread_id = ? AND role != 'system' AND turn_id IS NOT NULL AND turn_id NOT IN (${placeholders})
        `).run(thread.id, ...retained_turn_ids);
        db.prepare(`
          DELETE FROM projection_thread_activities
          WHERE thread_id = ? AND turn_id IS NOT NULL AND turn_id NOT IN (${placeholders})
        `).run(thread.id, ...retained_turn_ids);
        db.prepare(`
          DELETE FROM projection_thread_proposed_plans
          WHERE thread_id = ? AND turn_id IS NOT NULL AND turn_id NOT IN (${placeholders})
        `).run(thread.id, ...retained_turn_ids);
      } else {
        db.prepare(`
          DELETE FROM projection_thread_messages WHERE thread_id = ? AND role != 'system' AND turn_id IS NOT NULL
        `).run(thread.id);
        db.prepare(`
          DELETE FROM projection_thread_activities WHERE thread_id = ? AND turn_id IS NOT NULL
        `).run(thread.id);
        db.prepare(`
          DELETE FROM projection_thread_proposed_plans WHERE thread_id = ? AND turn_id IS NOT NULL
        `).run(thread.id);
      }
      const latest_turn_id = kept.length > 0 ? String(kept.at(-1)?.turn_id ?? "") : null;
      db.prepare(`UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?`).run(
        latest_turn_id,
        created_at,
        thread.id,
      );
      this.sdk.touch_projection_state(db, reverted_event.sequence, request_event.occurred_at);
    });
    return this.sdk._require_thread(thread.id);
  }
}

export const T3 = T3Code;

export function create_temp_sdk(server_url?: string): T3Code {
  const dir = mkdtempSync(join(tmpdir(), "t3-code-cli-"));
  return new T3Code(join(dir, "state.sqlite"), server_url ? { server_url } : {});
}
