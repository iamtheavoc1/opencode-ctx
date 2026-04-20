// Compressed tool descriptions for opencode's built-in tools.
//
// Upstream descriptions live in packages/opencode/src/tool/*.txt and total
// ~35.6KB. We retain parameter-level behavior by leaving `parameters` alone
// and replacing only `description`. Compression preserves all behavioral
// contracts the model needs: call semantics, required-vs-optional args,
// safety rules, and tool-selection guidance.
//
// Dropped:
//   - Tutorial-style examples showing full conversations with <reasoning> blocks
//   - Redundant "when to use / when not to use" tables that duplicate the text
//   - Git/PR walkthroughs for bash (the model knows git; OpenCode's AGENTS.md
//     carries project-specific git policy separately)
//
// Preserved:
//   - Every distinct behavioral rule (parallel execution, workdir, atomic edits,
//     file-path absolute requirement, `cd` avoidance, tool-preference policy)
//   - Safety constraints (git force-push, --no-verify, --amend rules)
//   - Parameter names and semantics
//
// Determinism: outputs are pure string constants. Same input always produces
// the same override. This is essential because opencode's prefix cache (via
// @ai-sdk/anthropic's cache_control) reuses the tool array across turns.

export const TOOL_DESCRIPTION_OVERRIDES: Record<string, string> = {
  bash: `Execute bash commands in a persistent shell session.

Behavior:
- Runs in current working directory by default. Use the \`workdir\` parameter (absolute path) to change directory; never \`cd X && cmd\`.
- Quote paths containing spaces: \`rm "path with spaces/file.txt"\`.
- Default timeout 120000ms; override via \`timeout\` param (milliseconds).
- Output truncated past ~2000 lines; the full output is written to a file that Read/Grep can target precisely. Do NOT use head/tail to pre-truncate.
- Provide a concise \`description\` (3-10 words) for each call.

Policy:
- Prefer specialized tools over bash: Read (not cat/head/tail), Edit (not sed/awk), Write (not echo/heredoc), Grep (not grep/rg), Glob (not find/ls).
- Never use echo/printf to communicate with the user; output text directly in responses.
- Parallelize independent commands via multiple tool calls in one message. Use \`;\` for sequential commands whose failure shouldn't block later ones. Never use newlines to separate commands.

Git safety (only when user explicitly requests commits/PRs):
- Never update git config, force-push to main/master, skip hooks (--no-verify), or use interactive flags (-i).
- Never \`--amend\` after push. Fix failed/rejected commits with a new commit, not amend.
- Warn the user if they request force-push to main/master.
- Never commit secrets (.env, credentials.json). Warn if user requests them.
- If no changes exist, do not create empty commits.
- Use \`gh\` for all GitHub work (issues, PRs, releases). Commit message should explain WHY, not what.`,

  todowrite: `Create and manage a structured task list for the current session.

Use proactively when:
- Task has 3+ distinct steps or non-trivial complexity
- User provides multiple items (comma-separated or numbered)
- Capturing new user requirements that need tracking
- User explicitly requests a todo list

Do NOT use for:
- Single trivial tasks or conversational/informational requests
- Tasks completable in fewer than 3 trivial steps

States: pending, in_progress, completed, cancelled.

Rules:
- Mark a todo in_progress BEFORE starting work on it; keep only ONE in_progress at a time.
- Mark completed IMMEDIATELY after finishing; never batch completions.
- Update status in real time; cancel todos that become irrelevant.
- Break complex work into specific, actionable items with clear names.
- Add new follow-up tasks as they emerge during execution.

Being proactive with todos demonstrates thoroughness and ensures no requirements are missed.`,

  task: `Launch a subagent to handle complex multi-step tasks autonomously.

Required: \`subagent_type\` parameter selects which agent to invoke.

Use when:
- Executing custom slash commands (pass the command as the entire prompt, e.g. \`/check-file path\`).
- The task matches an agent's description; especially when the description mentions "proactively".
- Codebase-wide exploration or searches that would otherwise consume significant context.

Do NOT use when:
- You know the file path → use Read or Glob directly.
- Searching within 1-3 specific files → use Read or Grep directly.
- Looking up a specific class/function definition → use Glob.

Behavior:
- Launch multiple agents in parallel via a single message with multiple Task calls.
- The agent returns a single final message; the user does not see intermediate work.
- Fresh context per invocation unless you pass \`task_id\` to resume a prior subagent session (preserves its prior messages and tool outputs).
- Provide a highly detailed task description and specify exactly what the agent should return.
- State explicitly whether you want code written or just research. Tell the agent how to verify its work (tests, commands).
- Trust the agent's outputs; summarize them for the user in your follow-up message.`,

  multiedit: `Apply multiple edits to a single file atomically. Prefer over Edit when making more than one change to the same file.

Workflow:
1. Read the file first to understand contents and exact whitespace.
2. Pass: \`file_path\` (absolute path) and \`edits\` array of { oldString, newString, replaceAll? }.

Semantics:
- Edits apply sequentially; each operates on the result of the previous.
- Atomic: all succeed or none apply.
- \`oldString\` must match file contents exactly, including all whitespace and indentation.
- \`oldString\` and \`newString\` must differ.
- Plan ordering so earlier edits don't invalidate later \`oldString\` matches.
- \`replaceAll\` (default false) replaces every occurrence; useful for renames.

To create a new file: first edit has empty \`oldString\` + full contents as \`newString\`; subsequent edits operate on that content.

Constraints:
- Always absolute paths (starting with /).
- Leave code idiomatic and never in a broken state.
- No emojis unless the user explicitly requested them.`,

  read: `Read a file or directory from the local filesystem. Errors if the path does not exist.

- \`filePath\` must be absolute.
- Default: up to 2000 lines from the start. Use \`offset\` (1-indexed line number) to read later sections; \`limit\` to cap lines.
- Lines are returned prefixed \`<n>: <content>\`. Never include the line-number prefix inside Edit/MultiEdit \`oldString\` matches.
- Lines longer than 2000 characters are truncated.
- Directories return entries one per line (subdirs have trailing \`/\`).
- Parallelize reads of multiple known files.
- Avoid tiny repeated slices; prefer a larger window over many 30-line chunks.
- For large files, use Grep first to locate content. Use Glob to resolve ambiguous paths.
- Reads image and PDF files and returns them as attachments.`,

  write: `Write a file to the local filesystem. Overwrites any existing file at the path.

- \`filePath\` must be absolute.
- If the file exists, you MUST Read it first; the tool errors otherwise.
- Prefer editing existing files over creating new ones.
- Never proactively create docs/README/*.md unless the user requests them.
- No emojis unless the user explicitly requested them.`,

  edit: `Exact string replacement in a file.

- Read the file at least once in the conversation before editing; tool errors otherwise.
- \`filePath\` must be absolute.
- \`oldString\` must match file contents exactly - including all whitespace and indentation. When copying from Read output, exclude the \`<n>: \` line-number prefix.
- \`oldString\` != \`newString\`.
- Fails if \`oldString\` is not found, or matches more than once. Fix by extending \`oldString\` with surrounding context, or set \`replaceAll: true\` for renames / global substitutions.
- Prefer editing existing files over creating new ones. No emojis unless requested.`,

  grep: `Fast regex search across file contents.

- Returns file paths + line numbers (sorted by mtime) for files containing matches.
- Supports full regex syntax. Filter files with \`include\` (e.g. \`*.ts\`, \`*.{js,tsx}\`).
- To count matches or get detailed match context, use Bash with \`rg\` directly - do NOT call \`grep\`.
- For open-ended multi-round searches, delegate to a Task subagent instead of iterating here.`,

  glob: `Fast file-name pattern matching.

- Accepts glob patterns like \`**/*.js\` or \`src/**/*.ts\`.
- Returns matching paths sorted by mtime.
- Parallelize multiple Glob calls when speculating across patterns.
- For open-ended multi-round searches, delegate to a Task subagent instead.`,

  webfetch: `Fetch and convert URL content.

- \`url\` must be fully-formed; HTTP is auto-upgraded to HTTPS.
- \`format\` options: "markdown" (default), "text", "html".
- Read-only; does not modify files. Large results may be summarized.
- Prefer any more-specialized web tool (e.g. a richer MCP) if one is available.`,

  websearch: `Real-time web search via Exa AI. Returns content from the most relevant websites.

- Crawl modes: \`fallback\` (backup when cache is unavailable) or \`preferred\` (prioritize live crawl).
- Search types: \`auto\` (balanced), \`fast\`, \`deep\`.
- Supports domain filtering and configurable context length.
- Include the current year in recency queries, e.g. "AI news 2026" not "2025" when the current year is 2026.`,

  lsp: `Language Server Protocol queries for code intelligence.

Operations: goToDefinition, findReferences, hover, documentSymbol, workspaceSymbol, goToImplementation, prepareCallHierarchy, incomingCalls, outgoingCalls.

All ops require: \`filePath\`, \`line\` (1-based), \`character\` (1-based).

Errors if no LSP server is configured for the file type.`,

  codesearch: `Exa Code API search for programming context.

- Returns code examples, docs, and API references for libraries/SDKs/APIs.
- \`tokens\` configurable 1000-50000; default 5000 balances specificity vs breadth. Use lower for focused questions, higher for broad documentation.
- Good for framework/library/API queries; e.g. "React useState examples", "Express middleware".`,

  session_list: `List OpenCode sessions with optional filtering.

Args: \`limit\` (optional), \`from_date\`/\`to_date\` (optional ISO 8601), \`project_path\` (optional, defaults to cwd).

Returns a table with session IDs, message counts, date ranges, and agents used.`,

  session_read: `Read messages and history from an OpenCode session.

Args: \`session_id\` (required), optional \`include_todos\`, \`include_transcript\`, \`limit\`.

Returns messages formatted with role, timestamp, and content. Use \`include_transcript\` to get the full tool log.`,

  session_search: `Full-text search across OpenCode session messages.

Args: \`query\` (required), optional \`session_id\` (restrict to one), \`case_sensitive\`, \`limit\` (default 20).

Returns matching excerpts with context, one per match.`,

  session_info: `Get metadata for an OpenCode session.

Args: \`session_id\` (required).

Returns message count, date range, duration, agents used, and whether todos/transcript are available.`,

  call_omo_agent: `Invoke a specialized oh-my-openagent subagent. Prefer \`task\` unless the request specifically names call_omo_agent.

Required: \`agent\` (agent name), \`prompt\` (detailed request).

Optional: \`load_skills\` (array of skill names to inject), \`session_id\` (continue an existing agent session), \`run_in_background\`.

Rules:
- Always include load_skills=[] or matching skill names.
- For follow-up on a prior call, resume with session_id instead of starting fresh.
- Use run_in_background=true only for parallel exploration (5+ independent queries).`,

  look_at: `Extract basic info from media (PDFs, images, diagrams) when a quick summary suffices.

Args: \`goal\` (what info to extract), plus one of \`file_path\` (absolute) or \`image_data\` (base64). 

For visual precision, aesthetic evaluation, or exact accuracy, use the Read tool instead.`,

  skill: `Load a specialized skill whose description matches the current task. Skills are listed in the <available_skills> block of your system prompt - use the exact \`name\`. Optional \`user_message\` passes arguments (e.g. for slash commands). Injects the skill's instructions into conversation; skill content appears inside a <skill_content name="..."> block.`,

  ast_grep_search: `AST-aware code search across the filesystem. Supports 25 languages.

Args: \`pattern\` (complete AST node, using \`$VAR\` for single node and \`$$$\` for multiple), \`lang\` (required), \`paths\` (default \`['.']\`), \`globs\`, \`context\`.

Pattern must be valid code for the chosen language (e.g. for functions include params and body: \`function $NAME($$$) { $$$ }\`).`,

  question: `Ask the user a question during execution when you need preferences, clarifications, decisions, or direction.

Args: \`questions\` (array of { question, header, options, multiple? }).

Rules:
- With default \`custom: true\`, a "Type your own answer" option is auto-added - do NOT include "Other" or catch-all options.
- If recommending an option, place it first and suffix the label with "(Recommended)".
- Set \`multiple: true\` to allow multiple selections.
- Answers return as arrays of labels.`,
}

export * as ToolOverrides from "./tool-overrides"
