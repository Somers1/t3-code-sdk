import { DatabaseSync } from "node:sqlite";

//#region src/sdk.d.ts
declare const DEFAULT_DB_PATH: string;
declare const DEFAULT_MODEL = "gpt-5.4";
declare const DEFAULT_RUNTIME_MODE = "full-access";
declare const DEFAULT_INTERACTION_MODE = "default";
declare const DEFAULT_PROVIDER = "codex";
declare const DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered";
type JsonMap = Record<string, unknown>;
type Row = Record<string, unknown>;
interface ProjectScript {
  id: string;
  name: string;
  command: string;
  icon: string;
  run_on_worktree_create: boolean;
}
interface ProjectEntry {
  path: string;
  kind: string;
  parent_path: string | undefined;
}
interface ProjectSearchResult {
  entries: ProjectEntry[];
  truncated: boolean;
}
interface FileWriteResult {
  relative_path: string;
}
interface ImageAttachment {
  id: string;
  name: string;
  mime_type: string;
  size_bytes: number;
  type: string;
}
interface Message {
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
interface ProposedPlan {
  id: string;
  thread_id: string;
  turn_id: string | undefined;
  plan_markdown: string;
  implemented_at: string | undefined;
  implementation_thread_id: string | undefined;
  created_at: string;
  updated_at: string;
}
interface ThreadActivity {
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
interface Session {
  thread_id: string;
  status: string;
  provider_name: string | undefined;
  runtime_mode: string;
  active_turn_id: string | undefined;
  last_error: string | undefined;
  updated_at: string;
}
interface CheckpointFile {
  path: string;
  kind: string;
  additions: number;
  deletions: number;
}
interface CheckpointSummary {
  turn_id: string;
  checkpoint_turn_count: number;
  checkpoint_ref: string;
  status: string;
  files: CheckpointFile[];
  assistant_message_id: string | undefined;
  completed_at: string;
}
interface LatestTurn {
  turn_id: string;
  state: string;
  requested_at: string;
  started_at: string | undefined;
  completed_at: string | undefined;
  assistant_message_id: string | undefined;
  source_proposed_plan_thread_id: string | undefined;
  source_proposed_plan_id: string | undefined;
}
interface PendingApproval {
  request_id: string;
  thread_id: string;
  turn_id: string | undefined;
  status: string;
  decision: string | undefined;
  created_at: string;
  resolved_at: string | undefined;
}
interface Turn {
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
interface DispatchReceipt {
  command_id: string;
  sequence: number;
}
declare class ProjectModel {
  id: string;
  title: string;
  workspace_root: string;
  default_model: string | undefined;
  scripts: ProjectScript[];
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
  private readonly _sdk;
  constructor(id: string, title: string, workspace_root: string, default_model: string | undefined, scripts: ProjectScript[], created_at: string, updated_at: string, deleted_at: string | undefined, _sdk: T3Code);
  refresh(): Promise<ProjectModel>;
  update(options: {
    title?: string;
    workspace_root?: string;
    default_model?: string;
    scripts?: unknown[];
  }): Promise<ProjectModel>;
  delete(): Promise<void>;
  create_thread(options?: {
    title?: string;
    model?: string;
    runtime_mode?: string;
    interaction_mode?: string;
    branch?: string | undefined;
    worktree_path?: string | undefined;
    live?: boolean | undefined;
    timeout?: number | undefined;
  }): Promise<ThreadModel>;
  get_threads(options?: {
    include_deleted?: boolean;
  }): Promise<ThreadModel[]>;
  get_thread(thread_id: string, options?: {
    include_deleted?: boolean;
  }): Promise<ThreadModel | undefined>;
  find_thread(title: string, options?: {
    include_deleted?: boolean;
  }): Promise<ThreadModel | undefined>;
  get_or_create_thread(options: {
    title: string;
    model?: string;
  }): Promise<ThreadModel>;
  search_entries(query: string, options?: {
    limit?: number;
  }): Promise<ProjectSearchResult>;
  write_file(relative_path: string, contents: string): Promise<FileWriteResult>;
}
declare class ThreadModel {
  id: string;
  project_id: string;
  title: string;
  model: string;
  runtime_mode: string;
  interaction_mode: string;
  branch: string | undefined;
  worktree_path: string | undefined;
  latest_turn: LatestTurn | undefined;
  messages: Message[];
  proposed_plans: ProposedPlan[];
  activities: ThreadActivity[];
  checkpoints: CheckpointSummary[];
  turns: Turn[];
  pending_approvals: PendingApproval[];
  session: Session | undefined;
  created_at: string;
  updated_at: string;
  deleted_at: string | undefined;
  private readonly _sdk;
  constructor(id: string, project_id: string, title: string, model: string, runtime_mode: string, interaction_mode: string, branch: string | undefined, worktree_path: string | undefined, latest_turn: LatestTurn | undefined, messages: Message[], proposed_plans: ProposedPlan[], activities: ThreadActivity[], checkpoints: CheckpointSummary[], turns: Turn[], pending_approvals: PendingApproval[], session: Session | undefined, created_at: string, updated_at: string, deleted_at: string | undefined, _sdk: T3Code);
  refresh(): Promise<ThreadModel>;
  update(options: {
    title?: string;
    model?: string;
    branch?: string;
    worktree_path?: string;
  }): Promise<ThreadModel>;
  delete(): Promise<void>;
  send_message(text: string, options?: {
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
  }): Promise<Message>;
  get_messages(options?: {
    limit?: number;
  }): Promise<Message[]>;
  record_assistant_message(options: {
    turn_id: string;
    text: string;
    message_id?: string;
    attachments?: unknown[];
    streaming?: boolean;
  }): Promise<Message>;
  get_activities(options?: {
    limit?: number;
  }): Promise<ThreadActivity[]>;
  append_activity(options: {
    kind: string;
    summary: string;
    payload?: JsonMap;
    tone?: string;
    turn_id?: string;
    sequence?: number;
    activity_id?: string;
  }): Promise<ThreadActivity>;
  get_session(): Promise<Session | undefined>;
  set_session(options: {
    status: string;
    provider_name?: string;
    runtime_mode?: string;
    active_turn_id?: string;
    last_error?: string;
  }): Promise<Session>;
  stop_session(): Promise<void>;
  get_proposed_plans(): Promise<ProposedPlan[]>;
  upsert_proposed_plan(plan_markdown: string, options?: {
    plan_id?: string;
    turn_id?: string;
    implemented_at?: string;
    implementation_thread_id?: string;
  }): Promise<ProposedPlan>;
  get_pending_approvals(options?: {
    active_only?: boolean;
  }): Promise<PendingApproval[]>;
  respond_to_approval(request_id: string, decision: string): Promise<PendingApproval>;
  respond_to_user_input(request_id: string, answers: JsonMap): Promise<void>;
  get_turns(): Promise<Turn[]>;
  interrupt_turn(turn_id?: string): Promise<Turn>;
  complete_diff(options: {
    turn_id: string;
    checkpoint_turn_count: number;
    checkpoint_ref: string;
    status: string;
    files?: Array<Record<string, unknown>>;
    assistant_message_id?: string;
    completed_at?: string;
  }): Promise<Turn>;
  get_checkpoints(): Promise<CheckpointSummary[]>;
  revert_to_checkpoint(turn_count: number): Promise<ThreadModel>;
  set_runtime_mode(runtime_mode: string): Promise<ThreadModel>;
  set_interaction_mode(interaction_mode: string): Promise<ThreadModel>;
  run(text: string, options?: {
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
  }): Promise<Message>;
}
declare class T3ServerClient {
  private readonly server_url?;
  private readonly server_token?;
  private readonly timeout;
  constructor(server_url?: string | undefined, server_token?: string | undefined, timeout?: number);
  get enabled(): boolean;
  require_enabled(): void;
  dispatch_command(command: JsonMap): Promise<DispatchReceipt>;
  private build_url;
  private request;
}
declare class T3Code {
  readonly db_path: string;
  readonly prefer_server: boolean;
  readonly server: T3ServerClient;
  readonly projects: ProjectsManager;
  readonly threads: ThreadsManager;
  constructor(db_path?: string, options?: {
    initialize?: boolean;
    server_url?: string;
    server_token?: string;
    server_timeout?: number;
    prefer_server?: boolean;
  });
  initialize(): void;
  connect(): DatabaseSync;
  private ensure_schema;
  transaction<T>(callback: (db: DatabaseSync) => T): T;
  append_event(db: DatabaseSync, input: {
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
  }): {
    sequence: number;
    event_id: string;
    occurred_at: string;
  };
  touch_projection_state(db: DatabaseSync, sequence: number, occurred_at: string): void;
  project_from_row(row: Row): ProjectModel;
  message_from_row(row: Row): Message;
  plan_from_row(row: Row): ProposedPlan;
  activity_from_row(row: Row): ThreadActivity;
  session_from_row(row: Row): Session;
  approval_from_row(row: Row): PendingApproval;
  turn_from_row(row: Row): Turn;
  latest_turn_from_row(row: Row): LatestTurn;
  thread_from_row(db: DatabaseSync, row: Row): ThreadModel;
  upsert_thread_row(db: DatabaseSync, input: {
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
  }): void;
  _get_project(project_id: string, include_deleted?: boolean): ProjectModel | undefined;
  _require_project(project_id: string): ProjectModel;
  _get_thread(thread_id: string, include_deleted?: boolean): ThreadModel | undefined;
  _require_thread(thread_id: string): ThreadModel;
  private wait_for_row;
  _wait_for_project(project_id: string, timeout?: number): Promise<ProjectModel | undefined>;
  _wait_for_thread(thread_id: string, timeout?: number): Promise<ThreadModel | undefined>;
  _wait_for_message(message_id: string, timeout?: number): Promise<Message | undefined>;
  list_projects(): Promise<ProjectModel[]>;
  get_project(project_id: string): Promise<ProjectModel | undefined>;
  find_project(title: string): Promise<ProjectModel | undefined>;
  get_thread(thread_id: string): Promise<ThreadModel | undefined>;
  find_thread(title: string, options?: {
    project_id?: string;
  }): Promise<ThreadModel | undefined>;
  create_project(workspace_root: string, model?: string): Promise<ProjectModel>;
  delete_project(project_id: string): Promise<void>;
  create_thread(project_id: string, title?: string, model?: string): Promise<ThreadModel>;
  list_threads(project_id: string): Promise<ThreadModel[]>;
  list_messages(thread_id: string, limit?: number): Promise<Message[]>;
  list_activities(thread_id: string, limit?: number): Promise<ThreadActivity[]>;
  get_session(thread_id: string): Promise<Session | undefined>;
  list_active_sessions(): Promise<Row[]>;
}
declare class ProjectsManager {
  private readonly sdk;
  constructor(sdk: T3Code);
  list(options?: {
    include_deleted?: boolean;
  }): Promise<ProjectModel[]>;
  get(project_id: string, options?: {
    include_deleted?: boolean;
  }): Promise<ProjectModel | undefined>;
  get_by_title(title: string, options?: {
    include_deleted?: boolean;
  }): Promise<ProjectModel | undefined>;
  get_by_workspace_root(workspace_root: string, options?: {
    include_deleted?: boolean;
  }): Promise<ProjectModel | undefined>;
  open(project_id: string): ProjectHandle;
  create(options: {
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
  }): Promise<ProjectModel>;
  get_or_create(options: {
    workspace_root: string;
    title?: string;
    default_model?: string;
    scripts?: unknown[];
    create_initial_thread?: boolean;
    initial_thread_title?: string;
    initial_thread_model?: string;
    ensure_workspace_exists?: boolean;
  }): Promise<ProjectModel>;
  update(project_id: string, options: {
    title?: string;
    workspace_root?: string;
    default_model?: string;
    scripts?: unknown[];
  }): Promise<ProjectModel>;
  delete(project_id: string): Promise<void>;
}
declare class ProjectHandle {
  private readonly sdk;
  readonly id: string;
  readonly threads: ProjectThreadsManager;
  readonly files: ProjectFilesManager;
  constructor(sdk: T3Code, id: string);
  get(): Promise<ProjectModel>;
  refresh(): Promise<ProjectModel>;
  update(options: {
    title?: string;
    workspace_root?: string;
    default_model?: string;
    scripts?: unknown[];
  }): Promise<ProjectModel>;
  delete(): Promise<void>;
}
declare class ProjectThreadsManager {
  private readonly sdk;
  private readonly project_id;
  constructor(sdk: T3Code, project_id: string);
  list(options?: {
    include_deleted?: boolean;
  }): Promise<ThreadModel[]>;
  get(thread_id: string, options?: {
    include_deleted?: boolean;
  }): Promise<ThreadModel | undefined>;
  open(thread_id: string): ThreadHandle;
  create(options?: {
    title?: string;
    model?: string;
    runtime_mode?: string;
    interaction_mode?: string;
    branch?: string;
    worktree_path?: string;
    live?: boolean;
    timeout?: number;
  }): Promise<ThreadModel>;
  get_or_create(options: {
    title: string;
    model?: string;
  }): Promise<ThreadModel>;
}
declare class ProjectFilesManager {
  private readonly sdk;
  private readonly project_id;
  constructor(sdk: T3Code, project_id: string);
  private workspace_root;
  search_entries(query: string, options?: {
    limit?: number;
  }): Promise<ProjectSearchResult>;
  write_file(relative_path_input: string, contents: string): Promise<FileWriteResult>;
}
declare class ThreadsManager {
  private readonly sdk;
  constructor(sdk: T3Code);
  list(options?: {
    project_id?: string;
    include_deleted?: boolean;
  }): Promise<ThreadModel[]>;
  get(thread_id: string, options?: {
    include_deleted?: boolean;
  }): Promise<ThreadModel | undefined>;
  open(thread_id: string): ThreadHandle;
}
declare class ThreadHandle {
  private readonly sdk;
  readonly id: string;
  readonly messages: ThreadMessagesManager;
  readonly activities: ThreadActivitiesManager;
  readonly session: ThreadSessionManager;
  readonly proposed_plans: ThreadProposedPlansManager;
  readonly approvals: ThreadApprovalsManager;
  readonly turns: ThreadTurnsManager;
  readonly checkpoints: ThreadCheckpointsManager;
  constructor(sdk: T3Code, id: string);
  get(): Promise<ThreadModel>;
  refresh(): Promise<ThreadModel>;
  update(options: {
    title?: string;
    model?: string;
    branch?: string;
    worktree_path?: string;
  }): Promise<ThreadModel>;
  set_runtime_mode(runtime_mode: string): Promise<ThreadModel>;
  set_interaction_mode(interaction_mode: string): Promise<ThreadModel>;
  delete(): Promise<void>;
  run(text: string, options?: {
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
  }): Promise<Message>;
}
declare class ThreadMessagesManager {
  private readonly sdk;
  private readonly thread_id;
  constructor(sdk: T3Code, thread_id: string);
  list(options?: {
    limit?: number;
  }): Promise<Message[]>;
  send(text: string, options?: {
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
  }): Promise<Message>;
  record_assistant(options: {
    turn_id: string;
    text: string;
    message_id?: string;
    attachments?: unknown[];
    streaming?: boolean;
  }): Promise<Message>;
}
declare class ThreadActivitiesManager {
  private readonly sdk;
  private readonly thread_id;
  constructor(sdk: T3Code, thread_id: string);
  list(options?: {
    limit?: number;
  }): Promise<ThreadActivity[]>;
  append(options: {
    kind: string;
    summary: string;
    payload?: JsonMap;
    tone?: string;
    turn_id?: string;
    sequence?: number;
    activity_id?: string;
  }): Promise<ThreadActivity>;
}
declare class ThreadSessionManager {
  private readonly sdk;
  private readonly thread_id;
  constructor(sdk: T3Code, thread_id: string);
  get(): Promise<Session | undefined>;
  set(options: {
    status: string;
    provider_name?: string;
    runtime_mode?: string;
    active_turn_id?: string;
    last_error?: string;
  }): Promise<Session>;
  stop(): Promise<void>;
}
declare class ThreadProposedPlansManager {
  private readonly sdk;
  private readonly thread_id;
  constructor(sdk: T3Code, thread_id: string);
  list(): Promise<ProposedPlan[]>;
  upsert(plan_markdown: string, options?: {
    plan_id?: string;
    turn_id?: string;
    implemented_at?: string;
    implementation_thread_id?: string;
  }): Promise<ProposedPlan>;
}
declare class ThreadApprovalsManager {
  private readonly sdk;
  private readonly thread_id;
  constructor(sdk: T3Code, thread_id: string);
  list(options?: {
    active_only?: boolean;
  }): Promise<PendingApproval[]>;
  respond(request_id: string, decision: string): Promise<PendingApproval>;
  respond_to_user_input(request_id: string, answers: JsonMap): Promise<void>;
}
declare class ThreadTurnsManager {
  private readonly sdk;
  private readonly thread_id;
  constructor(sdk: T3Code, thread_id: string);
  list(): Promise<Turn[]>;
  interrupt(options?: {
    turn_id?: string;
  }): Promise<Turn>;
  complete_diff(options: {
    turn_id: string;
    checkpoint_turn_count: number;
    checkpoint_ref: string;
    status: string;
    files?: Array<Record<string, unknown>>;
    assistant_message_id?: string;
    completed_at?: string;
  }): Promise<Turn>;
}
declare class ThreadCheckpointsManager {
  private readonly sdk;
  private readonly thread_id;
  constructor(sdk: T3Code, thread_id: string);
  list(): Promise<CheckpointSummary[]>;
  revert(turn_count: number): Promise<ThreadModel>;
}
declare const T3: typeof T3Code;
declare function create_temp_sdk(server_url?: string): T3Code;
//#endregion
export { CheckpointFile, CheckpointSummary, DEFAULT_ASSISTANT_DELIVERY_MODE, DEFAULT_DB_PATH, DEFAULT_INTERACTION_MODE, DEFAULT_MODEL, DEFAULT_PROVIDER, DEFAULT_RUNTIME_MODE, DispatchReceipt, FileWriteResult, ImageAttachment, LatestTurn, Message, PendingApproval, ProjectEntry, ProjectFilesManager, ProjectHandle, ProjectModel, ProjectScript, ProjectSearchResult, ProjectThreadsManager, ProjectsManager, ProposedPlan, Session, T3, T3Code, T3ServerClient, ThreadActivitiesManager, ThreadActivity, ThreadApprovalsManager, ThreadCheckpointsManager, ThreadHandle, ThreadMessagesManager, ThreadModel, ThreadProposedPlansManager, ThreadSessionManager, ThreadTurnsManager, ThreadsManager, Turn, create_temp_sdk };