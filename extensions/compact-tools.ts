// Grouped tools: tiered transcript for pi, styled after Antigravity.
//
// Rules for consecutive tool calls within one turn:
//
//   1 call  -> verb line + stock result preview below (live tail, Took timer)
//   2 calls -> normal rows while running; fold to verb lines when the
//              sequence completes
//   3+ call -> from the third call on, a bounded activity window slides over
//              the live output. After completion the window holds for at
//              least MIN_WINDOW_MS, then folds to verb lines:
//
//   … 4 more actions (2 reads, 1 search, 1 command) …
//   ● Ran 2 commands (npm test · pnpm build)
//   ● Read 1 file (output.txt) · 4.2s (ctrl+o to expand)
//
// Consecutive same-tool calls merge into one verb line; older clusters
// compress into a "… N more actions …" line. The status dot is the traffic
// light: green done, amber running, grey pending, red failed. Ctrl+O or a
// mouse click expands the group to the built-in full rendering. Failed
// calls always stay visible. Rows without group state (resumed sessions,
// MCP tools) fall back to the built-in rendering.
//
// Timing notes: the TUI creates a tool row while the assistant message is
// still streaming the call arguments (message_update), before execution
// starts. Calls are therefore pre-registered into their group at that point,
// and every renderCall stores its row invalidator in a global registry, so
// the leader row (which renders the window) can be refreshed from events
// regardless of render order.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import {
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Box, Container, Text } from "@earendil-works/pi-tui";
import { homedir } from "os";

// Loosely typed aliases: the seven factories return tool-specific shapes,
// but their rendering slots are structurally identical.
type RenderCall = (args: any, theme: any, context: any) => any;
type RenderResult = (result: any, options: any, theme: any, context: any) => any;
type ToolDefinitionLike = { renderCall?: RenderCall; renderResult?: RenderResult; [key: string]: any };
type ThemeLike = { fg(color: string, text: string): string; bg(color: string, text: string): string };
type RenderContext = {
	toolCallId: string;
	args: any;
	isPartial: boolean;
	isError: boolean;
	durationMs?: number;
	outputPad: number;
	invalidate(): void;
	keyHint(key: string, description: string): string;
};

// Verb lines: [verb, noun] for consecutive same-tool clusters
const VERBS: Record<string, [string, string]> = {
	bash: ["Ran", "command"],
	powershell: ["Ran", "command"],
	read: ["Read", "file"],
	ls: ["Explored", "path"],
	find: ["Searched", "pattern"],
	grep: ["Searched", "pattern"],
	edit: ["Updated", "file"],
	write: ["Wrote", "file"],
};

// Nouns for the "… N more actions (2 reads, 1 command) …" compression line
const NOUNS: Record<string, string> = {
	bash: "command",
	powershell: "command",
	read: "read",
	ls: "list",
	find: "list",
	grep: "search",
	edit: "edit",
	write: "write",
};

// Claude Code's names for the tools Pi shares with it
const LABELS: Record<string, string> = {
	read: "Read",
	grep: "Search",
	find: "Search",
	ls: "List",
	bash: "Bash",
	powershell: "PowerShell",
	edit: "Update",
	write: "Write",
};

const DOT = "●";
const CONNECTOR = "⎿";
const KEPT_CLUSTERS = 3; // clusters shown before older ones compress
const INLINE_ARGS = 3; // args shown inside a cluster line

