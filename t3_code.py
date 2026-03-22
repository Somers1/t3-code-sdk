"""Python SDK for T3 Code projects, threads, and orchestration state.

The SDK works directly against T3 Code's SQLite database and keeps the
projection tables in sync with the orchestration event log for client-side
operations.
"""

from __future__ import annotations

import json
import os
import sqlite3
import socket
import ssl
import struct
import time
import uuid
from base64 import b64encode
from contextlib import contextmanager
from dataclasses import dataclass, field
from datetime import datetime, timezone
from hashlib import sha1
from pathlib import Path
from typing import Any, Iterable, Optional
from urllib.parse import parse_qsl, urlencode, urlparse, urlunparse

DEFAULT_DB_PATH = Path.home() / ".t3" / "userdata" / "state.sqlite"
DEFAULT_MODEL = "gpt-5.4"
DEFAULT_RUNTIME_MODE = "full-access"
DEFAULT_INTERACTION_MODE = "default"
DEFAULT_PROVIDER = "codex"
DEFAULT_ASSISTANT_DELIVERY_MODE = "buffered"

MAX_SEARCH_LIMIT = 200
MAX_QUERY_LENGTH = 256
MAX_PATH_LENGTH = 512
MAX_INPUT_CHARS = 120_000
MAX_ATTACHMENTS = 8
MAX_IMAGE_BYTES = 10 * 1024 * 1024

RUNTIME_MODES = {"approval-required", "full-access"}
INTERACTION_MODES = {"default", "plan"}
PROVIDERS = {"codex", "claudeAgent"}
ASSISTANT_DELIVERY_MODES = {"buffered", "streaming"}
APPROVAL_DECISIONS = {"accept", "acceptForSession", "decline", "cancel"}
MESSAGE_ROLES = {"user", "assistant", "system"}
SESSION_STATUSES = {"idle", "starting", "running", "ready", "interrupted", "stopped", "error"}
ACTIVITY_TONES = {"info", "tool", "approval", "error"}
PROJECT_SCRIPT_ICONS = {"play", "test", "lint", "configure", "build", "debug"}
PROJECTOR_NAMES = (
    "projection.projects",
    "projection.threads",
    "projection.thread-messages",
    "projection.thread-proposed-plans",
    "projection.thread-activities",
    "projection.thread-sessions",
    "projection.thread-turns",
    "projection.checkpoints",
    "projection.pending-approvals",
)


def _utc_now() -> str:
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%S.%f")[:-3] + "Z"


def _new_id() -> str:
    return str(uuid.uuid4())


def _trimmed(value: str, name: str, *, allow_empty: bool = False, max_length: int | None = None) -> str:
    if not isinstance(value, str):
        raise TypeError(f"{name} must be a string")
    normalized = value.strip()
    if not allow_empty and not normalized:
        raise ValueError(f"{name} must be a non-empty string")
    if max_length is not None and len(normalized) > max_length:
        raise ValueError(f"{name} must be at most {max_length} characters")
    return normalized


def _optional_trimmed(
    value: Optional[str],
    name: str,
    *,
    max_length: int | None = None,
) -> Optional[str]:
    if value is None:
        return None
    return _trimmed(value, name, max_length=max_length)


def _validate_enum(value: str, name: str, allowed: set[str]) -> str:
    normalized = _trimmed(value, name)
    if normalized not in allowed:
        allowed_values = ", ".join(sorted(allowed))
        raise ValueError(f"{name} must be one of: {allowed_values}")
    return normalized


def _validate_json_mapping(value: Optional[dict[str, Any]], name: str) -> Optional[dict[str, Any]]:
    if value is None:
        return None
    if not isinstance(value, dict):
        raise TypeError(f"{name} must be a dictionary")
    return value


def _json_loads(value: Optional[str], default: Any) -> Any:
    if not value:
        return default
    return json.loads(value)


def _coerce_path(value: str | Path, name: str) -> Path:
    if isinstance(value, Path):
        path = value
    elif isinstance(value, str):
        path = Path(_trimmed(value, name))
    else:
        raise TypeError(f"{name} must be a string or Path")
    return path.expanduser().resolve()


def _relative_path(root: Path, relative_path: str) -> Path:
    normalized = _trimmed(relative_path, "relative_path", max_length=MAX_PATH_LENGTH)
    rel = Path(normalized)
    if rel.is_absolute():
        raise ValueError("relative_path must be relative to the project workspace")
    candidate = (root / rel).resolve()
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise ValueError("relative_path must stay inside the project workspace") from exc
    return candidate


def _validate_attachments(attachments: Optional[Iterable[dict[str, Any]]]) -> list[dict[str, Any]]:
    if attachments is None:
        return []
    if not isinstance(attachments, Iterable):
        raise TypeError("attachments must be an iterable of dictionaries")
    normalized: list[dict[str, Any]] = []
    for index, attachment in enumerate(attachments):
        if not isinstance(attachment, dict):
            raise TypeError(f"attachments[{index}] must be a dictionary")
        attachment_type = _validate_enum(str(attachment.get("type", "image")), "attachment.type", {"image"})
        name = _trimmed(str(attachment.get("name", "")), "attachment.name", max_length=255)
        mime_type = _trimmed(str(attachment.get("mimeType", "")), "attachment.mimeType", max_length=100)
        if not mime_type.lower().startswith("image/"):
            raise ValueError("attachment.mimeType must start with 'image/'")
        size_bytes = attachment.get("sizeBytes")
        if not isinstance(size_bytes, int) or size_bytes < 0 or size_bytes > MAX_IMAGE_BYTES:
            raise ValueError(
                f"attachment.sizeBytes must be an integer between 0 and {MAX_IMAGE_BYTES}"
            )
        attachment_id = attachment.get("id")
        if attachment_id is None:
            attachment_id = _new_id()
        attachment_id = _trimmed(str(attachment_id), "attachment.id", max_length=128)
        normalized.append(
            {
                "type": attachment_type,
                "id": attachment_id,
                "name": name,
                "mimeType": mime_type,
                "sizeBytes": size_bytes,
            }
        )
    if len(normalized) > MAX_ATTACHMENTS:
        raise ValueError(f"attachments cannot contain more than {MAX_ATTACHMENTS} items")
    return normalized


def _validate_scripts(scripts: Optional[Iterable[dict[str, Any]]]) -> list[dict[str, Any]]:
    if scripts is None:
        return []
    normalized: list[dict[str, Any]] = []
    for index, script in enumerate(scripts):
        if not isinstance(script, dict):
            raise TypeError(f"scripts[{index}] must be a dictionary")
        icon = _validate_enum(str(script.get("icon", "")), "script.icon", PROJECT_SCRIPT_ICONS)
        run_on_worktree_create = script.get("runOnWorktreeCreate")
        if not isinstance(run_on_worktree_create, bool):
            raise TypeError("script.runOnWorktreeCreate must be a boolean")
        normalized.append(
            {
                "id": _trimmed(str(script.get("id", "")), "script.id"),
                "name": _trimmed(str(script.get("name", "")), "script.name"),
                "command": _trimmed(str(script.get("command", "")), "script.command"),
                "icon": icon,
                "runOnWorktreeCreate": run_on_worktree_create,
            }
        )
    return normalized


@dataclass(slots=True)
class ProjectScript:
    id: str
    name: str
    command: str
    icon: str
    run_on_worktree_create: bool


@dataclass(slots=True)
class ProjectEntry:
    path: str
    kind: str
    parent_path: Optional[str] = None


@dataclass(slots=True)
class ProjectSearchResult:
    entries: list[ProjectEntry]
    truncated: bool


@dataclass(slots=True)
class FileWriteResult:
    relative_path: str


@dataclass(slots=True)
class ImageAttachment:
    id: str
    name: str
    mime_type: str
    size_bytes: int
    type: str = "image"


@dataclass(slots=True)
class Message:
    id: str
    thread_id: str
    turn_id: Optional[str]
    role: str
    text: str
    attachments: list[ImageAttachment] = field(default_factory=list)
    streaming: bool = False
    created_at: str = ""
    updated_at: str = ""


@dataclass(slots=True)
class ProposedPlan:
    id: str
    thread_id: str
    turn_id: Optional[str]
    plan_markdown: str
    implemented_at: Optional[str] = None
    implementation_thread_id: Optional[str] = None
    created_at: str = ""
    updated_at: str = ""


@dataclass(slots=True)
class ThreadActivity:
    id: str
    thread_id: str
    tone: str
    kind: str
    summary: str
    payload: dict[str, Any]
    turn_id: Optional[str] = None
    sequence: Optional[int] = None
    created_at: str = ""


@dataclass(slots=True)
class Session:
    thread_id: str
    status: str
    provider_name: Optional[str]
    runtime_mode: str
    active_turn_id: Optional[str]
    last_error: Optional[str]
    updated_at: str


@dataclass(slots=True)
class CheckpointFile:
    path: str
    kind: str
    additions: int
    deletions: int


@dataclass(slots=True)
class CheckpointSummary:
    turn_id: str
    checkpoint_turn_count: int
    checkpoint_ref: str
    status: str
    files: list[CheckpointFile] = field(default_factory=list)
    assistant_message_id: Optional[str] = None
    completed_at: str = ""


@dataclass(slots=True)
class LatestTurn:
    turn_id: str
    state: str
    requested_at: str
    started_at: Optional[str]
    completed_at: Optional[str]
    assistant_message_id: Optional[str]
    source_proposed_plan_thread_id: Optional[str] = None
    source_proposed_plan_id: Optional[str] = None


@dataclass(slots=True)
class PendingApproval:
    request_id: str
    thread_id: str
    turn_id: Optional[str]
    status: str
    decision: Optional[str]
    created_at: str
    resolved_at: Optional[str]


@dataclass(slots=True)
class Turn:
    thread_id: str
    turn_id: Optional[str]
    pending_message_id: Optional[str]
    source_proposed_plan_thread_id: Optional[str]
    source_proposed_plan_id: Optional[str]
    assistant_message_id: Optional[str]
    state: str
    requested_at: str
    started_at: Optional[str]
    completed_at: Optional[str]
    checkpoint_turn_count: Optional[int]
    checkpoint_ref: Optional[str]
    checkpoint_status: Optional[str]
    checkpoint_files: list[CheckpointFile] = field(default_factory=list)


@dataclass(slots=True)
class DispatchReceipt:
    command_id: str
    sequence: int


@dataclass(slots=True)
class Project:
    id: str
    title: str
    workspace_root: str
    default_model: Optional[str]
    scripts: list[ProjectScript] = field(default_factory=list)
    created_at: str = ""
    updated_at: str = ""
    deleted_at: Optional[str] = None
    _sdk: Optional["T3"] = field(default=None, repr=False, compare=False)

    def _require_sdk(self) -> "T3":
        if self._sdk is None:
            raise RuntimeError("Project instance is not bound to a T3 client")
        return self._sdk

    def refresh(self) -> "Project":
        return self._require_sdk()._require_project(self.id)

    def update(
        self,
        *,
        title: Optional[str] = None,
        workspace_root: str | Path | None = None,
        default_model: Optional[str] = None,
        scripts: Optional[Iterable[dict[str, Any]]] = None,
    ) -> "Project":
        return self._require_sdk().projects.update(
            self.id,
            title=title,
            workspace_root=workspace_root,
            default_model=default_model,
            scripts=scripts,
        )

    def delete(self) -> None:
        self._require_sdk().projects.delete(self.id)

    def create_thread(
        self,
        *,
        title: str = "New thread",
        model: Optional[str] = None,
        runtime_mode: str = DEFAULT_RUNTIME_MODE,
        interaction_mode: str = DEFAULT_INTERACTION_MODE,
        branch: Optional[str] = None,
        worktree_path: Optional[str] = None,
        live: Optional[bool] = None,
        timeout: Optional[float] = None,
    ) -> "Thread":
        return self._require_sdk().projects.open(self.id).threads.create(
            title=title,
            model=model,
            runtime_mode=runtime_mode,
            interaction_mode=interaction_mode,
            branch=branch,
            worktree_path=worktree_path,
            live=live,
            timeout=timeout,
        )

    def get_threads(self, *, include_deleted: bool = False) -> list["Thread"]:
        return self._require_sdk().projects.open(self.id).threads.list(include_deleted=include_deleted)

    def get_thread(self, thread_id: str, *, include_deleted: bool = False) -> Optional["Thread"]:
        return self._require_sdk().projects.open(self.id).threads.get(
            thread_id,
            include_deleted=include_deleted,
        )

    def find_thread(self, title: str, *, include_deleted: bool = False) -> Optional["Thread"]:
        normalized_title = _trimmed(title, "title")
        for thread in self.get_threads(include_deleted=include_deleted):
            if thread.title == normalized_title:
                return thread
        return None

    def get_or_create_thread(self, *, title: str, model: Optional[str] = None) -> "Thread":
        return self._require_sdk().projects.open(self.id).threads.get_or_create(
            title=title,
            model=model,
        )

    def search_entries(self, query: str, *, limit: int = 50) -> ProjectSearchResult:
        return self._require_sdk().projects.open(self.id).files.search_entries(query, limit=limit)

    def write_file(self, relative_path: str, contents: str) -> FileWriteResult:
        return self._require_sdk().projects.open(self.id).files.write_file(relative_path, contents)


