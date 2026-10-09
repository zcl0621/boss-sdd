# Structure & Clarity

Covers: clear/direct instructions, role prompting, separating instructions from data, specifying output format, and prefilling. These four techniques all address the same underlying question — does the prompt communicate the actual shape of the task, unambiguously, before Claude has to guess?

## Clarity & Directness

Claude has no context beyond what's literally written in the prompt. It isn't inferring your intent from tone or reading between the lines the way a longtime coworker would — it's working from the words on the page. The more precisely those words describe what you actually want, the closer the output lands to it.

The test worth applying, to your own draft or someone else's: **show the instruction to a colleague and have them follow it literally, with no outside context.** If they produce something other than what you wanted, or if they have to guess at a judgment call the instruction should have made for them, the instruction is confused, not Claude.

Two everyday failure patterns:

- **Under-specified verbs.** "Handle errors appropriately," "summarize as needed," "format nicely" — each of these hides a decision the author actually had in mind but didn't write down. Replace with the concrete rule: what specifically should happen, in what cases, in what format.
- **Missing explicit asks for the obvious-to-a-human thing.** If you don't want a "Here's your answer:" preamble, say so — Claude won't infer that from context alone. If you want a definitive pick rather than a hedged list of options, ask for exactly one, explicitly. Claude will happily hedge or preamble by default unless told not to; that isn't a flaw to work around indirectly, it's a preference to state directly.

When reviewing someone else's prompt, don't just say "this is vague" — point at the specific verb or clause and propose the concrete replacement. "Handle appropriately" reviewed as "unclear" is a non-finding; "handle appropriately → specify: on missing field X, do Y; on malformed input, respond with Z" is an actionable one.

## Role Prompting

Assigning Claude a role — "You are a senior security engineer reviewing this diff," "You are a patient, encouraging math tutor for a 10-year-old" — does real work beyond flavor text. It calibrates tone, the assumed audience, the register of explanation, and even measurably improves performance on tasks like logic or math by nudging Claude into a mode of reasoning associated with that role in its training data. The more specific the role's context, the more it can shape the response — "you are a cat" and "you are a cat addressing a crowd of skateboarders" produce meaningfully different outputs.

A role can live in the system prompt or in the first user turn — both work, though system-prompt placement is more durable across a long or multi-turn interaction.

**When it's not worth it:** a role is a tool for shaping *how* Claude approaches ambiguous or stylistically-loaded work. A narrow, mechanical, single-right-answer task (extract this field, run this transform) gets nothing from a persona — it's decoration that adds tokens without changing behavior. When reviewing a prompt, check whether an existing role is actually doing work (does removing it change the ideal output?) before recommending one be added or kept.

## Separating Instructions from Data (XML tags)

Any time a prompt has a variable slot — user-submitted text, a pasted document, a list of items to process, a conversation history — there is a real risk that Claude can't tell, once everything is substituted in, where your instructions end and the data begins. This isn't a hypothetical: unclear boundaries reliably cause two concrete failures:

1. Claude treats a stray phrase at the edge of the data (e.g., a salutation like "Yo Claude" at the top of an email the prompt asks Claude to rewrite) as part of the instructions or vice versa, and its output reflects the confusion (e.g., replying "Dear Claude" because it thought the greeting was addressed to it).
2. Claude misreads which part of a list is data versus a formatting note about the data, because to a human eye the line breaks make it obvious but the substituted text collapses that visual cue.

**The fix**: wrap every distinct block of substituted or pasted content in its own XML-style tags — `<document>...</document>`, `<email>...</email>`, `<question>...</question>`. Claude was specifically trained to recognize XML tags as structural/organizational signal (this is the one delimiter style worth defaulting to, over asterisks, markdown headers, or other separators, though Claude can work with those too). There's no special reserved tag vocabulary you need to match outside of tool-calling formats — name tags descriptively for what they contain.

This matters more, not less, as a prompt gets longer or has more moving pieces: multiple input variables each need their own tag, and if a prompt combines several distinct data blocks with instructions interleaved, each block should be independently and unambiguously delimited.

A adjacent, easy-to-miss point: **typos and sloppy phrasing in the instructions themselves degrade output quality**, because Claude is sensitive to the patterns in what it's given — it tends to match the register and care level of the prompt. A prompt worth reviewing for structure is also worth a pass for basic correctness.

## Output Formatting & Speaking for Claude

If anything downstream — a script, a parser, a human skimming for one section — needs to reliably extract part of Claude's response, ask for that part to be wrapped in tags (`<answer>...</answer>`), or ask for a specific format outright (JSON, a markdown table, a fixed template with named sections). Don't rely on an example alone to imply the format; state it.

**Prefilling** (API-level only — start the `assistant` turn with the opening tag or bracket you want, e.g. seeding `{` to push toward JSON output, or `<response>` to skip past any preamble) is a strong lever when you have direct control over the message array, because it removes Claude's freedom to preface the answer with anything else. This technique doesn't apply inside a system prompt for an interactive agent harness (Claude Code, a chat UI) where you don't control what the assistant turn starts with — it's relevant when writing prompts intended for direct API calls or scripted pipelines.

If calling the API directly, the closing tag can also be passed as a `stop_sequence`, so generation halts the moment the wanted content is complete — useful for cutting cost and latency on the concluding remarks Claude would otherwise add after the real answer.
