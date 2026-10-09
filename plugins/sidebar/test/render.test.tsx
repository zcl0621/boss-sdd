/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { RGBA } from "@opentui/core"
import { testRender } from "@opentui/solid"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"

const home = mkdtempSync(path.join(tmpdir(), "sidebar-"))
process.env.XDG_STATE_HOME = home
process.env.OPENCODE_TODO_DIR = path.join(home, "todos")
const sid = "ses_main"
const put = (dir: string, data: unknown) => (mkdirSync(dir, { recursive: true }), writeFileSync(path.join(dir, `${sid}.json`), JSON.stringify(data)))
put(path.join(home, "opencode-context-keeper"), { meter: { used: 160000, window: 262144, level: 50, cleared: 18, clearedChars: 96000, at: Date.now() } })
put(path.join(home, "opencode-pin"), { pins: Object.fromEntries([1, 2, 3, 4, 5].map((i) => [`k${i}`, { value: "v", at: Date.now() }])) })
put(path.join(home, "opencode-goal"), { goal: { objective: "Finish plan docs/plans/2026-10-09-storage.md: T1-T6, gates green, branch ready to merge", status: "active", continues: 3, at: Date.now() }, children: { ses_child: "running" } })
put(process.env.OPENCODE_TODO_DIR!, [
  { id: "1", content: "T1 parser", status: "completed" },
  { id: "2", content: "T2 storage layer (implementer)", status: "in_progress" },
  { id: "3", content: "T3 api", status: "in_progress" },
  { id: "4", content: "T4 review + gates", status: "pending" },
])
const { Sidebar } = await import("../tui")

const c = (r: number, g: number, b: number) => RGBA.fromInts(r, g, b)
const fb = { base: c(200, 200, 200) }
const context: any = {
  location: { directory: "/repo" },
  theme: {
    text: { base: c(230, 230, 230), muted: c(120, 120, 120), feedback: { success: fb, warning: fb, error: fb, info: fb } },
    diff: { text: { added: c(0, 200, 0), removed: c(200, 0, 0) } },
  },
  ui: { tabs: { focus: () => {} }, toast: { show: () => {} } },
  client: {
    vcs: {
      get: async () => ({ data: { branch: { current: "plan/t2-storage", default: "main" } } }),
      status: async () => ({ data: [{ file: "src/storage/store.ts", additions: 40, deletions: 3, status: "modified" }] }),
    },
  },
  data: {
    listen: () => () => {},
    session: {
      get: (id: string) => ({ id, directory: "/repo", location: { directory: "/repo" }, model: { id: "k3", providerID: "kimi" } }),
      root: () => sid,
      cost: () => 0.42,
      status: (id: string) => (id === "ses_child" ? "running" : "idle"),
      list: () => [{ id: "ses_child", parentID: sid, title: "T2 storage layer", time: { created: 1 }, model: { id: "k3", providerID: "kimi" } }],
      message: {
        list: (id: string) =>
          id === sid
            ? [
                { type: "compaction", status: "completed" },
                { type: "compaction", status: "completed" },
                { type: "assistant", model: { id: "k3", providerID: "kimi" }, tokens: { input: 8000, output: 1500, reasoning: 500, cache: { read: 140000, write: 2000 } } },
              ]
            : [],
      },
    },
    location: {
      default: () => ({ directory: "/repo" }),
      model: { list: () => [{ id: "k3", providerID: "kimi", limit: { context: 262144 } }] },
      provider: { list: () => [] },
    },
  },
}

test("sidebar renders all sections", async () => {
  const app = await testRender(() => (<box width={36} flexDirection="column"><Sidebar context={context} sessionID={sid} /></box>), { width: 36, height: 48 })
  await new Promise((r) => setTimeout(r, 50))
  await app.renderOnce()
  const frame = app.captureCharFrame()
  console.log(frame)
  expect(frame).toContain("Context")
  expect(frame).toContain("Goal")
  expect(frame).toContain("Todo")
  expect(frame).toContain("5 pins")
  app.renderer.destroy()
})