@dataclass(slots=True)
class Thread:
    id: str
    project_id: str
    title: str
    model: str
    runtime_mode: str = DEFAULT_RUNTIME_MODE
    interaction_mode: str = DEFAULT_INTERACTION_MODE
    branch: Optional[str] = None
    worktree_path: Optional[str] = None
    latest_turn: Optional[LatestTurn] = None
    messages: list[Message] = field(default_factory=list)
    proposed_plans: list[ProposedPlan] = field(default_factory=list)
    activities: list[ThreadActivity] = field(default_factory=list)
    checkpoints: list[CheckpointSummary] = field(default_factory=list)
    turns: list[Turn] = field(default_factory=list)
    pending_approvals: list[PendingApproval] = field(default_factory=list)
    session: Optional[Session] = None
    created_at: str = ""
    updated_at: str = ""
    deleted_at: Optional[str] = None
    _sdk: Optional["T3"] = field(default=None, repr=False, compare=False)

    def _require_sdk(self) -> "T3":
        if self._sdk is None:
            raise RuntimeError("Thread instance is not bound to a T3 client")
        return self._sdk

    def refresh(self) -> "Thread":
        return self._require_sdk()._require_thread(self.id)

    def update(
        self,
        *,
        title: Optional[str] = None,
        model: Optional[str] = None,
        branch: Optional[str] = None,
        worktree_path: Optional[str] = None,
    ) -> "Thread":
        return self._require_sdk().threads.open(self.id).update(
            title=title,
            model=model,
            branch=branch,
            worktree_path=worktree_path,
        )

    def delete(self) -> None:
        self._require_sdk().threads.open(self.id).delete()

    def send_message(
        self,
        text: str,
        *,
        run: bool = False,
        message_id: Optional[str] = None,
        attachments: Optional[Iterable[dict[str, Any]]] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        model_options: Optional[dict[str, Any]] = None,
        provider_options: Optional[dict[str, Any]] = None,
        assistant_delivery_mode: str = DEFAULT_ASSISTANT_DELIVERY_MODE,
        source_proposed_plan_thread_id: Optional[str] = None,
        source_proposed_plan_id: Optional[str] = None,
    ) -> Message:
        if run:
            return self.run(
                text,
                message_id=message_id,
                attachments=attachments,
                provider=provider,
                model=model,
                model_options=model_options,
                provider_options=provider_options,
                assistant_delivery_mode=assistant_delivery_mode,
                source_proposed_plan_thread_id=source_proposed_plan_thread_id,
                source_proposed_plan_id=source_proposed_plan_id,
            )
        return self._require_sdk().threads.open(self.id).messages.send(
            text,
            message_id=message_id,
            attachments=attachments,
            provider=provider,
            model=model,
            model_options=model_options,
            provider_options=provider_options,
            assistant_delivery_mode=assistant_delivery_mode,
            source_proposed_plan_thread_id=source_proposed_plan_thread_id,
            source_proposed_plan_id=source_proposed_plan_id,
        )

    def get_messages(self, *, limit: Optional[int] = None) -> list[Message]:
        return self._require_sdk().threads.open(self.id).messages.list(limit=limit)

    def record_assistant_message(
        self,
        *,
        turn_id: str,
        text: str,
        message_id: Optional[str] = None,
        attachments: Optional[Iterable[dict[str, Any]]] = None,
        streaming: bool = False,
    ) -> Message:
        return self._require_sdk().threads.open(self.id).messages.record_assistant(
            turn_id=turn_id,
            text=text,
            message_id=message_id,
            attachments=attachments,
            streaming=streaming,
        )

    def get_activities(self, *, limit: Optional[int] = None) -> list[ThreadActivity]:
        return self._require_sdk().threads.open(self.id).activities.list(limit=limit)

    def append_activity(
        self,
        *,
        kind: str,
        summary: str,
        payload: Optional[dict[str, Any]] = None,
        tone: str = "info",
        turn_id: Optional[str] = None,
        sequence: Optional[int] = None,
        activity_id: Optional[str] = None,
    ) -> ThreadActivity:
        return self._require_sdk().threads.open(self.id).activities.append(
            kind=kind,
            summary=summary,
            payload=payload,
            tone=tone,
            turn_id=turn_id,
            sequence=sequence,
            activity_id=activity_id,
        )

    def get_session(self) -> Optional[Session]:
        return self._require_sdk().threads.open(self.id).session.get()

    def set_session(
        self,
        *,
        status: str,
        provider_name: Optional[str] = None,
        runtime_mode: Optional[str] = None,
        active_turn_id: Optional[str] = None,
        last_error: Optional[str] = None,
    ) -> Session:
        return self._require_sdk().threads.open(self.id).session.set(
            status=status,
            provider_name=provider_name,
            runtime_mode=runtime_mode,
            active_turn_id=active_turn_id,
            last_error=last_error,
        )

    def stop_session(self) -> None:
        self._require_sdk().threads.open(self.id).session.stop()

    def get_proposed_plans(self) -> list[ProposedPlan]:
        return self._require_sdk().threads.open(self.id).proposed_plans.list()

    def upsert_proposed_plan(
        self,
        plan_markdown: str,
        *,
        plan_id: Optional[str] = None,
        turn_id: Optional[str] = None,
        implemented_at: Optional[str] = None,
        implementation_thread_id: Optional[str] = None,
    ) -> ProposedPlan:
        return self._require_sdk().threads.open(self.id).proposed_plans.upsert(
            plan_markdown,
            plan_id=plan_id,
            turn_id=turn_id,
            implemented_at=implemented_at,
            implementation_thread_id=implementation_thread_id,
        )

    def get_pending_approvals(self, *, active_only: bool = False) -> list[PendingApproval]:
        return self._require_sdk().threads.open(self.id).approvals.list(active_only=active_only)

    def respond_to_approval(self, request_id: str, decision: str) -> PendingApproval:
        return self._require_sdk().threads.open(self.id).approvals.respond(request_id, decision)

    def respond_to_user_input(self, request_id: str, answers: dict[str, Any]) -> None:
        self._require_sdk().threads.open(self.id).approvals.respond_to_user_input(request_id, answers)

    def get_turns(self) -> list[Turn]:
        return self._require_sdk().threads.open(self.id).turns.list()

    def interrupt_turn(self, turn_id: Optional[str] = None) -> Turn:
        return self._require_sdk().threads.open(self.id).turns.interrupt(turn_id=turn_id)

    def complete_diff(
        self,
        *,
        turn_id: str,
        checkpoint_turn_count: int,
        checkpoint_ref: str,
        status: str,
        files: Iterable[dict[str, Any]] | None = None,
        assistant_message_id: Optional[str] = None,
        completed_at: Optional[str] = None,
    ) -> Turn:
        return self._require_sdk().threads.open(self.id).turns.complete_diff(
            turn_id=turn_id,
            checkpoint_turn_count=checkpoint_turn_count,
            checkpoint_ref=checkpoint_ref,
            status=status,
            files=files,
            assistant_message_id=assistant_message_id,
            completed_at=completed_at,
        )

    def get_checkpoints(self) -> list[CheckpointSummary]:
        return self._require_sdk().threads.open(self.id).checkpoints.list()

    def revert_to_checkpoint(self, turn_count: int) -> "Thread":
        return self._require_sdk().threads.open(self.id).checkpoints.revert(turn_count)

    def set_runtime_mode(self, runtime_mode: str) -> "Thread":
        return self._require_sdk().threads.open(self.id).set_runtime_mode(runtime_mode)

    def set_interaction_mode(self, interaction_mode: str) -> "Thread":
        return self._require_sdk().threads.open(self.id).set_interaction_mode(interaction_mode)

    def run(
        self,
        text: str,
        *,
        message_id: Optional[str] = None,
        attachments: Optional[Iterable[dict[str, Any]]] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        model_options: Optional[dict[str, Any]] = None,
        provider_options: Optional[dict[str, Any]] = None,
        assistant_delivery_mode: str = DEFAULT_ASSISTANT_DELIVERY_MODE,
        source_proposed_plan_thread_id: Optional[str] = None,
        source_proposed_plan_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Message:
        return self._require_sdk().threads.open(self.id).run(
            text,
            message_id=message_id,
            attachments=attachments,
            provider=provider,
            model=model,
            model_options=model_options,
            provider_options=provider_options,
            assistant_delivery_mode=assistant_delivery_mode,
            source_proposed_plan_thread_id=source_proposed_plan_thread_id,
            source_proposed_plan_id=source_proposed_plan_id,
            timeout=timeout,
        )


class T3Code:
    """Entry point for the Python T3 Code SDK."""

    def __init__(
        self,
        db_path: str | Path | None = None,
        *,
        initialize: bool = True,
        server_url: Optional[str] = None,
        server_token: Optional[str] = None,
        server_timeout: float = 60.0,
        prefer_server: Optional[bool] = None,
    ):
        self.db_path = Path(db_path or DEFAULT_DB_PATH).expanduser()
        self.prefer_server = server_url is not None if prefer_server is None else prefer_server
        if initialize:
            self._initialize()
        self.server = T3ServerClient(
            server_url=server_url,
            server_token=server_token,
            timeout=server_timeout,
        )
        self.projects = ProjectsManager(self)
        self.threads = ThreadsManager(self)

    def _initialize(self) -> None:
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        conn = self._connect()
        try:
            self._ensure_schema(conn)
        finally:
            conn.close()

    def _connect(self) -> sqlite3.Connection:
        conn = sqlite3.connect(str(self.db_path))
        conn.row_factory = sqlite3.Row
        return conn

    def _ensure_schema(self, conn: sqlite3.Connection) -> None:
        cur = conn.cursor()
        statements = [
            """
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
            )
            """,
            """
            CREATE UNIQUE INDEX IF NOT EXISTS idx_orch_events_stream_version
            ON orchestration_events(aggregate_kind, stream_id, stream_version)
            """,
            """
            CREATE TABLE IF NOT EXISTS orchestration_command_receipts (
              command_id TEXT PRIMARY KEY,
              aggregate_kind TEXT NOT NULL,
              aggregate_id TEXT NOT NULL,
              accepted_at TEXT NOT NULL,
              result_sequence INTEGER NOT NULL,
              status TEXT NOT NULL,
              error TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS projection_projects (
              project_id TEXT PRIMARY KEY,
              title TEXT NOT NULL,
              workspace_root TEXT NOT NULL,
              default_model TEXT,
              scripts_json TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              deleted_at TEXT
            )
            """,
            """
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
            )
            """,
            """
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
            )
            """,
            """
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
            )
            """,
            """
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
            )
            """,
            """
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
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS projection_pending_approvals (
              request_id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL,
              turn_id TEXT,
              status TEXT NOT NULL,
              decision TEXT,
              created_at TEXT NOT NULL,
              resolved_at TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS projection_state (
              projector TEXT PRIMARY KEY,
              last_applied_sequence INTEGER NOT NULL,
              updated_at TEXT NOT NULL
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS projection_thread_proposed_plans (
              plan_id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL,
              turn_id TEXT,
              plan_markdown TEXT NOT NULL,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL,
              implemented_at TEXT,
              implementation_thread_id TEXT
            )
            """,
            """
            CREATE TABLE IF NOT EXISTS provider_session_runtime (
              runtime_session_id TEXT PRIMARY KEY,
              thread_id TEXT NOT NULL,
              provider TEXT NOT NULL,
              status TEXT NOT NULL,
              runtime_mode TEXT,
              created_at TEXT NOT NULL,
              updated_at TEXT NOT NULL
            )
            """,
        ]
        for statement in statements:
            cur.execute(statement)
        conn.commit()

    @contextmanager
    def _transaction(self) -> Iterable[tuple[sqlite3.Connection, sqlite3.Cursor]]:
        conn = self._connect()
        cur = conn.cursor()
        cur.execute("BEGIN IMMEDIATE")
        try:
            yield conn, cur
        except Exception:
            conn.rollback()
            conn.close()
            raise
        else:
            conn.commit()
            conn.close()

    def _append_event(
        self,
        cur: sqlite3.Cursor,
        *,
        aggregate_kind: str,
        aggregate_id: str,
        event_type: str,
        payload: dict[str, Any],
        command_id: Optional[str] = None,
        occurred_at: Optional[str] = None,
        causation_event_id: Optional[str] = None,
        correlation_id: Optional[str] = None,
        actor_kind: str = "client",
        metadata: Optional[dict[str, Any]] = None,
    ) -> dict[str, Any]:
        event_id = _new_id()
        occurred_at = occurred_at or _utc_now()
        cur.execute(
            """
            INSERT INTO orchestration_events (
              event_id,
              aggregate_kind,
              stream_id,
              stream_version,
              event_type,
              occurred_at,
              command_id,
              causation_event_id,
              correlation_id,
              actor_kind,
              payload_json,
              metadata_json
            )
            VALUES (
              ?, ?, ?,
              COALESCE(
                (
                  SELECT stream_version + 1
                  FROM orchestration_events
                  WHERE aggregate_kind = ?
                    AND stream_id = ?
                  ORDER BY stream_version DESC
                  LIMIT 1
                ),
                0
              ),
              ?, ?, ?, ?, ?, ?, ?, ?
            )
            """,
            (
                event_id,
                aggregate_kind,
                aggregate_id,
                aggregate_kind,
                aggregate_id,
                event_type,
                occurred_at,
                command_id,
                causation_event_id,
                correlation_id if correlation_id is not None else command_id,
                actor_kind,
                json.dumps(payload),
                json.dumps(metadata or {}),
            ),
        )
        sequence = cur.execute("SELECT last_insert_rowid()").fetchone()[0]
        return {"sequence": sequence, "event_id": event_id, "occurred_at": occurred_at}

    def _touch_projection_state(
        self,
        cur: sqlite3.Cursor,
        *,
        sequence: int,
        occurred_at: str,
        projectors: Iterable[str] = PROJECTOR_NAMES,
    ) -> None:
        for projector in projectors:
            cur.execute(
                """
                INSERT INTO projection_state (projector, last_applied_sequence, updated_at)
                VALUES (?, ?, ?)
                ON CONFLICT(projector)
                DO UPDATE SET
                  last_applied_sequence = excluded.last_applied_sequence,
                  updated_at = excluded.updated_at
                """,
                (projector, sequence, occurred_at),
            )

    def _project_from_row(self, row: sqlite3.Row) -> Project:
        scripts = [
            ProjectScript(
                id=item["id"],
                name=item["name"],
                command=item["command"],
                icon=item["icon"],
                run_on_worktree_create=item["runOnWorktreeCreate"],
            )
            for item in _json_loads(row["scripts_json"], [])
        ]
        return Project(
            id=row["project_id"],
            title=row["title"],
            workspace_root=row["workspace_root"],
            default_model=row["default_model"],
            scripts=scripts,
            created_at=row["created_at"] or "",
            updated_at=row["updated_at"] or "",
            deleted_at=row["deleted_at"],
            _sdk=self,
        )

    def _image_attachments_from_json(self, value: Optional[str]) -> list[ImageAttachment]:
        items = _json_loads(value, [])
        return [
            ImageAttachment(
                id=item["id"],
                name=item["name"],
                mime_type=item["mimeType"],
                size_bytes=item["sizeBytes"],
                type=item.get("type", "image"),
            )
            for item in items
        ]

    def _checkpoint_files_from_json(self, value: str) -> list[CheckpointFile]:
        items = _json_loads(value, [])
        return [
            CheckpointFile(
                path=item["path"],
                kind=item["kind"],
                additions=item["additions"],
                deletions=item["deletions"],
            )
            for item in items
        ]

    def _message_from_row(self, row: sqlite3.Row) -> Message:
        return Message(
            id=row["message_id"],
            thread_id=row["thread_id"],
            turn_id=row["turn_id"],
            role=row["role"],
            text=row["text"] or "",
            attachments=self._image_attachments_from_json(row["attachments_json"]),
            streaming=bool(row["is_streaming"]),
            created_at=row["created_at"] or "",
            updated_at=row["updated_at"] or "",
        )

    def _plan_from_row(self, row: sqlite3.Row) -> ProposedPlan:
        return ProposedPlan(
            id=row["plan_id"],
            thread_id=row["thread_id"],
            turn_id=row["turn_id"],
            plan_markdown=row["plan_markdown"],
            implemented_at=row["implemented_at"],
            implementation_thread_id=row["implementation_thread_id"],
            created_at=row["created_at"],
            updated_at=row["updated_at"],
        )

    def _activity_from_row(self, row: sqlite3.Row) -> ThreadActivity:
        return ThreadActivity(
            id=row["activity_id"],
            thread_id=row["thread_id"],
            turn_id=row["turn_id"],
            tone=row["tone"],
            kind=row["kind"],
            summary=row["summary"],
            payload=_json_loads(row["payload_json"], {}),
            sequence=row["sequence"],
            created_at=row["created_at"],
        )

    def _session_from_row(self, row: sqlite3.Row) -> Session:
        return Session(
            thread_id=row["thread_id"],
            status=row["status"],
            provider_name=row["provider_name"],
            runtime_mode=row["runtime_mode"] or DEFAULT_RUNTIME_MODE,
            active_turn_id=row["active_turn_id"],
            last_error=row["last_error"],
            updated_at=row["updated_at"],
        )

    def _approval_from_row(self, row: sqlite3.Row) -> PendingApproval:
        return PendingApproval(
            request_id=row["request_id"],
            thread_id=row["thread_id"],
            turn_id=row["turn_id"],
            status=row["status"],
            decision=row["decision"],
            created_at=row["created_at"],
            resolved_at=row["resolved_at"],
        )

    def _turn_from_row(self, row: sqlite3.Row) -> Turn:
        return Turn(
            thread_id=row["thread_id"],
            turn_id=row["turn_id"],
            pending_message_id=row["pending_message_id"],
            source_proposed_plan_thread_id=row["source_proposed_plan_thread_id"],
            source_proposed_plan_id=row["source_proposed_plan_id"],
            assistant_message_id=row["assistant_message_id"],
            state=row["state"],
            requested_at=row["requested_at"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            checkpoint_turn_count=row["checkpoint_turn_count"],
            checkpoint_ref=row["checkpoint_ref"],
            checkpoint_status=row["checkpoint_status"],
            checkpoint_files=self._checkpoint_files_from_json(row["checkpoint_files_json"] or "[]"),
        )

    def _latest_turn_from_row(self, row: sqlite3.Row) -> LatestTurn:
        state = row["state"]
        if state not in {"running", "interrupted", "completed", "error"}:
            state = "running"
        return LatestTurn(
            turn_id=row["turn_id"],
            state=state,
            requested_at=row["requested_at"],
            started_at=row["started_at"],
            completed_at=row["completed_at"],
            assistant_message_id=row["assistant_message_id"],
            source_proposed_plan_thread_id=row["source_proposed_plan_thread_id"],
            source_proposed_plan_id=row["source_proposed_plan_id"],
        )

    def _thread_from_row(self, conn: sqlite3.Connection, row: sqlite3.Row) -> Thread:
        thread_id = row["thread_id"]
        messages = [
            self._message_from_row(message_row)
            for message_row in conn.execute(
                """
                SELECT *
                FROM projection_thread_messages
                WHERE thread_id = ?
                ORDER BY created_at ASC, message_id ASC
                """,
                (thread_id,),
            ).fetchall()
        ]
        proposed_plans = [
            self._plan_from_row(plan_row)
            for plan_row in conn.execute(
                """
                SELECT *
                FROM projection_thread_proposed_plans
                WHERE thread_id = ?
                ORDER BY created_at ASC, plan_id ASC
                """,
                (thread_id,),
            ).fetchall()
        ]
        activities = [
            self._activity_from_row(activity_row)
            for activity_row in conn.execute(
                """
                SELECT *
                FROM projection_thread_activities
                WHERE thread_id = ?
                ORDER BY
                  CASE WHEN sequence IS NULL THEN 0 ELSE 1 END ASC,
                  sequence ASC,
                  created_at ASC,
                  activity_id ASC
                """,
                (thread_id,),
            ).fetchall()
        ]
        session_row = conn.execute(
            """
            SELECT *
            FROM projection_thread_sessions
            WHERE thread_id = ?
            """,
            (thread_id,),
        ).fetchone()
        turns = [
            self._turn_from_row(turn_row)
            for turn_row in conn.execute(
                """
                SELECT *
                FROM projection_turns
                WHERE thread_id = ?
                ORDER BY
                  CASE WHEN checkpoint_turn_count IS NULL THEN 1 ELSE 0 END ASC,
                  checkpoint_turn_count ASC,
                  requested_at ASC,
                  turn_id ASC
                """,
                (thread_id,),
            ).fetchall()
        ]
        latest_turn_row = conn.execute(
            """
            SELECT *
            FROM projection_turns
            WHERE thread_id = ?
              AND turn_id IS NOT NULL
            ORDER BY requested_at DESC, turn_id DESC
            LIMIT 1
            """,
            (thread_id,),
        ).fetchone()
        pending_approvals = [
            self._approval_from_row(approval_row)
            for approval_row in conn.execute(
                """
                SELECT *
                FROM projection_pending_approvals
                WHERE thread_id = ?
                ORDER BY created_at ASC, request_id ASC
                """,
                (thread_id,),
            ).fetchall()
        ]
        checkpoints = [
            CheckpointSummary(
                turn_id=turn.turn_id or "",
                checkpoint_turn_count=turn.checkpoint_turn_count or 0,
                checkpoint_ref=turn.checkpoint_ref or "",
                status=turn.checkpoint_status or "missing",
                files=list(turn.checkpoint_files),
                assistant_message_id=turn.assistant_message_id,
                completed_at=turn.completed_at or "",
            )
            for turn in turns
            if turn.turn_id is not None and turn.checkpoint_turn_count is not None
        ]
        return Thread(
            id=thread_id,
            project_id=row["project_id"],
            title=row["title"],
            model=row["model"],
            runtime_mode=row["runtime_mode"] or DEFAULT_RUNTIME_MODE,
            interaction_mode=row["interaction_mode"] or DEFAULT_INTERACTION_MODE,
            branch=row["branch"],
            worktree_path=row["worktree_path"],
            latest_turn=self._latest_turn_from_row(latest_turn_row) if latest_turn_row else None,
            messages=messages,
            proposed_plans=proposed_plans,
            activities=activities,
            checkpoints=checkpoints,
            turns=turns,
            pending_approvals=pending_approvals,
            session=self._session_from_row(session_row) if session_row else None,
            created_at=row["created_at"] or "",
            updated_at=row["updated_at"] or "",
            deleted_at=row["deleted_at"],
            _sdk=self,
        )

    def _get_project(self, project_id: str, *, include_deleted: bool = False) -> Optional[Project]:
        project_id = _trimmed(project_id, "project_id")
        conn = self._connect()
        try:
            sql = "SELECT * FROM projection_projects WHERE project_id = ?"
            params: list[Any] = [project_id]
            if not include_deleted:
                sql += " AND deleted_at IS NULL"
            row = conn.execute(sql, params).fetchone()
            return self._project_from_row(row) if row else None
        finally:
            conn.close()

    def _get_thread(self, thread_id: str, *, include_deleted: bool = False) -> Optional[Thread]:
        thread_id = _trimmed(thread_id, "thread_id")
        conn = self._connect()
        try:
            sql = "SELECT * FROM projection_threads WHERE thread_id = ?"
            params: list[Any] = [thread_id]
            if not include_deleted:
                sql += " AND deleted_at IS NULL"
            row = conn.execute(sql, params).fetchone()
            return self._thread_from_row(conn, row) if row else None
        finally:
            conn.close()

    def _require_project(self, project_id: str) -> Project:
        project = self._get_project(project_id)
        if project is None:
            raise ValueError(f"Project '{project_id}' was not found")
        return project

    def _require_thread(self, thread_id: str) -> Thread:
        thread = self._get_thread(thread_id)
        if thread is None:
            raise ValueError(f"Thread '{thread_id}' was not found")
        return thread

    def _upsert_thread_row(
        self,
        cur: sqlite3.Cursor,
        *,
        thread_id: str,
        project_id: str,
        title: str,
        model: str,
        runtime_mode: str,
        interaction_mode: str,
        branch: Optional[str],
        worktree_path: Optional[str],
        latest_turn_id: Optional[str],
        created_at: str,
        updated_at: str,
        deleted_at: Optional[str],
    ) -> None:
        cur.execute(
            """
            INSERT INTO projection_threads (
              thread_id,
              project_id,
              title,
              model,
              runtime_mode,
              interaction_mode,
              branch,
              worktree_path,
              latest_turn_id,
              created_at,
              updated_at,
              deleted_at
            )
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(thread_id)
            DO UPDATE SET
              project_id = excluded.project_id,
              title = excluded.title,
              model = excluded.model,
              runtime_mode = excluded.runtime_mode,
              interaction_mode = excluded.interaction_mode,
              branch = excluded.branch,
              worktree_path = excluded.worktree_path,
              latest_turn_id = excluded.latest_turn_id,
              created_at = excluded.created_at,
              updated_at = excluded.updated_at,
              deleted_at = excluded.deleted_at
            """,
            (
                thread_id,
                project_id,
                title,
                model,
                runtime_mode,
                interaction_mode,
                branch,
                worktree_path,
                latest_turn_id,
                created_at,
                updated_at,
                deleted_at,
            ),
        )

    def _wait_for_row(
        self,
        sql: str,
        params: tuple[Any, ...],
        *,
        timeout: Optional[float] = None,
        interval: float = 0.05,
    ) -> Optional[sqlite3.Row]:
        deadline = time.monotonic() + (self.server.timeout if timeout is None else timeout)
        while True:
            conn = self._connect()
            try:
                row = conn.execute(sql, params).fetchone()
                if row is not None:
                    return row
            finally:
                conn.close()
            if time.monotonic() >= deadline:
                return None
            time.sleep(interval)

    def _wait_for_project(self, project_id: str, *, timeout: Optional[float] = None) -> Optional[Project]:
        row = self._wait_for_row(
            "SELECT * FROM projection_projects WHERE project_id = ?",
            (project_id,),
            timeout=timeout,
        )
        return self._project_from_row(row) if row is not None else None

    def _wait_for_thread(self, thread_id: str, *, timeout: Optional[float] = None) -> Optional[Thread]:
        row = self._wait_for_row(
            "SELECT * FROM projection_threads WHERE thread_id = ?",
            (thread_id,),
            timeout=timeout,
        )
        if row is None:
            return None
        conn = self._connect()
        try:
            row = conn.execute(
                "SELECT * FROM projection_threads WHERE thread_id = ?",
                (thread_id,),
            ).fetchone()
            return self._thread_from_row(conn, row) if row is not None else None
        finally:
            conn.close()

    def _wait_for_message(self, message_id: str, *, timeout: Optional[float] = None) -> Optional[Message]:
        row = self._wait_for_row(
            "SELECT * FROM projection_thread_messages WHERE message_id = ?",
            (message_id,),
            timeout=timeout,
        )
        return self._message_from_row(row) if row is not None else None

    # Compatibility helpers
    def list_projects(self) -> list[Project]:
        return self.projects.list()

    def get_project(self, project_id: str) -> Optional[Project]:
        return self.projects.get(project_id)

    def find_project(self, title: str) -> Optional[Project]:
        return self.projects.get_by_title(title)

    def get_thread(self, thread_id: str) -> Optional[Thread]:
        return self.threads.get(thread_id)

    def find_thread(self, title: str, *, project_id: Optional[str] = None) -> Optional[Thread]:
        normalized_title = _trimmed(title, "title")
        for thread in self.threads.list(project_id=project_id):
            if thread.title == normalized_title:
                return thread
        return None

    def create_project(self, workspace_root: str, model: str = DEFAULT_MODEL) -> Project:
        return self.projects.create(workspace_root=workspace_root, default_model=model)

    def delete_project(self, project_id: str) -> None:
        self.projects.delete(project_id)

    def create_thread(self, project_id: str, title: str = "New thread", model: str | None = None) -> Thread:
        return self.projects.open(project_id).threads.create(title=title, model=model)

    def list_threads(self, project_id: str) -> list[Thread]:
        return self.projects.open(project_id).threads.list()

    def list_messages(self, thread_id: str, limit: Optional[int] = 50) -> list[Message]:
        return self.threads.open(thread_id).messages.list(limit=limit)

    def list_activities(self, thread_id: str, limit: Optional[int] = 50) -> list[ThreadActivity]:
        return self.threads.open(thread_id).activities.list(limit=limit)

    def get_session(self, thread_id: str) -> Optional[Session]:
        return self.threads.open(thread_id).session.get()

    def list_active_sessions(self) -> list[dict[str, Any]]:
        conn = self._connect()
        try:
            rows = conn.execute(
                "SELECT * FROM provider_session_runtime WHERE status IN ('starting', 'ready', 'running')"
            ).fetchall()
            return [dict(row) for row in rows]
        finally:
            conn.close()


class T3ServerClient:
    def __init__(
        self,
        *,
        server_url: Optional[str] = None,
        server_token: Optional[str] = None,
        timeout: float = 60.0,
    ):
        self.server_url = server_url
        self.server_token = server_token
        self.timeout = timeout

    @property
    def enabled(self) -> bool:
        return self.server_url is not None

    def require_enabled(self) -> None:
        if not self.enabled:
            raise RuntimeError(
                "Live server dispatch is not configured. Pass server_url=... to T3Code(...) to enable agent execution."
            )

    def dispatch_command(self, command: dict[str, Any]) -> DispatchReceipt:
        self.require_enabled()
        response = self._request("orchestration.dispatchCommand", {"command": command})
        if not isinstance(response, dict):
            raise RuntimeError("Invalid response from T3 server")
        sequence = response.get("sequence")
        if not isinstance(sequence, int):
            raise RuntimeError("Missing sequence in T3 server response")
        return DispatchReceipt(command_id=command["commandId"], sequence=sequence)

    def _request(self, method: str, params: Optional[dict[str, Any]] = None) -> Any:
        raw_url = self._build_url()
        parsed = urlparse(raw_url)
        scheme = parsed.scheme.lower()
        if scheme not in {"ws", "wss"}:
            raise ValueError("server_url must use ws:// or wss://")
        host = parsed.hostname
        if not host:
            raise ValueError("server_url is missing a host")
        port = parsed.port or (443 if scheme == "wss" else 80)
        request_id = _new_id()
        payload = json.dumps(
            {
                "id": request_id,
                "body": {"_tag": method, **(params or {})},
            }
        )
        sock: socket.socket = socket.create_connection((host, port), timeout=self.timeout)
        sock.settimeout(self.timeout)
        try:
            if scheme == "wss":
                context = ssl.create_default_context()
                sock = context.wrap_socket(sock, server_hostname=host)
                sock.settimeout(self.timeout)
            self._handshake(sock, parsed, host, port)
            self._send_text_frame(sock, payload)
            while True:
                frame = self._read_text_frame(sock)
                message = json.loads(frame)
                if message.get("type") == "push":
                    continue
                if message.get("id") != request_id:
                    continue
                error = message.get("error")
                if error:
                    if isinstance(error, dict) and "message" in error:
                        raise RuntimeError(str(error["message"]))
                    raise RuntimeError(str(error))
                return message.get("result")
        finally:
            try:
                sock.close()
            except OSError:
                pass

    def _build_url(self) -> str:
        assert self.server_url is not None
        parsed = urlparse(self.server_url)
        if not self.server_token:
            return self.server_url
        query = dict(parse_qsl(parsed.query, keep_blank_values=True))
        query.setdefault("token", self.server_token)
        return urlunparse(parsed._replace(query=urlencode(query)))

    def _handshake(self, sock: socket.socket, parsed: Any, host: str, port: int) -> None:
        key = b64encode(os.urandom(16)).decode("ascii")
        path = parsed.path or "/"
        if parsed.query:
            path = f"{path}?{parsed.query}"
        host_header = host if port in {80, 443} else f"{host}:{port}"
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host_header}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n"
            "\r\n"
        )
        sock.sendall(request.encode("utf-8"))
        response = b""
        while b"\r\n\r\n" not in response:
            chunk = sock.recv(4096)
            if not chunk:
                raise RuntimeError("WebSocket handshake failed: connection closed")
            response += chunk
        header_block = response.split(b"\r\n\r\n", 1)[0].decode("utf-8", errors="replace")
        status_line = header_block.split("\r\n", 1)[0]
        if "101" not in status_line:
            raise RuntimeError(f"WebSocket handshake failed: {status_line}")
        headers: dict[str, str] = {}
        for line in header_block.split("\r\n")[1:]:
            if ":" not in line:
                continue
            name, value = line.split(":", 1)
            headers[name.strip().lower()] = value.strip()
        expected_accept = b64encode(
            sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
        ).decode("ascii")
        if headers.get("sec-websocket-accept") != expected_accept:
            raise RuntimeError("WebSocket handshake failed: invalid accept header")

    def _send_text_frame(self, sock: socket.socket, text: str) -> None:
        payload = text.encode("utf-8")
        frame = bytearray()
        frame.append(0x81)
        mask_key = os.urandom(4)
        length = len(payload)
        if length < 126:
            frame.append(0x80 | length)
        elif length < (1 << 16):
            frame.append(0x80 | 126)
            frame.extend(struct.pack("!H", length))
        else:
            frame.append(0x80 | 127)
            frame.extend(struct.pack("!Q", length))
        frame.extend(mask_key)
        masked = bytes(payload[i] ^ mask_key[i % 4] for i in range(length))
        frame.extend(masked)
        sock.sendall(frame)

    def _read_exact(self, sock: socket.socket, length: int) -> bytes:
        data = b""
        while len(data) < length:
            chunk = sock.recv(length - len(data))
            if not chunk:
                raise RuntimeError("WebSocket connection closed unexpectedly")
            data += chunk
        return data

    def _read_text_frame(self, sock: socket.socket) -> str:
        header = self._read_exact(sock, 2)
        first, second = header[0], header[1]
        opcode = first & 0x0F
        masked = (second & 0x80) != 0
        length = second & 0x7F
        if length == 126:
            length = struct.unpack("!H", self._read_exact(sock, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._read_exact(sock, 8))[0]
        mask_key = self._read_exact(sock, 4) if masked else b""
        payload = self._read_exact(sock, length)
        if masked:
            payload = bytes(payload[i] ^ mask_key[i % 4] for i in range(length))
        if opcode == 0x8:
            raise RuntimeError("WebSocket connection closed by server")
        if opcode != 0x1:
            return self._read_text_frame(sock)
        return payload.decode("utf-8")


class ProjectsManager:
    def __init__(self, sdk: T3):
        self._sdk = sdk

    def list(self, *, include_deleted: bool = False) -> list[Project]:
        conn = self._sdk._connect()
        try:
            sql = "SELECT * FROM projection_projects"
            if not include_deleted:
                sql += " WHERE deleted_at IS NULL"
            sql += " ORDER BY created_at ASC, project_id ASC"
            return [self._sdk._project_from_row(row) for row in conn.execute(sql).fetchall()]
        finally:
            conn.close()

    def get(self, project_id: str, *, include_deleted: bool = False) -> Optional[Project]:
        return self._sdk._get_project(project_id, include_deleted=include_deleted)

    def get_by_title(self, title: str, *, include_deleted: bool = False) -> Optional[Project]:
        title = _trimmed(title, "title")
        conn = self._sdk._connect()
        try:
            sql = "SELECT * FROM projection_projects WHERE title = ?"
            params: list[Any] = [title]
            if not include_deleted:
                sql += " AND deleted_at IS NULL"
            sql += " ORDER BY created_at ASC LIMIT 1"
            row = conn.execute(sql, params).fetchone()
            return self._sdk._project_from_row(row) if row else None
        finally:
            conn.close()

    def get_by_workspace_root(
        self, workspace_root: str | Path, *, include_deleted: bool = False
    ) -> Optional[Project]:
        workspace = str(_coerce_path(workspace_root, "workspace_root"))
        conn = self._sdk._connect()
        try:
            sql = "SELECT * FROM projection_projects WHERE workspace_root = ?"
            params: list[Any] = [workspace]
            if not include_deleted:
                sql += " AND deleted_at IS NULL"
            sql += " ORDER BY created_at ASC LIMIT 1"
            row = conn.execute(sql, params).fetchone()
            return self._sdk._project_from_row(row) if row else None
        finally:
            conn.close()

    def open(self, project_id: str) -> ProjectHandle:
        self._sdk._require_project(project_id)
        return ProjectHandle(self._sdk, _trimmed(project_id, "project_id"))

    def create(
        self,
        *,
        workspace_root: str | Path,
        title: Optional[str] = None,
        default_model: Optional[str] = DEFAULT_MODEL,
        scripts: Optional[Iterable[dict[str, Any]]] = None,
        create_initial_thread: bool = True,
        initial_thread_title: str = "New thread",
        initial_thread_model: Optional[str] = None,
        ensure_workspace_exists: bool = False,
        live: Optional[bool] = None,
        timeout: Optional[float] = None,
    ) -> Project:
        workspace = _coerce_path(workspace_root, "workspace_root")
        if ensure_workspace_exists and not workspace.exists():
            raise ValueError(f"workspace_root does not exist: {workspace}")
        normalized_title = _optional_trimmed(title, "title") or workspace.name
        normalized_model = _optional_trimmed(default_model, "default_model")
        normalized_scripts = _validate_scripts(scripts)
        resolved_live = self._sdk.prefer_server if live is None else live
        project_id = _new_id()
        created_at = _utc_now()
        command_id = _new_id()
        if resolved_live:
            self._sdk.server.dispatch_command(
                {
                    "type": "project.create",
                    "commandId": command_id,
                    "projectId": project_id,
                    "title": normalized_title,
                    "workspaceRoot": str(workspace),
                    "defaultModel": normalized_model,
                    "createdAt": created_at,
                }
            )
            project = self._sdk._wait_for_project(project_id, timeout=timeout)
            if project is None:
                raise RuntimeError("Project dispatch succeeded but the project was not visible in the database")
            if create_initial_thread:
                project.create_thread(
                    title=initial_thread_title,
                    model=initial_thread_model or normalized_model,
                    live=True,
                    timeout=timeout,
                )
                project = self._sdk._require_project(project_id)
            if normalized_scripts:
                project = self.update(project.id, scripts=normalized_scripts)
            return project
        with self._sdk._transaction() as (_, cur):
            project_event = self._sdk._append_event(
                cur,
                aggregate_kind="project",
                aggregate_id=project_id,
                event_type="project.created",
                command_id=command_id,
                occurred_at=created_at,
                payload={
                    "projectId": project_id,
                    "title": normalized_title,
                    "workspaceRoot": str(workspace),
                    "defaultModel": normalized_model,
                    "scripts": normalized_scripts,
                    "createdAt": created_at,
                    "updatedAt": created_at,
                },
            )
            cur.execute(
                """
                INSERT INTO projection_projects (
                  project_id,
                  title,
                  workspace_root,
                  default_model,
                  scripts_json,
                  created_at,
                  updated_at,
                  deleted_at
                )
                VALUES (?, ?, ?, ?, ?, ?, ?, NULL)
                """,
                (
                    project_id,
                    normalized_title,
                    str(workspace),
                    normalized_model,
                    json.dumps(normalized_scripts),
                    created_at,
                    created_at,
                ),
            )
            latest_sequence = project_event["sequence"]
            latest_occurred_at = project_event["occurred_at"]
            if create_initial_thread:
                thread_id = _new_id()
                thread_model = _optional_trimmed(initial_thread_model, "initial_thread_model") or normalized_model or DEFAULT_MODEL
                thread_event = self._sdk._append_event(
                    cur,
                    aggregate_kind="thread",
                    aggregate_id=thread_id,
                    event_type="thread.created",
                    command_id=_new_id(),
                    occurred_at=created_at,
                    payload={
                        "threadId": thread_id,
                        "projectId": project_id,
                        "title": _trimmed(initial_thread_title, "initial_thread_title"),
                        "model": thread_model,
                        "runtimeMode": DEFAULT_RUNTIME_MODE,
                        "interactionMode": DEFAULT_INTERACTION_MODE,
                        "branch": None,
                        "worktreePath": None,
                        "createdAt": created_at,
                        "updatedAt": created_at,
                    },
                )
                self._sdk._upsert_thread_row(
                    cur,
                    thread_id=thread_id,
                    project_id=project_id,
                    title=_trimmed(initial_thread_title, "initial_thread_title"),
                    model=thread_model,
                    runtime_mode=DEFAULT_RUNTIME_MODE,
                    interaction_mode=DEFAULT_INTERACTION_MODE,
                    branch=None,
                    worktree_path=None,
                    latest_turn_id=None,
                    created_at=created_at,
                    updated_at=created_at,
                    deleted_at=None,
                )
                latest_sequence = thread_event["sequence"]
                latest_occurred_at = thread_event["occurred_at"]
            self._sdk._touch_projection_state(
                cur,
                sequence=latest_sequence,
                occurred_at=latest_occurred_at,
            )
        return self._sdk._require_project(project_id)

    def get_or_create(
        self,
        *,
        workspace_root: str | Path,
        title: Optional[str] = None,
        default_model: Optional[str] = DEFAULT_MODEL,
        scripts: Optional[Iterable[dict[str, Any]]] = None,
        create_initial_thread: bool = True,
        initial_thread_title: str = "New thread",
        initial_thread_model: Optional[str] = None,
        ensure_workspace_exists: bool = False,
    ) -> Project:
        existing = self.get_by_workspace_root(workspace_root)
        if existing is not None:
            return existing
        return self.create(
            workspace_root=workspace_root,
            title=title,
            default_model=default_model,
            scripts=scripts,
            create_initial_thread=create_initial_thread,
            initial_thread_title=initial_thread_title,
            initial_thread_model=initial_thread_model,
            ensure_workspace_exists=ensure_workspace_exists,
        )

    def update(
        self,
        project_id: str,
        *,
        title: Optional[str] = None,
        workspace_root: str | Path | None = None,
        default_model: Optional[str] = None,
        scripts: Optional[Iterable[dict[str, Any]]] = None,
    ) -> Project:
        project = self._sdk._require_project(project_id)
        next_title = _optional_trimmed(title, "title")
        next_workspace_root = str(_coerce_path(workspace_root, "workspace_root")) if workspace_root is not None else None
        next_default_model = _optional_trimmed(default_model, "default_model") if default_model is not None else None
        next_scripts = _validate_scripts(scripts) if scripts is not None else None
        if all(value is None for value in (next_title, next_workspace_root, next_default_model, next_scripts)):
            return project
        updated_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="project",
                aggregate_id=project.id,
                event_type="project.meta-updated",
                command_id=_new_id(),
                occurred_at=updated_at,
                payload={
                    "projectId": project.id,
                    **({"title": next_title} if next_title is not None else {}),
                    **({"workspaceRoot": next_workspace_root} if next_workspace_root is not None else {}),
                    **({"defaultModel": next_default_model} if next_default_model is not None else {}),
                    **({"scripts": next_scripts} if next_scripts is not None else {}),
                    "updatedAt": updated_at,
                },
            )
            cur.execute(
                """
                UPDATE projection_projects
                SET
                  title = ?,
                  workspace_root = ?,
                  default_model = ?,
                  scripts_json = ?,
                  updated_at = ?
                WHERE project_id = ?
                """,
                (
                    next_title if next_title is not None else project.title,
                    next_workspace_root if next_workspace_root is not None else project.workspace_root,
                    next_default_model if default_model is not None else project.default_model,
                    json.dumps(next_scripts) if next_scripts is not None else json.dumps(
                        [
                            {
                                "id": script.id,
                                "name": script.name,
                                "command": script.command,
                                "icon": script.icon,
                                "runOnWorktreeCreate": script.run_on_worktree_create,
                            }
                            for script in project.scripts
                        ]
                    ),
                    updated_at,
                    project.id,
                ),
            )
            self._sdk._touch_projection_state(
                cur,
                sequence=event["sequence"],
                occurred_at=event["occurred_at"],
            )
        return self._sdk._require_project(project.id)

    def delete(self, project_id: str) -> None:
        project = self._sdk._require_project(project_id)
        deleted_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="project",
                aggregate_id=project.id,
                event_type="project.deleted",
                command_id=_new_id(),
                occurred_at=deleted_at,
                payload={"projectId": project.id, "deletedAt": deleted_at},
            )
            cur.execute(
                "UPDATE projection_projects SET deleted_at = ?, updated_at = ? WHERE project_id = ?",
                (deleted_at, deleted_at, project.id),
            )
            self._sdk._touch_projection_state(
                cur,
                sequence=event["sequence"],
                occurred_at=event["occurred_at"],
            )


