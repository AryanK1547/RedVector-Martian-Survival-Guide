# Kickoff prompts

## 1. First prompt in Claude Code (run once, after the repo exists)

```
Read AGENTS.md, CLAUDE.md and log.txt. Do not write any code yet.
Give me the 5-line state summary from AGENTS.md section 0 and tell me what P0 still needs from me.
Remember: you never run git commit or git push; I do.
```

## 2. Start of each phase (after /clear)

```
Read AGENTS.md section 7 and the last 3 entries of log.txt.
Today's phase: <P1 Data | P2 Route + map | ...>.
Enter plan mode and propose the smallest steps to reach the "Done when" for this phase.
For each step: the concept to learn first (3-4 lines), the files you will create, and how I verify it.
Do not start building until I approve the plan.
```

## 3. During work (one task per prompt)

```
Task: <one thing, e.g. "mask NoData in tools/prepare_data.py and recompute slope">.
Done when: <what I can run or see>.
Explain each new concept briefly as you use it. Print only summaries of data, never arrays.
When done: append a work-block entry to log.txt and tell me if this is a commit point, with a suggested commit message.
```

## 4. Hard bug (use Opus, sparingly)

```
/model opus
Bug: <what I expected vs what happened>. Files: <paths>. What I tried: <list>.
Find the root cause first and explain it. Then propose the smallest fix.
```
Switch back with `/model sonnet` when done.

## 5. Quick tasks (use Haiku)

```
/model haiku
<rename, README formatting, boilerplate, suggest a commit message from `git diff --stat`>
```

## 6. End of session or before a break

```
Update log.txt with a work-block entry for everything done since the last entry.
Update AGENTS.md section 10 (Current State) and open issues.
List what is verified and what is still assumed. Tell me the next step.
```

## 7. README disclosure (P7)

```
Read log.txt. Draft the "AI Usage Disclosure" section for README.md from the AI Generated and Human Did lines.
Be accurate. Do not claim more human work than the log shows and do not hide AI-generated modules.
```
