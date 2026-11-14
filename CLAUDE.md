# CLAUDE.md

Read `AGENTS.md` first. It is the full contract. This file only holds the rules that must never be forgotten.

- NEVER run `git commit`, `git push`, `git tag` or anything that creates commits. The human commits. Suggest a commit message in chat at each commit point.
- NEVER add Co-Authored-By, "Generated with Claude" or session links anywhere in the repo, README, or suggested commit messages. (Event rule: no AI authors.)
- NEVER read `data-raw/` or print large arrays. Print only shape, min, max, counts.
- Stack is static: Python for data prep, Vite + TypeScript + MapLibre + Three.js for the app, A* in a Web Worker. No server.
- Explain each new tool and concept (how and why) before or while using it. Finish the step in the same message.
- Mark verified vs assumed. Never invent data facts, URLs, thresholds or numbers.
- Append a work-block entry to `log.txt` (format in AGENTS.md §5) after each task, with honest "AI Generated" and "Human Did" lines.
- Stay in the current phase (AGENTS.md §7). Keep replies short; usage is limited.
- Default model Sonnet 5.5. Ask the human before using Opus.
