// Lossless tool-output cleaning applied at tool.execute.after.
//
// Fires BEFORE the tool result enters the transcript AND before it is passed
// back to the model for the current turn. So every transform here MUST be
// lossless - same semantic content, fewer bytes. No truncation, no
// summarization, no aging policy.
//
// Safe transforms only:
//   - ANSI escape codes (terminal colors, cursor movement) - pure visual noise
//   - Carriage returns from progress bars / spinners (\r refreshes) - keep final state
//   - Consecutive blank-line runs (cap at 2) - preserves structural separation
//   - Trailing whitespace on lines - semantically equivalent
//
// Intentionally NOT stripped:
//   - Leading whitespace (indentation - semantically meaningful in code)
//   - Line numbers (used for Edit oldString matching)
//   - Any single newline (structural)
//   - Tool-specific structured output (JSON, diffs, grep results)
//
// Determinism: pure function of input string. Cache-safe.

const ANSI_RE = /\x1B\[[0-9;?]*[a-zA-Z]/g
const CR_PROGRESS_RE = /[^\n]*\r(?!\n)/g
const TRAILING_WS_RE = /[ \t]+$/gm
const MULTI_BLANK_RE = /\n{4,}/g

export function cleanToolOutput(text: string): string {
  if (!text || text.length < 32) return text
  const stripped = text
    .replace(ANSI_RE, "")
    .replace(CR_PROGRESS_RE, "")
    .replace(TRAILING_WS_RE, "")
    .replace(MULTI_BLANK_RE, "\n\n\n")
  return stripped
}

export * as ToolOutputClean from "./tool-output-clean"