const BODY_LINES = 10; // live tail height per running tool
const MIN_WINDOW_MS = 2000; // the window stays at least this long once shown
const THINKING_TAIL_LINES = 3; // Grok-style thinking preview height
let thinkingFull = false; // /think-full toggles full thinking vs 3-line preview
const ANSI_RE = /\x1b\[[0-9;]*[A-Za-z]/g;

interface GroupedCall {
	id: string;
	name: string;
	started: boolean;
	durationMs?: number;
	isError: boolean;
}

type CallStatus = "pending" | "running" | "success" | "error";

interface Group {
	calls: GroupedCall[];
	pending: number; // streamed but not executing yet
	running: number;
	ended: boolean; // sequence closed; window may still be holding
	finalizing: boolean; // hold timer scheduled
	finalized: boolean; // folded to verb lines
	expanded: boolean;
	windowOpenedAt?: number; // when the third call made the window appear
}

// Shared transcript state, rebuilt from live events each session.
const groups = new Map<string, Group>(); // toolCallId -> its group
const seen = new Map<string, boolean>(); // toolCallId -> last row expanded state
const rowInvalidators = new Map<string, () => void>(); // toolCallId -> row invalidate
const callArgs = new Map<string, string>(); // toolCallId -> inline arg (command / path / pattern)
const partialTexts = new Map<string, string>(); // toolCallId -> live output text
let current: Group | undefined;
let uiCtx: any; // latest extension context with ctx.ui, for timers

function resultText(result: any): string {
	if (!Array.isArray(result?.content)) return "";
	return result.content
		.filter((c: any) => c?.type === "text" && typeof c.text === "string")
		.map((c: any) => c.text)
		.join("\n");
}

function countLines(text: string): number {
	return text.split("\n").filter((l) => l.trim() !== "").length;
}

function firstLine(text: string): string {
	const line = text.split("\n").find((l) => l.trim() !== "") ?? "";
	return line.length > 120 ? `${line.slice(0, 119)}…` : line;
}

function label(name: string): string {
	return LABELS[name] ?? name;
}

function cut(text: string, max: number): string {
	return [...text].length > max ? `${[...text].slice(0, max - 1).join("")}…` : text;
}

function plural(n: number, noun: string): string {
	const suffix = /(s|ch|sh|x)$/.test(noun) ? "es" : "s";
	return `${n} ${noun}${n > 1 ? suffix : ""}`;
}

// Shorten a path for inline display: cwd-relative, then home-relative
function shortenPath(p: string): string {
	const home = homedir();
	const cwd = process.cwd();
	if (p === cwd) return ".";
	if (p.startsWith(cwd + "/")) return p.slice(cwd.length + 1);
	if (p.startsWith(home)) return "~" + p.slice(home.length);
	return p;
}

// The inline argument of a call: the command, the path, or the pattern
function callArg(name: string, args: any): string {
	const a = args ?? {};
	if (name === "bash" || name === "powershell") {
		return cut(String(a.command ?? "").replace(/\s*\n\s*/g, " "), 100);
	}
	if (name === "grep" || name === "find") {
		return typeof a.pattern === "string" ? cut(a.pattern, 100) : "";
	}
	return typeof a.path === "string" ? cut(shortenPath(a.path), 100) : "";
}

function callStatus(call: GroupedCall): CallStatus {
	if (call.isError) return "error";
	if (call.durationMs !== undefined) return "success";
	return call.started ? "running" : "pending";
}

const STATUS_TONE: Record<CallStatus, string> = {
	pending: "muted",
	running: "warning",
	success: "success",
	error: "error",
};

function dot(status: CallStatus, theme: ThemeLike): string {
	return theme.fg(STATUS_TONE[status], DOT);
}

function groupStats(g: Group): { errors: number; ms: number } {
	return {
		errors: g.calls.filter((c) => c.isError).length,
		ms: g.calls.reduce((sum, c) => sum + (c.durationMs ?? 0), 0),
	};
}

interface Cluster {
	name: string;
	calls: GroupedCall[];
}

// Consecutive same-tool calls merge into one cluster
function clustersOf(g: Group): Cluster[] {
	const out: Cluster[] = [];
	for (const call of g.calls) {
		const last = out[out.length - 1];
		if (last && last.name === call.name) last.calls.push(call);
		else out.push({ name: call.name, calls: [call] });
	}
	return out;
}

// `● Ran 2 commands (npm test · pnpm build) (1 failed)`
function clusterLine(cluster: Cluster, theme: ThemeLike): string {
	const [verb, noun] = VERBS[cluster.name] ?? ["Ran", "tool"];
	const failed = cluster.calls.filter((c) => c.isError).length;
	let line =
		`${dot(failed > 0 ? "error" : "success", theme)} ` +
		theme.fg("toolTitle", theme.bold(`${verb} ${plural(cluster.calls.length, noun)}`));
	const args = cluster.calls.map((c) => callArgs.get(c.id) ?? "").filter(Boolean);
	if (args.length > 0) {
		const shown = args.slice(0, INLINE_ARGS).map((a) => theme.fg("muted", cut(a, 40)));
		const more = args.length > INLINE_ARGS ? [theme.fg("dim", "…")] : [];
		line += theme.fg("dim", " (") + [...shown, ...more].join(theme.fg("dim", " · ")) + theme.fg("dim", ")");
	}
	if (failed > 0) line += theme.fg("error", ` (${failed} failed)`);
	return line;
}

// The verb-line block a finished group (2+ calls) folds to
function groupBlock(g: Group, theme: ThemeLike, context: RenderContext): Text {
	const clusters = clustersOf(g);
	const lines: string[] = [];

	let kept = clusters;
	if (clusters.length > KEPT_CLUSTERS) {
		const compressed = clusters.slice(0, clusters.length - KEPT_CLUSTERS);
		kept = clusters.slice(-KEPT_CLUSTERS);
		const counts = new Map<string, number>();
		let total = 0;
		for (const cluster of compressed) {
			total += cluster.calls.length;
			counts.set(cluster.name, (counts.get(cluster.name) ?? 0) + cluster.calls.length);
		}
		const parts = [...counts.entries()].map(([name, n]) => plural(n, NOUNS[name] ?? "action"));
		lines.push(theme.fg("muted", `… ${total} more action${total > 1 ? "s" : ""} (${parts.join(", ")}) …`));
	}
	for (const cluster of kept) lines.push(clusterLine(cluster, theme));

	// Total duration and the expansion hint close the block
	const { ms } = groupStats(g);
	let suffix = ms >= 1000 ? theme.fg("muted", ` · ${(ms / 1000).toFixed(1)}s`) : "";
	if (g.finalized) suffix += theme.fg("dim", ` ${context.keyHint("app.tools.expand", "to expand")}`);
	if (suffix && lines.length > 0) lines[lines.length - 1] += suffix;

	return new Text(lines.join("\n"), context.outputPad, 0);
}

// Visible width of a styled string: ANSI stripped, surrogate pairs count as 2.
function visibleWidth(s: string): number {
	const stripped = s.replace(ANSI_RE, "");
	let width = 0;
	for (const ch of stripped) width += ch.codePointAt(0)! > 0xffff ? 2 : 1;
	return width;
}

// The activity window: title line + left rail + auto-tailing live output.
// Rendered by the leader row while the group is in flight or holding.
// Pulls from shared state on every render, so streaming updates only need
// row invalidation.
class GroupWindow {
	constructor(
		private group: Group,
		private theme: ThemeLike,
	) {}
	invalidate() {}
	render(width: number): string[] {
		const w = Math.max(24, width);
		const fg = (c: string, t: string) => this.theme.fg(c, t);

		const inFlight = this.group.running + this.group.pending;
		let title: string;
		if (inFlight > 0) {
			title = dot("running", this.theme) + fg("muted", ` ${this.group.calls.length - inFlight} done, ${inFlight} running…`);
		} else {
			// Holding after completion: final stats
			const { errors, ms } = groupStats(this.group);
			title = dot(errors > 0 ? "error" : "success", this.theme);
			title += fg("muted", ` ${this.group.calls.length} action${this.group.calls.length > 1 ? "s" : ""}`);
			if (ms >= 1000) title += fg("muted", ` · ${(ms / 1000).toFixed(1)}s`);
			if (errors > 0) title += fg("error", ` · ${errors} failed`);
			else title += fg("success", " ✓");
		}

		const lines = [fg("border", `┌─ ${title} ${"─".repeat(Math.max(0, w - visibleWidth(title) - 5))}┐`)];

		for (const call of this.group.calls) {
			if (!partialTexts.has(call.id)) continue;
			const arg = callArgs.get(call.id) ?? "";
			const head = `${label(call.name)}${arg ? `(${arg})` : ""}`;
			lines.push(fg("border", "│ ") + dot(callStatus(call), this.theme) + " " + fg("toolTitle", cut(head, w - 6)));
			const raw = (partialTexts.get(call.id) ?? "").replace(ANSI_RE, "");
			const all = raw.trimEnd().split("\n");
			const tail = all.slice(-BODY_LINES);
			if (all.length > tail.length) {
				lines.push(fg("border", "│ ") + fg("muted", `${CONNECTOR} … +${all.length - tail.length} lines above`));
			}
			const max = w - 4;
			for (const line of tail) {
				lines.push(fg("border", "│ ") + fg("toolOutput", cut(line, max)));
			}
			if (raw.trim() === "") lines.push(fg("border", "│ ") + fg("muted", `${CONNECTOR} …`));
		}

		lines.push(fg("border", `└${"─".repeat(w - 2)}┘`));
		return lines;
	}
}

function shellBox(theme: ThemeLike, context: RenderContext, inner: any) {
	const bg = context.isPartial ? "toolPendingBg" : context.isError ? "toolErrorBg" : "toolSuccessBg";
	const box = new Box(context.outputPad, 0, (t: string) => theme.bg(bg, t));
	box.addChild(inner);
	return box;
}

// A verb line built from row context alone, without group state. Covers
// single calls and rows that predate a /reload, whose groups were cleared.
function contextVerbLine(name: string, args: any, context: RenderContext, theme: ThemeLike): Text {
	const status: CallStatus = context.isError
		? "error"
		: context.isPartial
			? "running"
			: context.durationMs !== undefined
				? "success"
				: "pending";
	const [verb, noun] = VERBS[name] ?? ["Ran", "tool"];
	const arg = callArg(name, args);
	let line = `${dot(status, theme)} ` + theme.fg("toolTitle", theme.bold(`${verb} 1 ${noun}`));
	if (arg) {
		line += theme.fg("dim", " (") + theme.fg("muted", cut(arg, 60)) + theme.fg("dim", ")");
	}
	if (context.durationMs !== undefined && context.durationMs >= 1000) {
		line += theme.fg("muted", ` · ${(context.durationMs / 1000).toFixed(1)}s`);
	}
	return new Text(line, context.outputPad, 0);
}

function safeCall(
	base: RenderCall | undefined,
	name: string,
	args: any,
	theme: ThemeLike,
	context: RenderContext,
) {
	try {
		// Strip lastComponent: built-in call renderers reuse their own Text via
		// .setText() and cannot handle the wrapped Box this renderer returns.
		return base?.(args, theme, { ...context, lastComponent: undefined }) ?? new Text("", 0, 0);
	} catch {
		// Built-in renderers may throw on a module-global theme that a reloaded
		// jiti instance never initialized; fall back to our own verb line.
		return contextVerbLine(name, args, context, theme);
	}
}

// History fallback: built-in call line is kept, result becomes one summary line.
function compactSummary(result: any, theme: ThemeLike, context: RenderContext) {
	if (context.isError) {
		return new Text(theme.fg("error", `${CONNECTOR} ✗ ${firstLine(resultText(result))}`), context.outputPad, 0);
	}
	const n = countLines(resultText(result));
	return new Text(n > 0 ? theme.fg("muted", `${CONNECTOR} ${n} lines`) : "", context.outputPad, 0);
}

function invalidateGroup(g: Group) {
	for (const call of g.calls) rowInvalidators.get(call.id)?.();
}

function refreshLeader(g: Group) {
	const leader = g.calls[0];
	const invalidate = leader && rowInvalidators.get(leader.id);
	invalidate?.();
}

// Wrap a built-in tool definition with group-aware rendering.
function grouped(definition: ToolDefinitionLike): ToolDefinitionLike {
	const baseCall = definition.renderCall;
	const baseResult = definition.renderResult;
	const toolName = String(definition.name ?? "");

	const stockCall = (args: any, theme: ThemeLike, context: RenderContext) =>
		shellBox(theme, context, safeCall(baseCall, toolName, args, theme, context));

	// Built-in result rendering with the row's own options: stock collapsed
	// preview, live partial, or expanded full view.
	const stockResult = (
		result: any,
		options: { expanded: boolean; isPartial: boolean },
		theme: ThemeLike,
		context: RenderContext,
	) => {
		const component = baseResult?.(result, options, theme, { ...context, lastComponent: undefined });
		return shellBox(theme, context, component ?? new Text("", 0, 0));
	};

	const renderCall = (args: any, theme: ThemeLike, context: RenderContext) => {
		// Register the row invalidator on every render, whatever the path:
		// rows are created before their group exists, and the leader row must
		// be reachable from event handlers from the first frame on.
		rowInvalidators.set(context.toolCallId, context.invalidate);

		const g = groups.get(context.toolCallId);
		if (!g) return contextVerbLine(toolName, args, context, theme);

		// Row-level expansion toggles (mouse click on the row, Ctrl+O) flip the
		// whole group. Edge detection keeps this transition-triggered only, so
		// it cannot loop.
		if (seen.get(context.toolCallId) !== context.expanded) {
			seen.set(context.toolCallId, context.expanded);
			g.expanded = context.expanded;
			invalidateGroup(g);
		}

		if (g.expanded) return stockCall(args, theme, context);

		const isLeader = g.calls[0]?.id === context.toolCallId;

		// From the third call on: window while in flight or holding, verb
		// lines once finalized
		if (g.calls.length >= 3) {
			if (isLeader) return g.finalized ? groupBlock(g, theme, context) : new GroupWindow(g, theme);
			return new Text("", 0, 0);
		}

		// A settled pair folds to verb lines
		if (g.calls.length === 2 && g.finalized) {
			return isLeader ? groupBlock(g, theme, context) : new Text("", 0, 0);
		}

		// Single call: Antigravity verb line; the stock result preview below
		// (live tail, "... (N earlier lines)", Took timer) is kept via renderResult
		if (g.calls.length === 1) {
			return contextVerbLine(toolName, args, context, theme);
		}

		// A pair still running: normal rendering
		return stockCall(args, theme, context);
	};

	const renderResult = (
		result: any,
		options: { expanded: boolean; isPartial: boolean },
		theme: ThemeLike,
		context: RenderContext,
	) => {
		const g = groups.get(context.toolCallId);
		if (!g) return compactSummary(result, theme, context);

		if (g.expanded) return stockResult(result, options, theme, context);

		const folded = g.finalized && g.calls.length >= 2;

		// Window mode: live output and results live inside the window
		if (g.calls.length >= 3 && !g.finalized) return new Text("", 0, 0);

		// Normal rendering for everything that is not folded
		if (!folded) return stockResult(result, options, theme, context);

		// Folded: only errors stay visible
		if (context.isError) {
			const wrap = new Container();
			wrap.addChild(stockCall(context.args, theme, context));
			wrap.addChild(new Text(theme.fg("error", `${CONNECTOR} ✗ ${firstLine(resultText(result))}`), context.outputPad, 0));
			return wrap;
		}
		return new Text("", 0, 0);
	};

	return { ...definition, renderShell: "self" as const, renderCall, renderResult };
}

export default function (pi: ExtensionAPI) {
	const cwd = process.cwd();

	// Grok-style thinking: keep only the last lines by default. The tail
	// slides while streaming because transforms re-run on every update.
	pi.registerMarkdownTransformer((markdown: string, ctx: any) => {
		if (ctx?.messageType !== "assistant-thinking" || thinkingFull) return markdown;
		const lines = markdown.trimEnd().split("\n");
		if (lines.length <= THINKING_TAIL_LINES) return markdown;
		const above = lines.length - THINKING_TAIL_LINES;
		const tail = lines.slice(-THINKING_TAIL_LINES).join("\n");
		return `*(+${above} lines · /think-full to expand)*\n\n${tail}`;
	});

	pi.registerCommand("think-full", {
		description: "Toggle full thinking text vs the 3-line sliding preview",
		handler: async (_args, ctx) => {
			thinkingFull = !thinkingFull;
			// Re-setting the label rebuilds every assistant message, which
			// re-runs the markdown transformer chain.
			ctx.ui.setHiddenThinkingLabel?.("○ Thinking…");
			ctx.ui.notify(`Thinking: ${thinkingFull ? "full text" : `${THINKING_TAIL_LINES}-line preview`}`);
		},
	});

	pi.registerTool(grouped(createBashToolDefinition(cwd)));
	pi.registerTool(grouped(createReadToolDefinition(cwd)));
	pi.registerTool(grouped(createEditToolDefinition(cwd)));
	pi.registerTool(grouped(createWriteToolDefinition(cwd)));
	pi.registerTool(grouped(createGrepToolDefinition(cwd)));
	pi.registerTool(grouped(createFindToolDefinition(cwd)));
	pi.registerTool(grouped(createLsToolDefinition(cwd)));

	function newGroup(): Group {
		return { calls: [], pending: 0, running: 0, ended: false, finalizing: false, finalized: false, expanded: false };
	}

	// Register a call into the current group, creating the group on first
	// sight. Always returns the group that CONTAINS the call: if the call was
	// pre-registered, that may be an older group than `current`.
	function register(toolCallId: string, name: string, args: any): Group {
		const existing = groups.get(toolCallId);
		if (existing) return existing;
		if (!current) current = newGroup();
		current.calls.push({ id: toolCallId, name, started: false, isError: false });
		groups.set(toolCallId, current);
		callArgs.set(toolCallId, callArg(name, args));
		// The third call turns the sequence into window mode
		if (current.calls.length === 3) {
			current.windowOpenedAt = Date.now();
			invalidateGroup(current);
		}
		return current;
	}

	// Fold the group to its verb lines. callArgs stay: the folded block
	// renders its inline arguments from them.
	function finalizeGroup(g: Group) {
		g.finalizing = false;
		g.finalized = true;
		g.expanded = false;
		for (const call of g.calls) {
			seen.set(call.id, false);
			partialTexts.delete(call.id);
		}
		if (uiCtx?.ui?.getToolsExpanded?.()) uiCtx.ui.setToolsExpanded(false);
		invalidateGroup(g);
	}

	// Close the current group. Window-mode groups hold for MIN_WINDOW_MS
	// before folding, so fast sequences still show something.
	function endGroup(ctx: any) {
		if (ctx) uiCtx = ctx;
		if (!current) return;
		const g = current;
		current = undefined;
		if (g.finalized || g.finalizing) return;
		g.ended = true;
		const delay =
			g.windowOpenedAt !== undefined ? Math.max(0, MIN_WINDOW_MS - (Date.now() - g.windowOpenedAt)) : 0;
		if (delay === 0) {
			finalizeGroup(g);
		} else {
			g.finalizing = true;
			refreshLeader(g); // window title switches to final stats
			setTimeout(() => finalizeGroup(g), delay);
		}
	}

	pi.on("session_start", async (_event, ctx) => {
		groups.clear();
		seen.clear();
		rowInvalidators.clear();
		callArgs.clear();
		partialTexts.clear();
		current = undefined;
		// Antigravity-style hollow-circle label for hidden thinking blocks
		ctx.ui.setHiddenThinkingLabel?.("○ Thinking…");
	});

	pi.on("agent_start", async (_event, ctx) => {
		uiCtx = ctx;
		endGroup(ctx);
	});

	// Pre-register calls while the assistant message is still streaming
	// arguments: the TUI creates the row at this point, before execution
	pi.on("message_update", async (event: any) => {
		const contents = event.message?.content;
		if (!Array.isArray(contents)) return;
		let touched = false;
		for (const c of contents) {
			if (c?.type !== "toolCall" || groups.has(c.id)) continue;
			const g = register(c.id, c.name, c.arguments);
			g.pending++;
			touched = true;
		}
		if (touched) refreshLeader(current!);
	});

	pi.on("tool_execution_start", async (event, ctx) => {
		uiCtx = ctx;
		if (event.parentToolCallId) return; // nested calls have no transcript row
		const g = register(event.toolCallId, event.toolName, event.args);
		if (g.ended) g.ended = false; // late activity reopens the group
		const call = g.calls.find((c) => c.id === event.toolCallId);
		if (call && !call.started) {
			call.started = true;
			g.pending = Math.max(0, g.pending - 1);
			g.running++;
		}
		partialTexts.set(event.toolCallId, "");
		refreshLeader(g);
	});

	pi.on("tool_execution_update", async (event) => {
		if (event.parentToolCallId) return;
		if (!partialTexts.has(event.toolCallId)) return;
		partialTexts.set(event.toolCallId, resultText(event.partialResult));
		const g = groups.get(event.toolCallId);
		if (g) refreshLeader(g);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		uiCtx = ctx;
		if (event.parentToolCallId) return;
		const g = groups.get(event.toolCallId);
		if (!g) return;
		const call = g.calls.find((c) => c.id === event.toolCallId);
		if (call) {
			call.durationMs = event.durationMs;
			call.isError = event.isError;
		}
		g.running = Math.max(0, g.running - 1);
		// Freeze the final output in place: the window keeps showing it while
		// holding, and drops it when the group folds.
		if (partialTexts.has(event.toolCallId)) {
			partialTexts.set(event.toolCallId, resultText(event.result));
		}
		refreshLeader(g);
	});

	// A message without tool calls ends the consecutive sequence. Tool calls
	// live in content blocks (ToolCall entries), not a top-level field.
	pi.on("message_end", async (event: any) => {
		const m = event.message;
		const hasTools =
			(Array.isArray(m?.toolCalls) && m.toolCalls.length > 0) ||
			(Array.isArray(m?.content) && m.content.some((c: any) => c?.type === "toolCall"));
		if (!hasTools) endGroup(undefined);
	});

	pi.on("agent_settled", async (_event, ctx) => {
		uiCtx = ctx;
		endGroup(ctx);
	});
}