class ProjectHandle:
    def __init__(self, sdk: T3, project_id: str):
        self._sdk = sdk
        self.id = project_id
        self.threads = ProjectThreadsManager(sdk, project_id)
        self.files = ProjectFilesManager(sdk, project_id)

    def get(self) -> Project:
        return self._sdk._require_project(self.id)

    def refresh(self) -> Project:
        return self.get()

    def update(
        self,
        *,
        title: Optional[str] = None,
        workspace_root: str | Path | None = None,
        default_model: Optional[str] = None,
        scripts: Optional[Iterable[dict[str, Any]]] = None,
    ) -> Project:
        return self._sdk.projects.update(
            self.id,
            title=title,
            workspace_root=workspace_root,
            default_model=default_model,
            scripts=scripts,
        )

    def delete(self) -> None:
        self._sdk.projects.delete(self.id)


class ProjectThreadsManager:
    def __init__(self, sdk: T3, project_id: str):
        self._sdk = sdk
        self._project_id = project_id

    def list(self, *, include_deleted: bool = False) -> list[Thread]:
        self._sdk._require_project(self._project_id)
        conn = self._sdk._connect()
        try:
            sql = "SELECT * FROM projection_threads WHERE project_id = ?"
            params: list[Any] = [self._project_id]
            if not include_deleted:
                sql += " AND deleted_at IS NULL"
            sql += " ORDER BY created_at ASC, thread_id ASC"
            return [self._sdk._thread_from_row(conn, row) for row in conn.execute(sql, params).fetchall()]
        finally:
            conn.close()

    def get(self, thread_id: str, *, include_deleted: bool = False) -> Optional[Thread]:
        thread = self._sdk._get_thread(thread_id, include_deleted=include_deleted)
        if thread is None or thread.project_id != self._project_id:
            return None
        return thread

    def open(self, thread_id: str) -> ThreadHandle:
        thread = self._sdk._require_thread(thread_id)
        if thread.project_id != self._project_id:
            raise ValueError(f"Thread '{thread_id}' does not belong to project '{self._project_id}'")
        return ThreadHandle(self._sdk, thread_id)

    def create(
        self,
        *,
        title: str = "New thread",
        model: Optional[str] = None,
        runtime_mode: str = DEFAULT_RUNTIME_MODE,
        interaction_mode: str = DEFAULT_INTERACTION_MODE,
        branch: Optional[str] = None,
        worktree_path: Optional[str] = None,
        live: Optional[bool] = None,
        timeout: Optional[float] = None,
    ) -> Thread:
        project = self._sdk._require_project(self._project_id)
        normalized_title = _trimmed(title, "title")
        normalized_model = _optional_trimmed(model, "model") or project.default_model or DEFAULT_MODEL
        normalized_runtime_mode = _validate_enum(runtime_mode, "runtime_mode", RUNTIME_MODES)
        normalized_interaction_mode = _validate_enum(
            interaction_mode, "interaction_mode", INTERACTION_MODES
        )
        normalized_branch = _optional_trimmed(branch, "branch")
        normalized_worktree_path = _optional_trimmed(worktree_path, "worktree_path")
        resolved_live = self._sdk.prefer_server if live is None else live
        thread_id = _new_id()
        created_at = _utc_now()
        if resolved_live:
            try:
                self._sdk.server.dispatch_command(
                    {
                        "type": "thread.create",
                        "commandId": _new_id(),
                        "threadId": thread_id,
                        "projectId": project.id,
                        "title": normalized_title,
                        "model": normalized_model,
                        "runtimeMode": normalized_runtime_mode,
                        "interactionMode": normalized_interaction_mode,
                        "branch": normalized_branch,
                        "worktreePath": normalized_worktree_path,
                        "createdAt": created_at,
                    }
                )
            except RuntimeError as exc:
                message = str(exc)
                if (
                    "Orchestration command invariant failed (thread.create)" in message
                    and f"Project '{project.id}' does not exist" in message
                ):
                    raise RuntimeError(
                        "Cannot create a live thread for a project that only exists in the local SDK database. "
                        "Create the project with live=True, or disable live dispatch with live=False or "
                        "T3Code(..., prefer_server=False)."
                    ) from exc
                raise
            thread = self._sdk._wait_for_thread(thread_id, timeout=timeout)
            if thread is None:
                raise RuntimeError("Thread dispatch succeeded but the thread was not visible in the database")
            return thread
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread_id,
                event_type="thread.created",
                command_id=_new_id(),
                occurred_at=created_at,
                payload={
                    "threadId": thread_id,
                    "projectId": project.id,
                    "title": normalized_title,
                    "model": normalized_model,
                    "runtimeMode": normalized_runtime_mode,
                    "interactionMode": normalized_interaction_mode,
                    "branch": normalized_branch,
                    "worktreePath": normalized_worktree_path,
                    "createdAt": created_at,
                    "updatedAt": created_at,
                },
            )
            self._sdk._upsert_thread_row(
                cur,
                thread_id=thread_id,
                project_id=project.id,
                title=normalized_title,
                model=normalized_model,
                runtime_mode=normalized_runtime_mode,
                interaction_mode=normalized_interaction_mode,
                branch=normalized_branch,
                worktree_path=normalized_worktree_path,
                latest_turn_id=None,
                created_at=created_at,
                updated_at=created_at,
                deleted_at=None,
            )
            self._sdk._touch_projection_state(
                cur,
                sequence=event["sequence"],
                occurred_at=event["occurred_at"],
            )
        return self._sdk._require_thread(thread_id)

    def get_or_create(self, *, title: str, model: Optional[str] = None) -> Thread:
        normalized_title = _trimmed(title, "title")
        for thread in self.list():
            if thread.title == normalized_title:
                return thread
        return self.create(title=normalized_title, model=model)


