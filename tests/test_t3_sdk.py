import base64
import hashlib
import json
import socket
import struct
import threading
import unittest
from pathlib import Path
from tempfile import TemporaryDirectory

from t3_code_sdk import T3Code


class FakeWsServer:
    def __init__(self, *, response: dict | None = None) -> None:
        self.sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.commands: list[dict] = []
        self.response = response or {"result": {"sequence": 42}}
        self._thread = threading.Thread(target=self._run, daemon=True)
        self._thread.start()

    def close(self) -> None:
        try:
            self.sock.close()
        except OSError:
            pass
        self._thread.join(timeout=1)

    def _recv_exact(self, conn: socket.socket, size: int) -> bytes:
        data = b""
        while len(data) < size:
            chunk = conn.recv(size - len(data))
            if not chunk:
                raise ConnectionError("connection closed")
            data += chunk
        return data

    def _read_frame(self, conn: socket.socket) -> str:
        header = self._recv_exact(conn, 2)
        first, second = header[0], header[1]
        opcode = first & 0x0F
        length = second & 0x7F
        masked = (second & 0x80) != 0
        if length == 126:
            length = struct.unpack("!H", self._recv_exact(conn, 2))[0]
        elif length == 127:
            length = struct.unpack("!Q", self._recv_exact(conn, 8))[0]
        mask_key = self._recv_exact(conn, 4) if masked else b""
        payload = self._recv_exact(conn, length)
        if masked:
            payload = bytes(payload[i] ^ mask_key[i % 4] for i in range(length))
        if opcode != 0x1:
            raise ConnectionError(f"unexpected opcode {opcode}")
        return payload.decode("utf-8")

    def _send_frame(self, conn: socket.socket, text: str) -> None:
        payload = text.encode("utf-8")
        frame = bytearray([0x81])
        length = len(payload)
        if length < 126:
            frame.append(length)
        elif length < (1 << 16):
            frame.append(126)
            frame.extend(struct.pack("!H", length))
        else:
            frame.append(127)
            frame.extend(struct.pack("!Q", length))
        frame.extend(payload)
        conn.sendall(frame)

    def _run(self) -> None:
        try:
            conn, _ = self.sock.accept()
        except OSError:
            return
        with conn:
            request = b""
            while b"\r\n\r\n" not in request:
                chunk = conn.recv(4096)
                if not chunk:
                    return
                request += chunk
            header_text = request.split(b"\r\n\r\n", 1)[0].decode("utf-8")
            headers = {}
            for line in header_text.split("\r\n")[1:]:
                if ":" in line:
                    name, value = line.split(":", 1)
                    headers[name.strip().lower()] = value.strip()
            key = headers["sec-websocket-key"]
            accept = base64.b64encode(
                hashlib.sha1((key + "258EAFA5-E914-47DA-95CA-C5AB0DC85B11").encode("ascii")).digest()
            ).decode("ascii")
            response = (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n"
                "\r\n"
            )
            conn.sendall(response.encode("utf-8"))
            message = json.loads(self._read_frame(conn))
            self.commands.append(message["body"]["command"])
            payload = {"id": message["id"], **self.response}
            self._send_frame(conn, json.dumps(payload))


