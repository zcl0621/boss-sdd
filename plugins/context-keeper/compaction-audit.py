"""Audit opencode 2.x compactions: did the summarizer see the whole history, or was the oldest part cut first?

Read-only. Usage: python3 -I compaction-audit.py [path/to/opencode.db] [--last N]

For each compaction it prints:
  before   = context size of the last model call before the compaction (input + cache read + cache write)
  seen     = what the summary request actually sent (same fields from the compaction record)
  seen/before well below ~0.85 means opencode flattened the history and dropped the oldest exchanges before
  summarizing (its retry path shrinks to 70% / 50% / 35% when the provider rejects the request as too long).
  summary  = length of the summary text in characters
  cjk      = share of CJK characters in the summary (opencode estimates tokens as chars / 4, which undercounts CJK)
"""
import datetime
import json
import os
import sqlite3
import sys

argv = sys.argv[1:]
last = 30
if "--last" in argv:
    i = argv.index("--last")
    last = int(argv[i + 1])
    del argv[i : i + 2]
db_path = argv[0] if argv else os.path.expanduser("~/.local/share/opencode/opencode.db")

db = sqlite3.connect(db_path)  # queries only read


def size(tokens):
    if not tokens:
        return 0
    cache = tokens.get("cache") or {}
    return tokens.get("input", 0) + cache.get("read", 0) + cache.get("write", 0)


def cjk_share(text):
    if not text:
        return 0.0
    cjk = sum(1 for ch in text if "一" <= ch <= "鿿" or "぀" <= ch <= "ヿ")
    return cjk / len(text)


rows = db.execute(
    "select m.session_id, m.seq, m.time_created, m.data, s.title, s.directory "
    "from session_message m join session_v2 s on s.id = m.session_id "
    "where m.type = 'compaction' order by m.time_created desc limit ?",
    (last,),
).fetchall()

print(f"{'when':<17} {'status':<9} {'reason':<7} {'before':>8} {'seen':>8} {'seen/before':>11} {'summary':>8} {'cjk':>5}  session")
for sid, seq, created, data, title, directory in reversed(rows):
    d = json.loads(data)
    prev = db.execute(
        "select data from session_message where session_id = ? and seq < ? and type = 'assistant' order by seq desc limit 1",
        (sid, seq),
    ).fetchone()
    before = size(json.loads(prev[0]).get("tokens")) if prev else 0
    seen = size(d.get("tokens"))
    ratio = f"{seen / before:.2f}" if before and seen else "-"
    summary = d.get("summary") or ""

    when = datetime.datetime.fromtimestamp(created / 1000).strftime("%m-%d %H:%M")
    print(
        f"{when:<17} {d.get('status', '?'):<9} {str(d.get('reason', '?')):<7} {before:>8} {seen:>8} {ratio:>11} "
        f"{len(summary):>8} {cjk_share(summary):>5.0%}  {sid[-8:]} {(title or '')[:30]} {directory}"
    )