class ProjectFilesManager:
    def __init__(self, sdk: T3, project_id: str):
        self._sdk = sdk
        self._project_id = project_id

    def _workspace_root(self) -> Path:
        project = self._sdk._require_project(self._project_id)
        return Path(project.workspace_root)

    def search_entries(self, query: str, *, limit: int = 50) -> ProjectSearchResult:
        normalized_query = _trimmed(query, "query", max_length=MAX_QUERY_LENGTH).lower()
        if not isinstance(limit, int) or limit < 1 or limit > MAX_SEARCH_LIMIT:
            raise ValueError(f"limit must be between 1 and {MAX_SEARCH_LIMIT}")
        root = self._workspace_root()
        if not root.exists():
            raise ValueError(f"workspace_root does not exist: {root}")
        matches: list[ProjectEntry] = []
        total = 0
        for path in sorted(root.rglob("*")):
            try:
                relative = path.relative_to(root).as_posix()
            except ValueError:
                continue
            haystack = f"{relative} {path.name}".lower()
            if normalized_query not in haystack:
                continue
            total += 1
            if len(matches) >= limit:
                continue
            matches.append(
                ProjectEntry(
                    path=relative,
                    kind="directory" if path.is_dir() else "file",
                    parent_path=Path(relative).parent.as_posix() if Path(relative).parent.as_posix() != "." else None,
                )
            )
        return ProjectSearchResult(entries=matches, truncated=total > len(matches))

    def write_file(self, relative_path: str, contents: str) -> FileWriteResult:
        if not isinstance(contents, str):
            raise TypeError("contents must be a string")
        root = self._workspace_root()
        target = _relative_path(root.resolve(), relative_path)
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(contents, encoding="utf-8")
        return FileWriteResult(relative_path=str(target.relative_to(root.resolve()).as_posix()))


