// Custom compaction prompt for opencode sessions.
//
// The default prompt (see packages/opencode/src/session/compaction.ts:277-299)
// produces discursive summaries that preserve narrative but waste tokens on
// meta-commentary and duplicated context. This replacement is denser and
// structured for maximum signal-per-token: the next agent needs exact paths,
// decisions made, and current state, not a retelling of the conversation.
//
// Design principles:
//   - Fixed section set so the next agent knows where to look
//   - Explicit "be dense" and "drop verbose tool I/O" guidance
//   - Preserve exact quoted user directives (they are the ground truth)
//   - Omit empty sections (reduces post-compaction token load)

export const CUSTOM_COMPACTION_PROMPT = `Summarize this conversation so the next agent can continue seamlessly. Use the exact template below. Omit sections that have no content rather than writing "N/A".

## Goal
[User's primary objective in one sentence, plus any sub-goals or constraints the user explicitly stated]

## Status
[Current phase: what is in-flight, blocked, or done. One bullet per active thread]

## Key Decisions
[Technical choices made, tradeoffs accepted, and paths rejected with the reason. Include chosen libraries, architectural patterns, and safety constraints]

## Discoveries
[Non-obvious findings the next agent needs: bug root causes, hidden constraints, API quirks, surprising file structures, versions of tools/libraries]

## Files Touched
[List exact absolute paths. For each, say what changed and why. Group directories only when every file inside is relevant]

## Next Steps
[Ordered concrete actions remaining. If all work is complete, say "complete - awaiting user" and stop]

## Open Questions
[Ambiguities needing user clarification, or confirmations blocking progress. Skip if none]

## Verbatim User Directives
[Quote exact user sentences that constrain the work. Use quotes and preserve casing/profanity]

Rules:
- Be dense. Drop verbose tool output, duplicate context, and meta-narration about what you did.
- Preserve: exact file paths, command names, error messages, library versions, and quoted user directives.
- Skip: "I then did X and then Y and then Z" narration; prefer "X done, Y in progress, Z pending".
- No markdown emphasis (bold/italic). Plain text and list markers only.`

export * as CompactionPrompt from "./compaction-prompt"
