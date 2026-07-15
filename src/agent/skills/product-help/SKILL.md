---
name: product-help
description: |
  ChatCut product knowledge — UI layout, features, credits, subscription plans, pricing, and billing. Use when the user asks about the product interface, how to use a feature, where to find something, credit costs, or plan / upgrade questions, or needs GUI guidance for something the agent cannot do directly. Also use as fallback when a task fails and the user needs to complete it manually in the UI. NOT for live project-state queries ("where are my folders?", "what's on my timeline?", "where is clip X?") — those are answered by `read_project`, not by this skill.
user-invocable: false
---

# ChatCut Product Help

Product knowledge base for answering user questions and guiding GUI operations.

## When to Use

- User asks about the product, a feature, or how something works
- User asks about credits, pricing, or subscription plans
- User needs to perform a GUI action that the agent cannot do directly
- A task fails and you need to guide the user through manual steps as a fallback

## Reference Files

Read the relevant file on demand — do NOT read all files at once.

| Question about                                | File                              |
| --------------------------------------------- | --------------------------------- |
| Product UI, layout, panels, buttons, features | `references/ui-and-features.md`   |
| Credits, pricing, subscriptions, billing      | `references/credits-and-plans.md` |

## Guidelines

1. **Try to do it first.** If the task is something you can handle (adding captions, changing aspect ratio, etc.), do it. Only guide GUI operations as a fallback.
2. **Use visible UI names.** When guiding manual operations, give clear numbered steps with labels and panel locations that are confirmed in the references. If the user says they cannot find an entry, re-anchor from major visible regions such as the AI panel, top bar, asset/library panels, and timeline.
3. **Generation confirmation help.** Credit confirmation cards for Motion Graphics, Video Generation, and Image Generation appear in the AI chat area. The persistent setting lives in the Agent settings popover beside the Agent mode selector at the bottom of the AI panel. If a confirmation was denied, cancelled, or timed out, explain what happened and wait for the user's next instruction before retrying.
4. **No internal details.** Never mention model names (except user-facing ones like Seedance 2.0), pricing formulas, or implementation details.
5. **Feedback & support.** If the user encounters a problem you cannot resolve, guide them to click "Feedback" in the user profile menu, or email team@chatcut.io.
