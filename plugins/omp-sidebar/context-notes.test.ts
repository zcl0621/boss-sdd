import { expect, test } from "bun:test";
import { getContextNotes, MAX_CONTEXT_NOTES_BYTES } from "./context-notes";

const notes = (id: string, data: unknown) =>
  ({ type: "custom", customType: "experimental_context_notes", id, data }) as never;
const reset = (id: string) => ({ type: "reset_boundary", id }) as never;

test("latest notes entry wins", () => {
  const found = getContextNotes([
    notes("a", { version: 1, text: "old" }),
    notes("b", { version: 1, text: "new" }),
  ]);
  expect(found?.text).toBe("new");
});

test("entries before the latest reset_boundary are hidden", () => {
  expect(getContextNotes([notes("a", { version: 1, text: "old" }), reset("r")])).toBeUndefined();
  expect(
    getContextNotes([
      notes("a", { version: 1, text: "old" }),
      reset("r"),
      notes("b", { version: 1, text: "after" }),
    ])?.text,
  ).toBe("after");
});

test("invalid entries are skipped and never throw", () => {
  const over = "x".repeat(MAX_CONTEXT_NOTES_BYTES + 1);
  const multibyte = "é".repeat(MAX_CONTEXT_NOTES_BYTES / 2 + 1);
  for (const data of [
    { version: 2, text: "x" },
    { version: 1, text: 5 },
    { version: 1 },
    { version: 1, text: over },
    { version: 1, text: multibyte },
    null,
    "str",
  ])
    expect(getContextNotes([notes("a", data)])).toBeUndefined();
  expect(getContextNotes([notes("a", { version: 1, text: "x".repeat(MAX_CONTEXT_NOTES_BYTES) })])).toBeDefined();
});

test("an invalid later entry is skipped so an earlier valid one still shows", () => {
  expect(
    getContextNotes([
      notes("a", { version: 1, text: "good" }),
      notes("b", { version: 2, text: "bad" }),
    ])?.text,
  ).toBe("good");
});

test("data with keys other than exactly version and text is invalid", () => {
  expect(getContextNotes([notes("a", { version: 1, text: "x", extra: 1 })])).toBeUndefined();
  expect(
    getContextNotes([
      notes("a", { version: 1, text: "good" }),
      notes("b", { version: 1, text: "x", extra: 1 }),
    ])?.text,
  ).toBe("good");
});

test("an invalid entry after a reset_boundary does not reveal a valid one before it", () => {
  expect(
    getContextNotes([
      notes("a", { version: 1, text: "good" }),
      reset("r"),
      notes("b", { version: 2, text: "bad" }),
    ]),
  ).toBeUndefined();
});
