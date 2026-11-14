# MarsWalk setup guide (for someone new to Claude Code)

Do P0 now. Every step is quick.

## A. Team and git (5 minutes)

1. Every team member has their own GitHub account. Each member runs on their own laptop:
   ```
   git config --global user.name "Your Name"
   git config --global user.email "<email of your GitHub account>"
   ```
   The handbook says this email must match your GitHub account, otherwise commits do not count for you in Contributors.
2. Create the repo on GitHub AFTER 12:00 on 14 Nov: public, named e.g. `marswalk`, with a README. Add every teammate as a collaborator.
3. Clone it, then copy the kit files into it:
   `AGENTS.md`, `CLAUDE.md`, `log.txt`, `.claude/settings.json`.
4. Create `.gitignore` with: `data-raw/`, `node_modules/`, `__pycache__/`, `.env`, `.claude/settings.local.json`, `*.img`, `dist/`.
5. Put the raw NASA files in `data-raw/` (this folder is gitignored and Claude may not read it).
6. YOU commit and push (not Claude):
   ```
   git add -A
   git commit -m "Initial project setup and AI agent rules"
   git push
   ```
   Then run `git log -1 --format=%B` and check there is no AI text in the message.

## B. Install and start Claude Code

- Check: `claude --version`. If it is not installed, follow https://docs.claude.com/en/docs/claude-code/overview (installation instructions are there; I did not verify the install command, so use the page).
- Run `claude` inside the repo folder and log in with your Claude Pro account.
- Make sure no `ANTHROPIC_API_KEY` environment variable is set, otherwise it can bill the API instead of using your Pro plan.
- Useful commands: `/model` (switch model), `/usage` (see your limits), `/clear` (fresh context), `/compact` (shrink a long chat), Shift+Tab (plan mode).
- Verify the safety net: ask Claude "run git commit" as a test. It must be refused by the deny rule. If it is not refused, do not use Claude for anything touching git; commit by hand only.
- About attribution: `settings.json` empties the attribution fields. Reports say a newer "Claude-Session" trailer can still appear in some versions, which is why commits are done by the human and checked with `git log`. If your Claude Code version is 2.1.281 or newer, the simpler form `"attribution": false` also works; older versions reject it. Keep the object form unless you have checked.

## C. How to use Pro without hitting the wall

Pro has a rolling 5-hour window and a weekly cap, shared with the Claude chat app. Claude Code can eat it quickly on a big repo.

| Task | Model |
|---|---|
| Most coding, debugging, UI, A*, deploy workflow | Sonnet 5.5 (default) |
| Hard design or a bug that survived two tries (3D coordinate sync, algorithm checks) | Opus 5.5, max 2-3 times |
| Rename, README polish, boilerplate, commit message ideas | Haiku 5.5 |
| Fable | Skip (billed per token on Pro) |

Habits that save the most:
1. Plan mode first for each phase; approve; then build.
2. One task per prompt, then `/clear`.
3. Name file paths; never paste big files or data.
4. Check `/usage` at the start of each phase.
5. Save 20% of usage for the last morning (README, demo, fixes).
6. If you hit the limit: do human tasks (README, screenshots, judge Q&A, testing) until the reset. A teammate on another account can also keep going, and any AI tool use must be disclosed in the README.
7. Use this chat (or Haiku) for pure concept questions; both draw from the same pool, so keep them short.

## D. Hourly push routine (human)

Every hour, on the hour:
1. `git status` and look at what changed.
2. `git add -A`, then `git commit -m "<short, true description of this hour's work>"`.
3. `git push`.
4. Ask Claude (Haiku) to write the log entry if it did not already.
Set a phone alarm for every hour. Overnight, small real steps are fine (a test, a doc, one fix). Never fake a commit.

## E. Deployment (GitHub Pages, no commits created by a bot)

In the repo: Settings -> Pages -> Source: GitHub Actions. Claude writes `.github/workflows/pages.yml` using the official `actions/upload-pages-artifact` and `actions/deploy-pages`; you commit it. Put the live URL at the top of README.md.

## F. Questions to ask the organisers early

1. Is re-creating our own earlier learning code (reading the MOLA file, coordinate math) inside the window acceptable if we disclose it? Safest path: re-write it fresh in the repo with Claude's help and disclose.
2. How should hourly pushes work overnight?

Contacts are in the handbook (nasaspaceappsnagpur26@gmail.com, local lead listed on page 5).