class ThreadsManager:
    def __init__(self, sdk: T3):
        self._sdk = sdk

    def list(self, *, project_id: Optional[str] = None, include_deleted: bool = False) -> list[Thread]:
        conn = self._sdk._connect()
        try:
            sql = "SELECT * FROM projection_threads"
            clauses: list[str] = []
            params: list[Any] = []
            if project_id is not None:
                clauses.append("project_id = ?")
                params.append(_trimmed(project_id, "project_id"))
            if not include_deleted:
                clauses.append("deleted_at IS NULL")
            if clauses:
                sql += " WHERE " + " AND ".join(clauses)
            sql += " ORDER BY created_at ASC, thread_id ASC"
            return [self._sdk._thread_from_row(conn, row) for row in conn.execute(sql, params).fetchall()]
        finally:
            conn.close()

    def get(self, thread_id: str, *, include_deleted: bool = False) -> Optional[Thread]:
        return self._sdk._get_thread(thread_id, include_deleted=include_deleted)

    def open(self, thread_id: str) -> ThreadHandle:
        self._sdk._require_thread(thread_id)
        return ThreadHandle(self._sdk, _trimmed(thread_id, "thread_id"))


class ThreadHandle:
    def __init__(self, sdk: T3, thread_id: str):
        self._sdk = sdk
        self.id = thread_id
        self.messages = ThreadMessagesManager(sdk, thread_id)
        self.activities = ThreadActivitiesManager(sdk, thread_id)
        self.session = ThreadSessionManager(sdk, thread_id)
        self.proposed_plans = ThreadProposedPlansManager(sdk, thread_id)
        self.approvals = ThreadApprovalsManager(sdk, thread_id)
        self.turns = ThreadTurnsManager(sdk, thread_id)
        self.checkpoints = ThreadCheckpointsManager(sdk, thread_id)

    def get(self) -> Thread:
        return self._sdk._require_thread(self.id)

    def refresh(self) -> Thread:
        return self.get()

    def update(
        self,
        *,
        title: Optional[str] = None,
        model: Optional[str] = None,
        branch: Optional[str] = None,
        worktree_path: Optional[str] = None,
    ) -> Thread:
        thread = self._sdk._require_thread(self.id)
        next_title = _optional_trimmed(title, "title")
        next_model = _optional_trimmed(model, "model")
        next_branch = _optional_trimmed(branch, "branch") if branch is not None else None
        next_worktree_path = _optional_trimmed(worktree_path, "worktree_path") if worktree_path is not None else None
        if all(value is None for value in (next_title, next_model, branch, worktree_path)):
            return thread
        updated_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.meta-updated",
                command_id=_new_id(),
                occurred_at=updated_at,
                payload={
                    "threadId": thread.id,
                    **({"title": next_title} if next_title is not None else {}),
                    **({"model": next_model} if next_model is not None else {}),
                    **({"branch": next_branch} if branch is not None else {}),
                    **({"worktreePath": next_worktree_path} if worktree_path is not None else {}),
                    "updatedAt": updated_at,
                },
            )
            self._sdk._upsert_thread_row(
                cur,
                thread_id=thread.id,
                project_id=thread.project_id,
                title=next_title if next_title is not None else thread.title,
                model=next_model if next_model is not None else thread.model,
                runtime_mode=thread.runtime_mode,
                interaction_mode=thread.interaction_mode,
                branch=next_branch if branch is not None else thread.branch,
                worktree_path=next_worktree_path if worktree_path is not None else thread.worktree_path,
                latest_turn_id=thread.latest_turn.turn_id if thread.latest_turn else None,
                created_at=thread.created_at,
                updated_at=updated_at,
                deleted_at=thread.deleted_at,
            )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        return self._sdk._require_thread(thread.id)

    def set_runtime_mode(self, runtime_mode: str) -> Thread:
        thread = self._sdk._require_thread(self.id)
        normalized_runtime_mode = _validate_enum(runtime_mode, "runtime_mode", RUNTIME_MODES)
        updated_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.runtime-mode-set",
                command_id=_new_id(),
                occurred_at=updated_at,
                payload={
                    "threadId": thread.id,
                    "runtimeMode": normalized_runtime_mode,
                    "updatedAt": updated_at,
                },
            )
            self._sdk._upsert_thread_row(
                cur,
                thread_id=thread.id,
                project_id=thread.project_id,
                title=thread.title,
                model=thread.model,
                runtime_mode=normalized_runtime_mode,
                interaction_mode=thread.interaction_mode,
                branch=thread.branch,
                worktree_path=thread.worktree_path,
                latest_turn_id=thread.latest_turn.turn_id if thread.latest_turn else None,
                created_at=thread.created_at,
                updated_at=updated_at,
                deleted_at=thread.deleted_at,
            )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        return self._sdk._require_thread(thread.id)

    def set_interaction_mode(self, interaction_mode: str) -> Thread:
        thread = self._sdk._require_thread(self.id)
        normalized_interaction_mode = _validate_enum(
            interaction_mode, "interaction_mode", INTERACTION_MODES
        )
        updated_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.interaction-mode-set",
                command_id=_new_id(),
                occurred_at=updated_at,
                payload={
                    "threadId": thread.id,
                    "interactionMode": normalized_interaction_mode,
                    "updatedAt": updated_at,
                },
            )
            self._sdk._upsert_thread_row(
                cur,
                thread_id=thread.id,
                project_id=thread.project_id,
                title=thread.title,
                model=thread.model,
                runtime_mode=thread.runtime_mode,
                interaction_mode=normalized_interaction_mode,
                branch=thread.branch,
                worktree_path=thread.worktree_path,
                latest_turn_id=thread.latest_turn.turn_id if thread.latest_turn else None,
                created_at=thread.created_at,
                updated_at=updated_at,
                deleted_at=thread.deleted_at,
            )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        return self._sdk._require_thread(thread.id)

    def delete(self) -> None:
        thread = self._sdk._require_thread(self.id)
        deleted_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.deleted",
                command_id=_new_id(),
                occurred_at=deleted_at,
                payload={"threadId": thread.id, "deletedAt": deleted_at},
            )
            self._sdk._upsert_thread_row(
                cur,
                thread_id=thread.id,
                project_id=thread.project_id,
                title=thread.title,
                model=thread.model,
                runtime_mode=thread.runtime_mode,
                interaction_mode=thread.interaction_mode,
                branch=thread.branch,
                worktree_path=thread.worktree_path,
                latest_turn_id=thread.latest_turn.turn_id if thread.latest_turn else None,
                created_at=thread.created_at,
                updated_at=deleted_at,
                deleted_at=deleted_at,
            )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])

    def interrupt_turn(self, turn_id: Optional[str] = None) -> Turn:
        return self.turns.interrupt(turn_id=turn_id)

    def run(
        self,
        text: str,
        *,
        message_id: Optional[str] = None,
        attachments: Optional[Iterable[dict[str, Any]]] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        model_options: Optional[dict[str, Any]] = None,
        provider_options: Optional[dict[str, Any]] = None,
        assistant_delivery_mode: str = DEFAULT_ASSISTANT_DELIVERY_MODE,
        source_proposed_plan_thread_id: Optional[str] = None,
        source_proposed_plan_id: Optional[str] = None,
        timeout: Optional[float] = None,
    ) -> Message:
        thread = self._sdk._require_thread(self.id)
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        if not text.strip():
            raise ValueError("text must be a non-empty string")
        if len(text) > MAX_INPUT_CHARS:
            raise ValueError(f"text must be at most {MAX_INPUT_CHARS} characters")
        normalized_provider = _validate_enum(provider, "provider", PROVIDERS) if provider else None
        normalized_model = _optional_trimmed(model, "model")
        normalized_model_options = _validate_json_mapping(model_options, "model_options")
        normalized_provider_options = _validate_json_mapping(provider_options, "provider_options")
        normalized_delivery_mode = _validate_enum(
            assistant_delivery_mode, "assistant_delivery_mode", ASSISTANT_DELIVERY_MODES
        )
        source_thread_id = _optional_trimmed(source_proposed_plan_thread_id, "source_proposed_plan_thread_id")
        source_plan_id = _optional_trimmed(source_proposed_plan_id, "source_proposed_plan_id")
        if (source_thread_id is None) != (source_plan_id is None):
            raise ValueError(
                "source_proposed_plan_thread_id and source_proposed_plan_id must be provided together"
            )
        message_id = _optional_trimmed(message_id, "message_id") or _new_id()
        created_at = _utc_now()
        turn_attachments = self._prepare_live_attachments(attachments)
        self._sdk.server.dispatch_command(
            {
                "type": "thread.turn.start",
                "commandId": _new_id(),
                "threadId": thread.id,
                "message": {
                    "messageId": message_id,
                    "role": "user",
                    "text": text,
                    "attachments": turn_attachments,
                },
                **({"provider": normalized_provider} if normalized_provider is not None else {}),
                **({"model": normalized_model} if normalized_model is not None else {}),
                **({"modelOptions": normalized_model_options} if normalized_model_options is not None else {}),
                **({"providerOptions": normalized_provider_options} if normalized_provider_options is not None else {}),
                "assistantDeliveryMode": normalized_delivery_mode,
                "runtimeMode": thread.runtime_mode,
                "interactionMode": thread.interaction_mode,
                **(
                    {
                        "sourceProposedPlan": {
                            "threadId": source_thread_id,
                            "planId": source_plan_id,
                        }
                    }
                    if source_thread_id is not None and source_plan_id is not None
                    else {}
                ),
                "createdAt": created_at,
            }
        )
        message = self._sdk._wait_for_message(message_id, timeout=timeout)
        if message is not None:
            return message
        return Message(
            id=message_id,
            thread_id=thread.id,
            turn_id=None,
            role="user",
            text=text,
            attachments=[],
            streaming=False,
            created_at=created_at,
            updated_at=created_at,
        )

    def _prepare_live_attachments(
        self, attachments: Optional[Iterable[dict[str, Any]]]
    ) -> list[dict[str, Any]]:
        if attachments is None:
            return []
        normalized: list[dict[str, Any]] = []
        for index, attachment in enumerate(attachments):
            if not isinstance(attachment, dict):
                raise TypeError(f"attachments[{index}] must be a dictionary")
            attachment_type = _validate_enum(str(attachment.get("type", "image")), "attachment.type", {"image"})
            name = _trimmed(str(attachment.get("name", "")), "attachment.name", max_length=255)
            mime_type = _trimmed(str(attachment.get("mimeType", "")), "attachment.mimeType", max_length=100)
            data_url = _trimmed(str(attachment.get("dataUrl", "")), "attachment.dataUrl")
            size_bytes = attachment.get("sizeBytes")
            if not isinstance(size_bytes, int) or size_bytes < 0 or size_bytes > MAX_IMAGE_BYTES:
                raise ValueError(
                    f"attachment.sizeBytes must be an integer between 0 and {MAX_IMAGE_BYTES}"
                )
            normalized.append(
                {
                    "type": attachment_type,
                    "name": name,
                    "mimeType": mime_type,
                    "sizeBytes": size_bytes,
                    "dataUrl": data_url,
                }
            )
        if len(normalized) > MAX_ATTACHMENTS:
            raise ValueError(f"attachments cannot contain more than {MAX_ATTACHMENTS} items")
        return normalized


