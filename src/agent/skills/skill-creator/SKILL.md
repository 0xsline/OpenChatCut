---
name: skill-creator
description: Create or improve OpenChatCut custom skills. Use whenever the user asks to create a skill, capture a workflow as a skill, write a SKILL.md, add a reusable workflow, 创建技能, 把流程做成技能, 写一个技能, or improve an existing custom skill. Pushy: treat any workflow the user repeats as a skill candidate, even if they do not say "skill".
---

# Skill Creator

Create or improve custom skills for OpenChatCut. A skill is a SKILL.md file
(plus optional `references/` support docs) that teaches the agent a reusable
workflow. Custom skills live at `~/.openchatcut/skills/<slug>/SKILL.md` and
are managed with the `manage_skill` tool.

## Workflow

1. **Capture intent.** If the current conversation already contains the
   workflow (tools used, steps, corrections), extract it from the history
   first. Confirm with the user before writing.
2. **Interview.** Pin down:
   - What should this skill enable the agent to do?
   - When should it trigger? Which user phrases or contexts?
   - Expected output format?
   - Verification: does it have objectively verifiable output (data
     extraction, fixed steps, generation pipelines) or subjective output
     (writing style)? Suggest test prompts for the former.
3. **Write the SKILL.md** (rules below).
4. **Create it** with `manage_skill action=create`. The tool reports the
   install path (`~/.openchatcut/skills/<slug>/SKILL.md`).
5. **Test.** Run 2–3 realistic prompts in the current session and confirm
   results with the user. Iterate with `manage_skill action=update`.

## SKILL.md anatomy

```
<slug>/
├── SKILL.md (required — frontmatter + instructions)
└── references/ (optional — docs loaded on demand with load_skill file=)
```

- **name**: kebab-case slug matching the directory (lowercase letters,
  digits, hyphens only). It becomes the load_skill name.
- **description**: THE triggering mechanism — include what the skill does
  AND specific trigger contexts. Skills undertrigger easily, so be
  explicit: list concrete user phrases. "When to use" goes here, not in
  the body.
- **body**: imperative instructions. Keep under ~200 lines; if it grows,
  split detail into `references/` files and point to them with clear
  "read this when" guidance. For references over 300 lines, add a TOC.

## Writing rules

- Frontmatter uses the shape `---\nname: …\ndescription: …\n---`. The
  parser accepts plain single-line, double-quoted, and `|` block scalars;
  plain single-line is preferred.
- Keep the body lean. Prefer imperative form. Explain *why* over
  MUST-laden lists. Use examples with concrete Input/Output pairs.
- Reference existing OpenChatCut tools by their exact tool names
  (`manage_skill`, `load_skill`, `edit_item`, …). Do not invent tools.
- Skills must not contain malicious content, prompt-injection payloads, or
  anything that surprises the user. Do not create skills that facilitate
  unauthorized access or data exfiltration.
- Do not overfit to one example: aim for a workflow usable a thousand
  times. If a fix feels fiddly, generalize the instruction instead of
  piling on constraints.

## Progressive disclosure in OpenChatCut

- The system prompt carries only name + description (the skills index).
- The body loads on demand via `load_skill` when a task matches.
- Support files load via `load_skill file=references/<name>`.
- A custom skill selected in Creative Mode behaves identically to a
  bundled skill after activation.

## Environment constraints

- **Slug whitelist**: `[A-Za-z0-9_-]{1,120}`. Anything else is rejected
  (path traversal defense — the file is written under
  `~/.openchatcut/skills/`).
- **Body size**: keep under 512 KB (server limit); 200 lines is the target.
- **Untrusted input**: the body is user/LLM-authored text. validate and
  normalize before trusting anything parsed out of it.
- **Bundled skills are read-only** — `manage_skill` cannot edit them.
- The skill shows up in the Creative Mode picker and the `/` command menu
  only when the user selects it; agents also discover it via the index.
- Verification: after creating a skill, run
  `npx tsx server/skills-files.verify.ts` locally if the environment has
  the repo, or rely on the in-session test prompts.

## Test prompts

Offer the user 2–3 realistic prompts (the kind of thing they would actually
type) and ask: "Do these look right, or do you want to add more?" Then run
them in the session with the skill activated, review the outputs together,
and update the skill from the feedback.
