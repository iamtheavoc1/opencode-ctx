import assert from "node:assert/strict"

process.env.OPENCODE_CTX_REASONING = "1"
process.env.OPENCODE_CTX_REASONING_KEEP = "1"
process.env.OPENCODE_CTX_FILES = "1"
process.env.OPENCODE_CTX_FILES_KEEP = "1"

const { trimMessageHistory } = await import("../src/messages-trim")

const messages = [
  {
    info: { role: "assistant" },
    parts: [{ type: "reasoning", text: "old hidden reasoning that should be omitted" }],
  },
  {
    info: { role: "assistant" },
    parts: [
      { type: "text", text: "visible assistant reply" },
      { type: "reasoning", text: "older mixed reasoning that should disappear" },
    ],
  },
  {
    info: { role: "user" },
    parts: [{ type: "file", mime: "image/png", filename: "old.png", url: "data:image/png;base64,AAAA" }],
  },
  {
    info: { role: "assistant" },
    parts: [
      { type: "text", text: "recent assistant reply" },
      { type: "reasoning", text: "recent reasoning stays intact" },
    ],
  },
  {
    info: { role: "user" },
    parts: [{ type: "file", mime: "image/png", filename: "recent.png", url: "data:image/png;base64,BBBB" }],
  },
]

const result = trimMessageHistory(messages)

assert.equal(messages.length, 4)
assert.equal(messages[0].parts.length, 1)
assert.equal(messages[0].parts[0]?.type, "text")
assert.equal(String(messages[0].parts[0]?.text ?? ""), "visible assistant reply")
assert.equal(messages[1].parts[0]?.type, "text")
assert.match(String(messages[1].parts[0]?.text ?? ""), /older attachment omitted/)
assert.equal(messages[2].parts.length, 2)
assert.equal(messages[2].parts[1]?.type, "reasoning")
assert.equal(messages[3].parts[0]?.type, "file")
assert.equal(result.reasoningTrimmed, 2)
assert.equal(result.filesTrimmed, 1)
assert.equal(result.emptyMessagesPruned, 1)

console.log(JSON.stringify({
  status: "ok",
  reasoningTrimmed: result.reasoningTrimmed,
  filesTrimmed: result.filesTrimmed,
  reasoningSaved: result.reasoningSaved,
  filesSaved: result.filesSaved,
  emptyMessagesPruned: result.emptyMessagesPruned,
}))