class ThreadMessagesManager:
    def __init__(self, sdk: T3, thread_id: str):
        self._sdk = sdk
        self._thread_id = thread_id

    def list(self, *, limit: Optional[int] = None) -> list[Message]:
        self._sdk._require_thread(self._thread_id)
        conn = self._sdk._connect()
        try:
            sql = """
                SELECT *
                FROM projection_thread_messages
                WHERE thread_id = ?
                ORDER BY created_at ASC, message_id ASC
            """
            rows = conn.execute(sql, (self._thread_id,)).fetchall()
            messages = [self._sdk._message_from_row(row) for row in rows]
            if limit is None:
                return messages
            if not isinstance(limit, int) or limit < 1:
                raise ValueError("limit must be a positive integer")
            return messages[-limit:]
        finally:
            conn.close()

    def send(
        self,
        text: str,
        *,
        run: bool = False,
        message_id: Optional[str] = None,
        attachments: Optional[Iterable[dict[str, Any]]] = None,
        provider: Optional[str] = None,
        model: Optional[str] = None,
        model_options: Optional[dict[str, Any]] = None,
        provider_options: Optional[dict[str, Any]] = None,
        assistant_delivery_mode: str = DEFAULT_ASSISTANT_DELIVERY_MODE,
        source_proposed_plan_thread_id: Optional[str] = None,
        source_proposed_plan_id: Optional[str] = None,
    ) -> Message:
        if run:
            return ThreadHandle(self._sdk, self._thread_id).run(
                text,
                message_id=message_id,
                attachments=attachments,
                provider=provider,
                model=model,
                model_options=model_options,
                provider_options=provider_options,
                assistant_delivery_mode=assistant_delivery_mode,
                source_proposed_plan_thread_id=source_proposed_plan_thread_id,
                source_proposed_plan_id=source_proposed_plan_id,
            )
        thread = self._sdk._require_thread(self._thread_id)
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        normalized_text = text
        if not normalized_text.strip():
            raise ValueError("text must be a non-empty string")
        if len(normalized_text) > MAX_INPUT_CHARS:
            raise ValueError(f"text must be at most {MAX_INPUT_CHARS} characters")
        normalized_attachments = _validate_attachments(attachments)
        normalized_provider = _validate_enum(provider, "provider", PROVIDERS) if provider else None
        normalized_model = _optional_trimmed(model, "model")
        normalized_model_options = _validate_json_mapping(model_options, "model_options")
        normalized_provider_options = _validate_json_mapping(provider_options, "provider_options")
        normalized_delivery_mode = _validate_enum(
            assistant_delivery_mode, "assistant_delivery_mode", ASSISTANT_DELIVERY_MODES
        )
        source_thread_id = _optional_trimmed(source_proposed_plan_thread_id, "source_proposed_plan_thread_id")
        source_plan_id = _optional_trimmed(source_proposed_plan_id, "source_proposed_plan_id")
        if (source_thread_id is None) != (source_plan_id is None):
            raise ValueError(
                "source_proposed_plan_thread_id and source_proposed_plan_id must be provided together"
            )
        now = _utc_now()
        message_id = _optional_trimmed(message_id, "message_id") or _new_id()
        command_id = _new_id()
        with self._sdk._transaction() as (_, cur):
            user_event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.message-sent",
                command_id=command_id,
                occurred_at=now,
                payload={
                    "threadId": thread.id,
                    "messageId": message_id,
                    "role": "user",
                    "text": normalized_text,
                    "attachments": normalized_attachments,
                    "turnId": None,
                    "streaming": False,
                    "createdAt": now,
                    "updatedAt": now,
                },
            )
            cur.execute(
                """
                INSERT INTO projection_thread_messages (
                  message_id,
                  thread_id,
                  turn_id,
                  role,
                  text,
                  attachments_json,
                  is_streaming,
                  created_at,
                  updated_at
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
                """,
                (
                    message_id,
                    thread.id,
                    normalized_text,
                    json.dumps(normalized_attachments) if normalized_attachments else None,
                    now,
                    now,
                ),
            )
            turn_event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.turn-start-requested",
                command_id=command_id,
                occurred_at=now,
                causation_event_id=user_event["event_id"],
                payload={
                    "threadId": thread.id,
                    "messageId": message_id,
                    **({"provider": normalized_provider} if normalized_provider is not None else {}),
                    **({"model": normalized_model} if normalized_model is not None else {}),
                    **({"modelOptions": normalized_model_options} if normalized_model_options is not None else {}),
                    **(
                        {"providerOptions": normalized_provider_options}
                        if normalized_provider_options is not None
                        else {}
                    ),
                    "assistantDeliveryMode": normalized_delivery_mode,
                    "runtimeMode": thread.runtime_mode,
                    "interactionMode": thread.interaction_mode,
                    **(
                        {
                            "sourceProposedPlan": {
                                "threadId": source_thread_id,
                                "planId": source_plan_id,
                            }
                        }
                        if source_thread_id is not None and source_plan_id is not None
                        else {}
                    ),
                    "createdAt": now,
                },
            )
            cur.execute(
                """
                DELETE FROM projection_turns
                WHERE thread_id = ?
                  AND turn_id IS NULL
                  AND state = 'pending'
                  AND checkpoint_turn_count IS NULL
                """,
                (thread.id,),
            )
            cur.execute(
                """
                INSERT INTO projection_turns (
                  thread_id,
                  turn_id,
                  pending_message_id,
                  source_proposed_plan_thread_id,
                  source_proposed_plan_id,
                  assistant_message_id,
                  state,
                  requested_at,
                  started_at,
                  completed_at,
                  checkpoint_turn_count,
                  checkpoint_ref,
                  checkpoint_status,
                  checkpoint_files_json
                )
                VALUES (?, NULL, ?, ?, ?, NULL, 'pending', ?, NULL, NULL, NULL, NULL, NULL, '[]')
                """,
                (thread.id, message_id, source_thread_id, source_plan_id, now),
            )
            cur.execute(
                "UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?",
                (now, thread.id),
            )
            self._sdk._touch_projection_state(
                cur,
                sequence=turn_event["sequence"],
                occurred_at=turn_event["occurred_at"],
            )
        conn = self._sdk._connect()
        try:
            row = conn.execute(
                "SELECT * FROM projection_thread_messages WHERE message_id = ?",
                (message_id,),
            ).fetchone()
            return self._sdk._message_from_row(row)
        finally:
            conn.close()

    def record_assistant(
        self,
        *,
        turn_id: str,
        text: str,
        message_id: Optional[str] = None,
        attachments: Optional[Iterable[dict[str, Any]]] = None,
        streaming: bool = False,
    ) -> Message:
        thread = self._sdk._require_thread(self._thread_id)
        normalized_turn_id = _trimmed(turn_id, "turn_id")
        if not isinstance(text, str):
            raise TypeError("text must be a string")
        normalized_attachments = _validate_attachments(attachments)
        message_id = _optional_trimmed(message_id, "message_id") or _new_id()
        now = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.message-sent",
                command_id=f"server:{_new_id()}",
                occurred_at=now,
                payload={
                    "threadId": thread.id,
                    "messageId": message_id,
                    "role": "assistant",
                    "text": text,
                    **({"attachments": normalized_attachments} if normalized_attachments else {}),
                    "turnId": normalized_turn_id,
                    "streaming": bool(streaming),
                    "createdAt": now,
                    "updatedAt": now,
                },
            )
            existing = cur.execute(
                "SELECT * FROM projection_thread_messages WHERE message_id = ?",
                (message_id,),
            ).fetchone()
            next_text = (
                f"{existing['text']}{text}"
                if existing is not None and bool(streaming)
                else text or (existing["text"] if existing is not None else "")
            )
            next_attachments = normalized_attachments or (
                _json_loads(existing["attachments_json"], []) if existing is not None else None
            )
            cur.execute(
                """
                INSERT INTO projection_thread_messages (
                  message_id,
                  thread_id,
                  turn_id,
                  role,
                  text,
                  attachments_json,
                  is_streaming,
                  created_at,
                  updated_at
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
                """,
                (
                    message_id,
                    thread.id,
                    normalized_turn_id,
                    next_text,
                    json.dumps(next_attachments) if next_attachments else None,
                    1 if streaming else 0,
                    existing["created_at"] if existing is not None else now,
                    now,
                ),
            )
            turn_row = cur.execute(
                "SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id = ?",
                (thread.id, normalized_turn_id),
            ).fetchone()
            if turn_row is None:
                cur.execute(
                    """
                    INSERT INTO projection_turns (
                      thread_id,
                      turn_id,
                      pending_message_id,
                      source_proposed_plan_thread_id,
                      source_proposed_plan_id,
                      assistant_message_id,
                      state,
                      requested_at,
                      started_at,
                      completed_at,
                      checkpoint_turn_count,
                      checkpoint_ref,
                      checkpoint_status,
                      checkpoint_files_json
                    )
                    VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, NULL, NULL, NULL, '[]')
                    """,
                    (
                        thread.id,
                        normalized_turn_id,
                        message_id,
                        "running" if streaming else "completed",
                        now,
                        now,
                        None if streaming else now,
                    ),
                )
            else:
                next_state = turn_row["state"]
                if not streaming and next_state not in {"interrupted", "error"}:
                    next_state = "completed"
                cur.execute(
                    """
                    UPDATE projection_turns
                    SET
                      assistant_message_id = ?,
                      state = ?,
                      started_at = COALESCE(started_at, ?),
                      requested_at = COALESCE(requested_at, ?),
                      completed_at = ?
                    WHERE thread_id = ? AND turn_id = ?
                    """,
                    (
                        message_id,
                        next_state,
                        now,
                        now,
                        None if streaming else (turn_row["completed_at"] or now),
                        thread.id,
                        normalized_turn_id,
                    ),
                )
            cur.execute(
                "UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?",
                (normalized_turn_id, now, thread.id),
            )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        conn = self._sdk._connect()
        try:
            row = conn.execute(
                "SELECT * FROM projection_thread_messages WHERE message_id = ?",
                (message_id,),
            ).fetchone()
            return self._sdk._message_from_row(row)
        finally:
            conn.close()


