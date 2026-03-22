#!/usr/bin/env node
import { p as T3Code } from "./sdk-CxiDB5Ly.mjs";

//#region src/cli.ts
function parseArgs(argv) {
	const positionals = [];
	const flags = {};
	for (let index = 0; index < argv.length; index += 1) {
		const token = argv[index];
		if (!token?.startsWith("--")) {
			positionals.push(token ?? "");
			continue;
		}
		const key = token.slice(2);
		const next = argv[index + 1];
		if (!next || next.startsWith("--")) {
			flags[key] = true;
			continue;
		}
		flags[key] = next;
		index += 1;
	}
	return {
		positionals,
		flags
	};
}
function readStringFlag(flags, name, required = false) {
	const value = flags[name];
	if (value === void 0) {
		if (required) throw new Error(`Missing required flag --${name}`);
		return;
	}
	if (typeof value !== "string") throw new Error(`Flag --${name} requires a value`);
	return value;
}
function readJsonFlag(flags, name) {
	const value = readStringFlag(flags, name);
	return value ? JSON.parse(value) : void 0;
}
async function runCli(argv) {
	const { positionals, flags } = parseArgs(argv);
	const [resource, action] = positionals;
	const sdk = new T3Code(readStringFlag(flags, "db") ?? void 0, {
		server_url: readStringFlag(flags, "server-url"),
		server_token: readStringFlag(flags, "server-token"),
		prefer_server: flags["prefer-server"] === true ? true : void 0
	});
	if (resource === "project" && action === "list") return sdk.projects.list();
	if (resource === "project" && action === "get") return sdk.projects.get(readStringFlag(flags, "project-id", true), { include_deleted: flags["include-deleted"] === true });
	if (resource === "project" && action === "create") return sdk.projects.create({
		workspace_root: readStringFlag(flags, "workspace-root", true),
		title: readStringFlag(flags, "title"),
		default_model: readStringFlag(flags, "default-model"),
		scripts: readJsonFlag(flags, "scripts"),
		create_initial_thread: flags["no-initial-thread"] === true ? false : true,
		initial_thread_title: readStringFlag(flags, "initial-thread-title"),
		initial_thread_model: readStringFlag(flags, "initial-thread-model"),
		ensure_workspace_exists: flags["ensure-workspace-exists"] === true,
		live: flags.live === true ? true : flags["local-only"] === true ? false : void 0,
		timeout: readStringFlag(flags, "timeout") ? Number(readStringFlag(flags, "timeout")) : void 0
	});
	if (resource === "thread" && action === "list") return sdk.threads.list({
		project_id: readStringFlag(flags, "project-id"),
		include_deleted: flags["include-deleted"] === true
	});
	if (resource === "thread" && action === "get") return sdk.threads.get(readStringFlag(flags, "thread-id", true), { include_deleted: flags["include-deleted"] === true });
	if (resource === "thread" && action === "create") return sdk.projects.open(readStringFlag(flags, "project-id", true)).threads.create({
		title: readStringFlag(flags, "title"),
		model: readStringFlag(flags, "model"),
		runtime_mode: readStringFlag(flags, "runtime-mode"),
		interaction_mode: readStringFlag(flags, "interaction-mode"),
		branch: readStringFlag(flags, "branch"),
		worktree_path: readStringFlag(flags, "worktree-path"),
		live: flags.live === true ? true : flags["local-only"] === true ? false : void 0,
		timeout: readStringFlag(flags, "timeout") ? Number(readStringFlag(flags, "timeout")) : void 0
	});
	if (resource === "message" && action === "send") return sdk.threads.open(readStringFlag(flags, "thread-id", true)).messages.send(readStringFlag(flags, "text", true), {
		run: flags.run === true,
		message_id: readStringFlag(flags, "message-id"),
		attachments: readJsonFlag(flags, "attachments"),
		provider: readStringFlag(flags, "provider"),
		model: readStringFlag(flags, "model"),
		model_options: readJsonFlag(flags, "model-options"),
		provider_options: readJsonFlag(flags, "provider-options"),
		assistant_delivery_mode: readStringFlag(flags, "assistant-delivery-mode")
	});
	if (resource === "thread" && action === "run") return sdk.threads.open(readStringFlag(flags, "thread-id", true)).run(readStringFlag(flags, "text", true), {
		message_id: readStringFlag(flags, "message-id"),
		attachments: readJsonFlag(flags, "attachments"),
		provider: readStringFlag(flags, "provider"),
		model: readStringFlag(flags, "model"),
		model_options: readJsonFlag(flags, "model-options"),
		provider_options: readJsonFlag(flags, "provider-options"),
		assistant_delivery_mode: readStringFlag(flags, "assistant-delivery-mode"),
		timeout: readStringFlag(flags, "timeout") ? Number(readStringFlag(flags, "timeout")) : void 0
	});
	throw new Error("Unknown command. Supported commands: `project list|get|create`, `thread list|get|create|run`, `message send`.");
}
if (import.meta.main) runCli(process.argv.slice(2)).then((result) => {
	if (result !== void 0) process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}).catch((error) => {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 1;
});

//#endregion
export { runCli };