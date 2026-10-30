# `/caveman` — the communication-style skill every agent used

`caveman` is a Claude Code **skill** (a packaged instruction file loaded with
the Skill tool or typed as `/caveman <level>`). Every agent prompt began with:

> FIRST ACTION: call the Skill tool with skill "caveman" and args "ultra".

## What it does

It makes the agent's chat output and final report terse: no filler, no
pleasantries, fragments allowed, while keeping every technical fact, number,
path, command and error string exact. The `ultra` level is the most compressed
English mode.

## Why we used it

- **Lead throughput.** With about twenty agents reporting back, the lead had to
  read every final report and every diff. Short reports meant the lead read all
  of them in full instead of skimming.
- **Usage budget.** Fewer output tokens per agent meant more agent runs within
  our usage limit over a two-day event.
- **Facts survive.** The skill forbids dropping negations, numbers, units,
  code or error text, and forbids invented abbreviations, so compression never
  changed the meaning of a finding.

## Where it did NOT apply

The skill's own boundary rule, repeated in every brief: anything persisted for
other people is written in normal professional English. That covers the audit
write-ups in `docs/audit/`, these `docs/ai/` files, code comments and commit
messages. Only the agent-to-lead chat was compressed.

## The skill file

[`caveman.SKILL.md`](caveman.SKILL.md) is an unmodified copy of the skill file
as installed on the lead machine. It contains no project or personal data.