class ThreadActivitiesManager:
    def __init__(self, sdk: T3, thread_id: str):
        self._sdk = sdk
        self._thread_id = thread_id

    def list(self, *, limit: Optional[int] = None) -> list[ThreadActivity]:
        thread = self._sdk._require_thread(self._thread_id)
        activities = thread.activities
        if limit is None:
            return activities
        if not isinstance(limit, int) or limit < 1:
            raise ValueError("limit must be a positive integer")
        return activities[-limit:]

    def append(
        self,
        *,
        kind: str,
        summary: str,
        payload: Optional[dict[str, Any]] = None,
        tone: str = "info",
        turn_id: Optional[str] = None,
        sequence: Optional[int] = None,
        activity_id: Optional[str] = None,
    ) -> ThreadActivity:
        thread = self._sdk._require_thread(self._thread_id)
        normalized_kind = _trimmed(kind, "kind")
        normalized_summary = _trimmed(summary, "summary")
        normalized_payload = payload or {}
        if not isinstance(normalized_payload, dict):
            raise TypeError("payload must be a dictionary")
        normalized_tone = _validate_enum(tone, "tone", ACTIVITY_TONES)
        normalized_turn_id = _optional_trimmed(turn_id, "turn_id")
        if sequence is not None and (not isinstance(sequence, int) or sequence < 0):
            raise ValueError("sequence must be a non-negative integer")
        activity_id = _optional_trimmed(activity_id, "activity_id") or _new_id()
        created_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.activity-appended",
                command_id=f"server:{_new_id()}",
                occurred_at=created_at,
                metadata=(
                    {"requestId": normalized_payload.get("requestId")}
                    if isinstance(normalized_payload.get("requestId"), str)
                    else {}
                ),
                payload={
                    "threadId": thread.id,
                    "activity": {
                        "id": activity_id,
                        "tone": normalized_tone,
                        "kind": normalized_kind,
                        "summary": normalized_summary,
                        "payload": normalized_payload,
                        "turnId": normalized_turn_id,
                        **({"sequence": sequence} if sequence is not None else {}),
                        "createdAt": created_at,
                    },
                },
            )
            cur.execute(
                """
                INSERT INTO projection_thread_activities (
                  activity_id,
                  thread_id,
                  turn_id,
                  tone,
                  kind,
                  summary,
                  payload_json,
                  created_at,
                  sequence
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
                """,
                (
                    activity_id,
                    thread.id,
                    normalized_turn_id,
                    normalized_tone,
                    normalized_kind,
                    normalized_summary,
                    json.dumps(normalized_payload),
                    created_at,
                    sequence,
                ),
            )
            request_id = normalized_payload.get("requestId")
            if isinstance(request_id, str):
                existing = cur.execute(
                    "SELECT * FROM projection_pending_approvals WHERE request_id = ?",
                    (request_id,),
                ).fetchone()
                if normalized_kind == "approval.resolved":
                    decision = normalized_payload.get("decision")
                    if decision not in APPROVAL_DECISIONS:
                        decision = None
                    cur.execute(
                        """
                        INSERT INTO projection_pending_approvals (
                          request_id, thread_id, turn_id, status, decision, created_at, resolved_at
                        )
                        VALUES (?, ?, ?, 'resolved', ?, ?, ?)
                        ON CONFLICT(request_id)
                        DO UPDATE SET
                          thread_id = excluded.thread_id,
                          turn_id = excluded.turn_id,
                          status = excluded.status,
                          decision = excluded.decision,
                          created_at = projection_pending_approvals.created_at,
                          resolved_at = excluded.resolved_at
                        """,
                        (
                            request_id,
                            existing["thread_id"] if existing is not None else thread.id,
                            existing["turn_id"] if existing is not None else normalized_turn_id,
                            decision,
                            existing["created_at"] if existing is not None else created_at,
                            created_at,
                        ),
                    )
                elif existing is None or existing["status"] != "resolved":
                    cur.execute(
                        """
                        INSERT INTO projection_pending_approvals (
                          request_id, thread_id, turn_id, status, decision, created_at, resolved_at
                        )
                        VALUES (?, ?, ?, 'pending', NULL, ?, NULL)
                        ON CONFLICT(request_id)
                        DO UPDATE SET
                          thread_id = excluded.thread_id,
                          turn_id = excluded.turn_id,
                          status = excluded.status,
                          decision = NULL,
                          created_at = projection_pending_approvals.created_at,
                          resolved_at = NULL
                        """,
                        (
                            request_id,
                            thread.id,
                            normalized_turn_id,
                            existing["created_at"] if existing is not None else created_at,
                        ),
                    )
            cur.execute("UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?", (created_at, thread.id))
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        conn = self._sdk._connect()
        try:
            row = conn.execute(
                "SELECT * FROM projection_thread_activities WHERE activity_id = ?",
                (activity_id,),
            ).fetchone()
            return self._sdk._activity_from_row(row)
        finally:
            conn.close()


class ThreadSessionManager:
    def __init__(self, sdk: T3, thread_id: str):
        self._sdk = sdk
        self._thread_id = thread_id

    def get(self) -> Optional[Session]:
        return self._sdk._require_thread(self._thread_id).session

    def set(
        self,
        *,
        status: str,
        provider_name: Optional[str] = None,
        runtime_mode: Optional[str] = None,
        active_turn_id: Optional[str] = None,
        last_error: Optional[str] = None,
    ) -> Session:
        thread = self._sdk._require_thread(self._thread_id)
        normalized_status = _validate_enum(status, "status", SESSION_STATUSES)
        normalized_provider_name = _optional_trimmed(provider_name, "provider_name")
        normalized_runtime_mode = (
            _validate_enum(runtime_mode, "runtime_mode", RUNTIME_MODES)
            if runtime_mode is not None
            else thread.runtime_mode
        )
        normalized_active_turn_id = _optional_trimmed(active_turn_id, "active_turn_id")
        normalized_last_error = _optional_trimmed(last_error, "last_error") if last_error is not None else None
        updated_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.session-set",
                command_id=f"server:{_new_id()}",
                occurred_at=updated_at,
                payload={
                    "threadId": thread.id,
                    "session": {
                        "threadId": thread.id,
                        "status": normalized_status,
                        "providerName": normalized_provider_name,
                        "runtimeMode": normalized_runtime_mode,
                        "activeTurnId": normalized_active_turn_id,
                        "lastError": normalized_last_error,
                        "updatedAt": updated_at,
                    },
                },
            )
            cur.execute(
                """
                INSERT INTO projection_thread_sessions (
                  thread_id,
                  status,
                  provider_name,
                  runtime_mode,
                  active_turn_id,
                  last_error,
                  updated_at
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
                """,
                (
                    thread.id,
                    normalized_status,
                    normalized_provider_name,
                    normalized_runtime_mode,
                    normalized_active_turn_id,
                    normalized_last_error,
                    updated_at,
                ),
            )
            if normalized_active_turn_id and normalized_status == "running":
                pending = cur.execute(
                    """
                    SELECT *
                    FROM projection_turns
                    WHERE thread_id = ?
                      AND turn_id IS NULL
                      AND state = 'pending'
                      AND checkpoint_turn_count IS NULL
                    ORDER BY requested_at DESC
                    LIMIT 1
                    """,
                    (thread.id,),
                ).fetchone()
                existing_turn = cur.execute(
                    "SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id = ?",
                    (thread.id, normalized_active_turn_id),
                ).fetchone()
                requested_at = pending["requested_at"] if pending is not None else updated_at
                pending_message_id = pending["pending_message_id"] if pending is not None else None
                source_plan_thread = pending["source_proposed_plan_thread_id"] if pending is not None else None
                source_plan_id = pending["source_proposed_plan_id"] if pending is not None else None
                if existing_turn is None:
                    cur.execute(
                        """
                        INSERT INTO projection_turns (
                          thread_id,
                          turn_id,
                          pending_message_id,
                          source_proposed_plan_thread_id,
                          source_proposed_plan_id,
                          assistant_message_id,
                          state,
                          requested_at,
                          started_at,
                          completed_at,
                          checkpoint_turn_count,
                          checkpoint_ref,
                          checkpoint_status,
                          checkpoint_files_json
                        )
                        VALUES (?, ?, ?, ?, ?, NULL, 'running', ?, ?, NULL, NULL, NULL, NULL, '[]')
                        """,
                        (
                            thread.id,
                            normalized_active_turn_id,
                            pending_message_id,
                            source_plan_thread,
                            source_plan_id,
                            requested_at,
                            requested_at,
                        ),
                    )
                else:
                    cur.execute(
                        """
                        UPDATE projection_turns
                        SET
                          pending_message_id = COALESCE(pending_message_id, ?),
                          source_proposed_plan_thread_id = COALESCE(source_proposed_plan_thread_id, ?),
                          source_proposed_plan_id = COALESCE(source_proposed_plan_id, ?),
                          state = CASE
                            WHEN state IN ('completed', 'error') THEN state
                            ELSE 'running'
                          END,
                          requested_at = COALESCE(requested_at, ?),
                          started_at = COALESCE(started_at, ?)
                        WHERE thread_id = ? AND turn_id = ?
                        """,
                        (
                            pending_message_id,
                            source_plan_thread,
                            source_plan_id,
                            requested_at,
                            requested_at,
                            thread.id,
                            normalized_active_turn_id,
                        ),
                    )
                if pending is not None:
                    cur.execute(
                        """
                        DELETE FROM projection_turns
                        WHERE row_id = ?
                        """,
                        (pending["row_id"],),
                    )
                cur.execute(
                    "UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?",
                    (normalized_active_turn_id, updated_at, thread.id),
                )
            else:
                cur.execute(
                    "UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?",
                    (updated_at, thread.id),
                )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        session = self.get()
        if session is None:
            raise RuntimeError("failed to load session after write")
        return session

    def stop(self) -> None:
        thread = self._sdk._require_thread(self._thread_id)
        created_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.session-stop-requested",
                command_id=_new_id(),
                occurred_at=created_at,
                payload={"threadId": thread.id, "createdAt": created_at},
            )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])


class ThreadProposedPlansManager:
    def __init__(self, sdk: T3, thread_id: str):
        self._sdk = sdk
        self._thread_id = thread_id

    def list(self) -> list[ProposedPlan]:
        return self._sdk._require_thread(self._thread_id).proposed_plans

    def upsert(
        self,
        plan_markdown: str,
        *,
        plan_id: Optional[str] = None,
        turn_id: Optional[str] = None,
        implemented_at: Optional[str] = None,
        implementation_thread_id: Optional[str] = None,
    ) -> ProposedPlan:
        thread = self._sdk._require_thread(self._thread_id)
        normalized_plan_id = _optional_trimmed(plan_id, "plan_id") or _new_id()
        normalized_turn_id = _optional_trimmed(turn_id, "turn_id")
        normalized_markdown = _trimmed(plan_markdown, "plan_markdown")
        normalized_implemented_at = _optional_trimmed(implemented_at, "implemented_at")
        normalized_implementation_thread_id = _optional_trimmed(
            implementation_thread_id, "implementation_thread_id"
        )
        now = _utc_now()
        with self._sdk._transaction() as (_, cur):
            existing = cur.execute(
                "SELECT * FROM projection_thread_proposed_plans WHERE plan_id = ?",
                (normalized_plan_id,),
            ).fetchone()
            created_at = existing["created_at"] if existing is not None else now
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.proposed-plan-upserted",
                command_id=f"server:{_new_id()}",
                occurred_at=now,
                payload={
                    "threadId": thread.id,
                    "proposedPlan": {
                        "id": normalized_plan_id,
                        "turnId": normalized_turn_id,
                        "planMarkdown": normalized_markdown,
                        "implementedAt": normalized_implemented_at,
                        "implementationThreadId": normalized_implementation_thread_id,
                        "createdAt": created_at,
                        "updatedAt": now,
                    },
                },
            )
            cur.execute(
                """
                INSERT INTO projection_thread_proposed_plans (
                  plan_id,
                  thread_id,
                  turn_id,
                  plan_markdown,
                  implemented_at,
                  implementation_thread_id,
                  created_at,
                  updated_at
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
                """,
                (
                    normalized_plan_id,
                    thread.id,
                    normalized_turn_id,
                    normalized_markdown,
                    normalized_implemented_at,
                    normalized_implementation_thread_id,
                    created_at,
                    now,
                ),
            )
            cur.execute("UPDATE projection_threads SET updated_at = ? WHERE thread_id = ?", (now, thread.id))
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        conn = self._sdk._connect()
        try:
            row = conn.execute(
                "SELECT * FROM projection_thread_proposed_plans WHERE plan_id = ?",
                (normalized_plan_id,),
            ).fetchone()
            return self._sdk._plan_from_row(row)
        finally:
            conn.close()


