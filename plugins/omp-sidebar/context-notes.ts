// Mirrors omp's notebook reader in
// packages/coding-agent/src/session/context-notes.ts (`getContextNotes`,
// `isContextNotesData`). Replicated, not imported, so the sidebar does not
// depend on an omp internal module path.
import type { SessionEntry } from "@oh-my-pi/pi-coding-agent";

export const CONTEXT_NOTES_ENTRY_TYPE = "experimental_context_notes";
export const MAX_CONTEXT_NOTES_BYTES = 16_384;

export interface ContextNotesRevision {
  text: string;
  entryId: string;
}

// Same as omp's isContextNotesData: exactly the keys `version` and `text`
// (keys.length === 2), version 1, string text, at most 16 384 UTF-8 bytes.
function isContextNotesData(data: unknown): data is { version: 1; text: string } {
  if (data === null || typeof data !== "object") return false;
  const candidate = data as Record<string, unknown>;
  const keys = Object.keys(candidate);
  return (
    keys.length === 2 &&
    keys.includes("version") &&
    keys.includes("text") &&
    candidate.version === 1 &&
    typeof candidate.text === "string" &&
    Buffer.byteLength(candidate.text, "utf8") <= MAX_CONTEXT_NOTES_BYTES
  );
}

/**
 * Latest valid notebook revision after the most recent `reset_boundary`.
 * Invalid entries are skipped, as in omp, so they cannot mask an earlier valid one.
 */
export function getContextNotes(entries: readonly SessionEntry[]): ContextNotesRevision | undefined {
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (entry.type === "reset_boundary") return undefined;
    if (entry.type !== "custom" || entry.customType !== CONTEXT_NOTES_ENTRY_TYPE) continue;
    if (!isContextNotesData(entry.data)) continue;
    return { text: entry.data.text, entryId: entry.id };
  }
  return undefined;
}