class T3SdkTestCase(unittest.TestCase):
    def setUp(self) -> None:
        self.tempdir = TemporaryDirectory()
        self.addCleanup(self.tempdir.cleanup)
        self.root = Path(self.tempdir.name)
        self.db_path = self.root / "state.sqlite"
        self.workspace = self.root / "workspace"
        self.workspace.mkdir()
        self.sdk = T3Code(self.db_path)

    def test_create_and_read_projects(self) -> None:
        created = self.sdk.projects.create(
            workspace_root=self.workspace,
            title="Primary Project",
            default_model="gpt-5.4",
            scripts=[
                {
                    "id": "test",
                    "name": "Run Tests",
                    "command": "pytest",
                    "icon": "test",
                    "runOnWorktreeCreate": False,
                }
            ],
        )

        fetched = self.sdk.projects.get(created.id)
        listed = self.sdk.projects.list()
        by_title = self.sdk.projects.get_by_title("Primary Project")
        by_workspace = self.sdk.projects.get_by_workspace_root(self.workspace)

        self.assertIsNotNone(fetched)
        self.assertEqual(fetched.id, created.id)
        self.assertEqual(fetched.workspace_root, str(self.workspace.resolve()))
        self.assertEqual(fetched.scripts[0].command, "pytest")
        self.assertEqual(len(listed), 1)
        self.assertEqual(by_title.id, created.id)
        self.assertEqual(by_workspace.id, created.id)

    def test_get_or_create_project_reuses_existing_project(self) -> None:
        first = self.sdk.projects.get_or_create(workspace_root=self.workspace)
        second = self.sdk.projects.get_or_create(workspace_root=self.workspace)

        self.assertEqual(first.id, second.id)
        self.assertEqual(len(self.sdk.projects.list()), 1)

    def test_find_existing_threads_and_chat_history(self) -> None:
        project = self.sdk.projects.create(
            workspace_root=self.workspace,
            create_initial_thread=False,
        )
        thread = self.sdk.projects.open(project.id).threads.create(title="Agent thread")
        self.sdk.threads.open(thread.id).messages.send("Build a changelog")
        self.sdk.threads.open(thread.id).session.set(status="running", active_turn_id="turn-1")
        self.sdk.threads.open(thread.id).messages.record_assistant(
            turn_id="turn-1",
            text="Created the changelog draft.",
        )

        project_threads = self.sdk.projects.open(project.id).threads.list()
        opened_thread = self.sdk.projects.open(project.id).threads.open(thread.id).get()
        messages = self.sdk.threads.open(thread.id).messages.list()

        self.assertEqual(len(project_threads), 1)
        self.assertEqual(project_threads[0].id, thread.id)
        self.assertEqual(opened_thread.id, thread.id)
        self.assertEqual([message.role for message in messages], ["user", "assistant"])
        self.assertEqual(messages[0].text, "Build a changelog")
        self.assertEqual(messages[1].text, "Created the changelog draft.")

    def test_create_new_project_and_thread_and_send_message(self) -> None:
        project = self.sdk.projects.create(
            workspace_root=self.workspace,
            create_initial_thread=False,
        )
        thread = self.sdk.projects.open(project.id).threads.create(
            title="Execution",
            model="gpt-5.4-mini",
            runtime_mode="full-access",
            interaction_mode="plan",
        )
        message = self.sdk.threads.open(thread.id).messages.send(
            "Refactor the auth flow",
            provider="codex",
            model="gpt-5.4-mini",
        )
        session = self.sdk.threads.open(thread.id).session.set(
            status="running",
            provider_name="codex",
            active_turn_id="turn-auth-1",
        )
        assistant = self.sdk.threads.open(thread.id).messages.record_assistant(
            turn_id="turn-auth-1",
            text="I updated the auth flow and added tests.",
        )

        refreshed_thread = self.sdk.threads.get(thread.id)

        self.assertEqual(message.role, "user")
        self.assertEqual(session.active_turn_id, "turn-auth-1")
        self.assertEqual(assistant.role, "assistant")
        self.assertEqual(refreshed_thread.latest_turn.turn_id, "turn-auth-1")
        self.assertEqual(refreshed_thread.messages[-1].text, "I updated the auth flow and added tests.")

    def test_direct_model_api_is_ergonomic(self) -> None:
        project = self.sdk.projects.create(
            workspace_root=self.workspace,
            title="t3sdk",
            create_initial_thread=False,
        )

        found_project = self.sdk.find_project("t3sdk")
        self.assertIsNotNone(found_project)

        thread = found_project.create_thread(title="Direct thread")
        user_message = thread.send_message("Do the work")
        thread.set_session(status="running", provider_name="codex", active_turn_id="turn-1")
        assistant_message = thread.record_assistant_message(
            turn_id="turn-1",
            text="Done.",
        )

        found_thread = found_project.find_thread("Direct thread")
        all_messages = found_thread.get_messages()

        self.assertEqual(thread.project_id, found_project.id)
        self.assertEqual(user_message.text, "Do the work")
        self.assertEqual(assistant_message.text, "Done.")
        self.assertEqual([message.role for message in all_messages], ["user", "assistant"])

    def test_project_files_search_and_write(self) -> None:
        project = self.sdk.projects.create(
            workspace_root=self.workspace,
            create_initial_thread=False,
        )

        initial = self.sdk.projects.open(project.id).files.search_entries("main.py")
        write_result = self.sdk.projects.open(project.id).files.write_file(
            "src/main.py",
            "print('hello')\n",
        )
        after_write = self.sdk.projects.open(project.id).files.search_entries("main.py")

        self.assertEqual(initial.entries, [])
        self.assertEqual(write_result.relative_path, "src/main.py")
        self.assertEqual(after_write.entries[0].path, "src/main.py")
        self.assertEqual(after_write.entries[0].kind, "file")

    def test_proposed_plans_activities_approvals_and_checkpoints(self) -> None:
        project = self.sdk.projects.create(workspace_root=self.workspace, create_initial_thread=False)
        thread = self.sdk.projects.open(project.id).threads.create(title="Workflow")
        self.sdk.threads.open(thread.id).messages.send("Implement the workflow")
        self.sdk.threads.open(thread.id).session.set(status="running", active_turn_id="turn-1")
        self.sdk.threads.open(thread.id).messages.record_assistant(
            turn_id="turn-1",
            text="Implementation in progress",
            streaming=True,
        )
        plan = self.sdk.threads.open(thread.id).proposed_plans.upsert(
            "1. Add endpoint\n2. Add tests",
            turn_id="turn-1",
        )
        pending_activity = self.sdk.threads.open(thread.id).activities.append(
            kind="approval.requested",
            summary="Need approval to run migrations",
            tone="approval",
            turn_id="turn-1",
            payload={"requestId": "approval-1", "command": "alembic upgrade head"},
        )
        approval = self.sdk.threads.open(thread.id).approvals.respond("approval-1", "accept")
        resolved_activity = self.sdk.threads.open(thread.id).activities.append(
            kind="approval.resolved",
            summary="Approval granted",
            tone="approval",
            turn_id="turn-1",
            payload={"requestId": "approval-1", "decision": "accept"},
        )
        checkpoint_turn = self.sdk.threads.open(thread.id).turns.complete_diff(
            turn_id="turn-1",
            checkpoint_turn_count=1,
            checkpoint_ref="checkpoint-1",
            status="ready",
            assistant_message_id=thread.id,
            files=[{"path": "src/app.py", "kind": "file", "additions": 12, "deletions": 2}],
        )

        refreshed = self.sdk.threads.get(thread.id)

        self.assertEqual(plan.turn_id, "turn-1")
        self.assertEqual(pending_activity.kind, "approval.requested")
        self.assertEqual(resolved_activity.kind, "approval.resolved")
        self.assertEqual(approval.status, "resolved")
        self.assertEqual(checkpoint_turn.checkpoint_ref, "checkpoint-1")
        self.assertEqual(refreshed.pending_approvals[0].decision, "accept")
        self.assertEqual(refreshed.checkpoints[0].files[0].path, "src/app.py")

    def test_validation_rejects_invalid_inputs(self) -> None:
        project = self.sdk.projects.create(workspace_root=self.workspace, create_initial_thread=False)
        thread = self.sdk.projects.open(project.id).threads.create(title="Validation")

        with self.assertRaises(ValueError):
            self.sdk.projects.open(project.id).files.write_file("../outside.py", "bad")

        with self.assertRaises(ValueError):
            self.sdk.threads.open(thread.id).messages.send("")

        with self.assertRaises(ValueError):
            self.sdk.threads.open(thread.id).set_runtime_mode("unsafe-mode")

        with self.assertRaises(ValueError):
            self.sdk.threads.open(thread.id).approvals.respond("approval-1", "yes")

    def test_thread_run_dispatches_live_command_to_server(self) -> None:
        server = FakeWsServer()
        self.addCleanup(server.close)
        sdk = T3Code(self.db_path, server_url=f"ws://127.0.0.1:{server.port}", prefer_server=False)
        project = sdk.projects.create(workspace_root=self.workspace, create_initial_thread=False)
        thread = project.create_thread(title="Live Thread")

        message = thread.run(
            "Execute the task",
            provider="codex",
            model="gpt-5.4",
            timeout=0.01,
        )

        self.assertEqual(message.text, "Execute the task")
        self.assertEqual(len(server.commands), 1)
        command = server.commands[0]
        self.assertEqual(command["type"], "thread.turn.start")
        self.assertEqual(command["threadId"], thread.id)
        self.assertEqual(command["message"]["text"], "Execute the task")
        self.assertEqual(command["provider"], "codex")

    def test_live_thread_create_surfaces_local_only_project_mismatch(self) -> None:
        sdk = T3Code(self.db_path)
        project = sdk.projects.create(workspace_root=self.workspace, create_initial_thread=False)
        server = FakeWsServer(
            response={
                "error": {
                    "message": (
                        "Error: Orchestration command invariant failed (thread.create): "
                        f"Project '{project.id}' does not exist for command 'thread.create'."
                    )
                }
            }
        )
        self.addCleanup(server.close)
        sdk = T3Code(self.db_path, server_url=f"ws://127.0.0.1:{server.port}")
        project = sdk.projects.get(project.id)

        with self.assertRaisesRegex(
            RuntimeError,
            "Create the project with live=True, or disable live dispatch with live=False or T3Code\\(..., prefer_server=False\\)",
        ):
            project.create_thread(title="Live Thread", live=True)

    def test_server_url_enables_prefer_server_by_default(self) -> None:
        server = FakeWsServer()
        self.addCleanup(server.close)
        sdk = T3Code(self.db_path, server_url=f"ws://127.0.0.1:{server.port}")

        self.assertTrue(sdk.prefer_server)


if __name__ == "__main__":
    unittest.main()