class ThreadApprovalsManager:
    def __init__(self, sdk: T3, thread_id: str):
        self._sdk = sdk
        self._thread_id = thread_id

    def list(self, *, active_only: bool = False) -> list[PendingApproval]:
        approvals = self._sdk._require_thread(self._thread_id).pending_approvals
        if active_only:
            return [approval for approval in approvals if approval.status == "pending"]
        return approvals

    def respond(self, request_id: str, decision: str) -> PendingApproval:
        thread = self._sdk._require_thread(self._thread_id)
        normalized_request_id = _trimmed(request_id, "request_id")
        normalized_decision = _validate_enum(decision, "decision", APPROVAL_DECISIONS)
        created_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            existing = cur.execute(
                "SELECT * FROM projection_pending_approvals WHERE request_id = ?",
                (normalized_request_id,),
            ).fetchone()
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.approval-response-requested",
                command_id=_new_id(),
                occurred_at=created_at,
                payload={
                    "threadId": thread.id,
                    "requestId": normalized_request_id,
                    "decision": normalized_decision,
                    "createdAt": created_at,
                },
            )
            cur.execute(
                """
                INSERT INTO projection_pending_approvals (
                  request_id,
                  thread_id,
                  turn_id,
                  status,
                  decision,
                  created_at,
                  resolved_at
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
                """,
                (
                    normalized_request_id,
                    existing["thread_id"] if existing is not None else thread.id,
                    existing["turn_id"] if existing is not None else None,
                    normalized_decision,
                    existing["created_at"] if existing is not None else created_at,
                    created_at,
                ),
            )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        conn = self._sdk._connect()
        try:
            row = conn.execute(
                "SELECT * FROM projection_pending_approvals WHERE request_id = ?",
                (normalized_request_id,),
            ).fetchone()
            return self._sdk._approval_from_row(row)
        finally:
            conn.close()

    def respond_to_user_input(self, request_id: str, answers: dict[str, Any]) -> None:
        thread = self._sdk._require_thread(self._thread_id)
        normalized_request_id = _trimmed(request_id, "request_id")
        if not isinstance(answers, dict):
            raise TypeError("answers must be a dictionary")
        created_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.user-input-response-requested",
                command_id=_new_id(),
                occurred_at=created_at,
                payload={
                    "threadId": thread.id,
                    "requestId": normalized_request_id,
                    "answers": answers,
                    "createdAt": created_at,
                },
            )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])


class ThreadTurnsManager:
    def __init__(self, sdk: T3, thread_id: str):
        self._sdk = sdk
        self._thread_id = thread_id

    def list(self) -> list[Turn]:
        return self._sdk._require_thread(self._thread_id).turns

    def interrupt(self, *, turn_id: Optional[str] = None) -> Turn:
        thread = self._sdk._require_thread(self._thread_id)
        normalized_turn_id = _optional_trimmed(turn_id, "turn_id")
        created_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.turn-interrupt-requested",
                command_id=_new_id(),
                occurred_at=created_at,
                payload={
                    "threadId": thread.id,
                    **({"turnId": normalized_turn_id} if normalized_turn_id is not None else {}),
                    "createdAt": created_at,
                },
            )
            if normalized_turn_id is not None:
                existing = cur.execute(
                    "SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id = ?",
                    (thread.id, normalized_turn_id),
                ).fetchone()
                if existing is None:
                    cur.execute(
                        """
                        INSERT INTO projection_turns (
                          thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
                          source_proposed_plan_id, assistant_message_id, state, requested_at,
                          started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
                          checkpoint_status, checkpoint_files_json
                        )
                        VALUES (?, ?, NULL, NULL, NULL, NULL, 'interrupted', ?, ?, ?, NULL, NULL, NULL, '[]')
                        """,
                        (thread.id, normalized_turn_id, created_at, created_at, created_at),
                    )
                else:
                    cur.execute(
                        """
                        UPDATE projection_turns
                        SET
                          state = 'interrupted',
                          started_at = COALESCE(started_at, ?),
                          requested_at = COALESCE(requested_at, ?),
                          completed_at = COALESCE(completed_at, ?)
                        WHERE thread_id = ? AND turn_id = ?
                        """,
                        (created_at, created_at, created_at, thread.id, normalized_turn_id),
                    )
                    cur.execute(
                        "UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?",
                        (normalized_turn_id, created_at, thread.id),
                    )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        if normalized_turn_id is None:
            turns = self.list()
            if not turns:
                raise RuntimeError("interrupt recorded but no turns exist on thread")
            return turns[-1]
        return next(turn for turn in self.list() if turn.turn_id == normalized_turn_id)

    def complete_diff(
        self,
        *,
        turn_id: str,
        checkpoint_turn_count: int,
        checkpoint_ref: str,
        status: str,
        files: Iterable[dict[str, Any]] | None = None,
        assistant_message_id: Optional[str] = None,
        completed_at: Optional[str] = None,
    ) -> Turn:
        thread = self._sdk._require_thread(self._thread_id)
        normalized_turn_id = _trimmed(turn_id, "turn_id")
        if not isinstance(checkpoint_turn_count, int) or checkpoint_turn_count < 0:
            raise ValueError("checkpoint_turn_count must be a non-negative integer")
        normalized_checkpoint_ref = _trimmed(checkpoint_ref, "checkpoint_ref")
        normalized_status = _validate_enum(status, "status", {"ready", "missing", "error"})
        normalized_assistant_message_id = _optional_trimmed(assistant_message_id, "assistant_message_id")
        normalized_completed_at = _optional_trimmed(completed_at, "completed_at") or _utc_now()
        normalized_files: list[dict[str, Any]] = []
        for index, item in enumerate(files or []):
            if not isinstance(item, dict):
                raise TypeError(f"files[{index}] must be a dictionary")
            additions = item.get("additions")
            deletions = item.get("deletions")
            if not isinstance(additions, int) or additions < 0:
                raise ValueError("checkpoint file additions must be a non-negative integer")
            if not isinstance(deletions, int) or deletions < 0:
                raise ValueError("checkpoint file deletions must be a non-negative integer")
            normalized_files.append(
                {
                    "path": _trimmed(str(item.get("path", "")), "files.path"),
                    "kind": _trimmed(str(item.get("kind", "")), "files.kind"),
                    "additions": additions,
                    "deletions": deletions,
                }
            )
        with self._sdk._transaction() as (_, cur):
            event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.turn-diff-completed",
                command_id=f"server:{_new_id()}",
                occurred_at=normalized_completed_at,
                payload={
                    "threadId": thread.id,
                    "turnId": normalized_turn_id,
                    "checkpointTurnCount": checkpoint_turn_count,
                    "checkpointRef": normalized_checkpoint_ref,
                    "status": normalized_status,
                    "files": normalized_files,
                    "assistantMessageId": normalized_assistant_message_id,
                    "completedAt": normalized_completed_at,
                },
            )
            cur.execute(
                """
                UPDATE projection_turns
                SET
                  checkpoint_turn_count = NULL,
                  checkpoint_ref = NULL,
                  checkpoint_status = NULL,
                  checkpoint_files_json = '[]'
                WHERE thread_id = ?
                  AND checkpoint_turn_count = ?
                  AND (turn_id IS NULL OR turn_id <> ?)
                """,
                (thread.id, checkpoint_turn_count, normalized_turn_id),
            )
            existing = cur.execute(
                "SELECT * FROM projection_turns WHERE thread_id = ? AND turn_id = ?",
                (thread.id, normalized_turn_id),
            ).fetchone()
            next_state = "error" if normalized_status == "error" else "completed"
            if existing is None:
                cur.execute(
                    """
                    INSERT INTO projection_turns (
                      thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
                      source_proposed_plan_id, assistant_message_id, state, requested_at,
                      started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
                      checkpoint_status, checkpoint_files_json
                    )
                    VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        thread.id,
                        normalized_turn_id,
                        normalized_assistant_message_id,
                        next_state,
                        normalized_completed_at,
                        normalized_completed_at,
                        normalized_completed_at,
                        checkpoint_turn_count,
                        normalized_checkpoint_ref,
                        normalized_status,
                        json.dumps(normalized_files),
                    ),
                )
            else:
                cur.execute(
                    """
                    UPDATE projection_turns
                    SET
                      assistant_message_id = ?,
                      state = ?,
                      started_at = COALESCE(started_at, ?),
                      requested_at = COALESCE(requested_at, ?),
                      completed_at = ?,
                      checkpoint_turn_count = ?,
                      checkpoint_ref = ?,
                      checkpoint_status = ?,
                      checkpoint_files_json = ?
                    WHERE thread_id = ? AND turn_id = ?
                    """,
                    (
                        normalized_assistant_message_id,
                        next_state,
                        normalized_completed_at,
                        normalized_completed_at,
                        normalized_completed_at,
                        checkpoint_turn_count,
                        normalized_checkpoint_ref,
                        normalized_status,
                        json.dumps(normalized_files),
                        thread.id,
                        normalized_turn_id,
                    ),
                )
            cur.execute(
                "UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?",
                (normalized_turn_id, normalized_completed_at, thread.id),
            )
            self._sdk._touch_projection_state(cur, sequence=event["sequence"], occurred_at=event["occurred_at"])
        return next(turn for turn in self.list() if turn.turn_id == normalized_turn_id)


class ThreadCheckpointsManager:
    def __init__(self, sdk: T3, thread_id: str):
        self._sdk = sdk
        self._thread_id = thread_id

    def list(self) -> list[CheckpointSummary]:
        return self._sdk._require_thread(self._thread_id).checkpoints

    def revert(self, turn_count: int) -> Thread:
        if not isinstance(turn_count, int) or turn_count < 0:
            raise ValueError("turn_count must be a non-negative integer")
        thread = self._sdk._require_thread(self._thread_id)
        created_at = _utc_now()
        with self._sdk._transaction() as (_, cur):
            request_event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.checkpoint-revert-requested",
                command_id=_new_id(),
                occurred_at=created_at,
                payload={
                    "threadId": thread.id,
                    "turnCount": turn_count,
                    "createdAt": created_at,
                },
            )
            reverted_event = self._sdk._append_event(
                cur,
                aggregate_kind="thread",
                aggregate_id=thread.id,
                event_type="thread.reverted",
                command_id=f"server:{_new_id()}",
                occurred_at=created_at,
                payload={
                    "threadId": thread.id,
                    "turnCount": turn_count,
                },
            )
            existing_turns = cur.execute(
                "SELECT * FROM projection_turns WHERE thread_id = ?",
                (thread.id,),
            ).fetchall()
            kept = [
                row
                for row in existing_turns
                if row["turn_id"] is not None
                and row["checkpoint_turn_count"] is not None
                and row["checkpoint_turn_count"] <= turn_count
            ]
            retained_turn_ids = {row["turn_id"] for row in kept if row["turn_id"] is not None}
            cur.execute("DELETE FROM projection_turns WHERE thread_id = ?", (thread.id,))
            for row in kept:
                cur.execute(
                    """
                    INSERT INTO projection_turns (
                      thread_id, turn_id, pending_message_id, source_proposed_plan_thread_id,
                      source_proposed_plan_id, assistant_message_id, state, requested_at,
                      started_at, completed_at, checkpoint_turn_count, checkpoint_ref,
                      checkpoint_status, checkpoint_files_json
                    )
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        row["thread_id"],
                        row["turn_id"],
                        row["pending_message_id"],
                        row["source_proposed_plan_thread_id"],
                        row["source_proposed_plan_id"],
                        row["assistant_message_id"],
                        row["state"],
                        row["requested_at"],
                        row["started_at"],
                        row["completed_at"],
                        row["checkpoint_turn_count"],
                        row["checkpoint_ref"],
                        row["checkpoint_status"],
                        row["checkpoint_files_json"],
                    ),
                )
            cur.execute(
                """
                DELETE FROM projection_thread_messages
                WHERE thread_id = ?
                  AND role != 'system'
                  AND (turn_id IS NOT NULL AND turn_id NOT IN ({placeholders}))
                """.format(
                    placeholders=", ".join("?" for _ in retained_turn_ids) or "NULL"
                ),
                (thread.id, *retained_turn_ids),
            )
            cur.execute(
                """
                DELETE FROM projection_thread_activities
                WHERE thread_id = ?
                  AND turn_id IS NOT NULL
                  AND turn_id NOT IN ({placeholders})
                """.format(
                    placeholders=", ".join("?" for _ in retained_turn_ids) or "NULL"
                ),
                (thread.id, *retained_turn_ids),
            )
            cur.execute(
                """
                DELETE FROM projection_thread_proposed_plans
                WHERE thread_id = ?
                  AND turn_id IS NOT NULL
                  AND turn_id NOT IN ({placeholders})
                """.format(
                    placeholders=", ".join("?" for _ in retained_turn_ids) or "NULL"
                ),
                (thread.id, *retained_turn_ids),
            )
            latest_turn_id = kept[-1]["turn_id"] if kept else None
            cur.execute(
                "UPDATE projection_threads SET latest_turn_id = ?, updated_at = ? WHERE thread_id = ?",
                (latest_turn_id, created_at, thread.id),
            )
            self._sdk._touch_projection_state(
                cur,
                sequence=reverted_event["sequence"],
                occurred_at=request_event["occurred_at"],
            )
        return self._sdk._require_thread(thread.id)


T3 = T3Code
