# Iris overnight handoff — October 30, 2026

User authorization: launch Iris overnight to search and apply for broad computer-science jobs, prioritize fresher/new-grad/entry-level but include somewhat higher-level roles when the real profile fits. Exclude all internships. Autonomously monitor and repair stalls while preserving the resume template. User is sleeping and authorized continuing without permission questions. No outreach messages are authorized.

## Task and time

Canonical prompt: `docs/iris-overnight-task.txt`. It includes software engineering, AI/ML, data, QA/automation, cloud/DevOps, systems, cybersecurity and IT. Actual education is University of Houston BS CS, expected December 2026. Saved application settings permit auto-submit and have no daily limit. Use saved authorization answers, never invent personal/eligibility facts. Stop starting new applications at 8:45 AM America/Chicago; let the active one finish. At/after 9:00 AM clear the continuous restart timer using agent_stop at a safe boundary and pause this heartbeat after reporting results. Do not restart after the overnight deadline.

Heartbeat ID: watch-iris-overnight-job-search. Check every 10 minutes; remain quiet on healthy or unchanged progress. Notify only meaningful failure/required user action/completion. The heartbeat cannot run while the computer or Codex is unavailable; do not claim otherwise.

## Locations

Workspace: /Users/amrindersingh/Desktop/AMD-AGENTIC-TEST/pi-test/Iris-fix
Packaged browser: dist/app/mac-arm64/Iris.app
User state: ~/Library/Application Support/Iris
Debug log: ~/ai/iris-run/iris-debug.log
Bridge helper: ~/ai/iris-run/ib.py (reads the local bridge token; do not print it)
Builder: ~/Desktop/Projects/resuma, Python .venv/bin/python
Application PDFs and reports: ~/Documents/Iris Resumes
Service reports and saved model prompts: ~/Desktop/Projects/resuma/output

## Inspection and controls

Read-only status: `python3 ~/ai/iris-run/ib.py agent_status '{"last":5}'`.
Read-only resume queue (after updated deployment): `python3 ~/ai/iris-run/ib.py resume_jobs`.
Job history: `python3 ~/ai/iris-run/ib.py applications`.
A running application or resume is not stalled merely because its stage takes a few minutes. Compare job phase/progress/log_tail and last activity over multiple checks. Investigate errors, repeated identical page actions, waits over the service timeout, missing result files or a dead process. Preserve confirmations and application history to avoid duplicate submissions.

Start a new continuous session only when idle by sending agent_run JSON through the helper, with task from the canonical prompt, mode continuous, and plan quick. Use a structured Python request rather than shell-interpolating task text. Resume existing healthy work; do not launch duplicate sessions. If paused for unknown personal/eligibility information, do not fabricate an answer. Record needs_you and continue other work when possible. Do not bypass CAPTCHAs, access controls or rate limits.

## Deployment and recovery

Do not edit/restart a healthy active run. Stage service changes, run targeted tests, build, and deploy at a job/idle boundary. ~/ai/iris-run/hot_update.sh builds and copies the workspace to the packaged app, but terminates/reopens Iris: use only when agent_status.running is false AND no resume job is pending. Its process search should be verified before use. Keep existing app identity and user data. Do not delete user data or logs. Pending user-stopped applications may have a resume completing in background; preserve it and check confirmed application history before resuming.

The repository stores the complete external service patch in resources/resuma-tailoring.patch. Original pre-change service sources are backed up under /tmp/iris-resuma-before-tailoring. Do not overwrite these baseline backups. Version service changes by updating that patch against the original backups.

The updated builder aims at 90% literal keyword coverage but does not claim this is an actual ATS score. It prioritizes relevant projects into larger slots, uses a separate requirement-evidence review with checked JD/PDF quotes, and allows generated project proposals only in adaptive mode with report provenance. Real employment roles, measurements, dates and tools stay grounded. Preserve exact one-page layout and measured slot counts. Faster bounded generation disables long thinking passes and stops identical repair retries. Do not inflate scores by treating unrelated technology names as synonyms or ordinary nouns such as 'answer box' as vendor skills.

## Current work

The main chat is completing validation and deployment, then will append the launched session ID and observed state here. If that section is absent, first inspect the active session and recent logs; do not race the main chat by starting another run. The current validation uses /tmp/iris-resuma-focused with output under /tmp/iris-resuma-focused-live. No application is submitted by this validation.

## Afternoon user update — October 30

The user replaced the old task with `docs/iris-job-search-task.txt` (also saved in `~/ai/iris-run/task.txt`). It explicitly includes LinkedIn alongside other job sites and all relevant CS role families, with no outreach and no internships. Continue until the user stops it; the old morning deadline and blanket LinkedIn exclusion are superseded by this request. Respect actual site limits.

Resume cancellation now aborts an active model request and stops later stages, as well as removing queued work. Iris cancels unused work on move-on paths and matches labelled posting requisitions against applied history before requesting tailoring (Citi public careers versus Workday regression covered). Browser and resume-service regression tests passed; the portable external-service patch was updated and verified. Installed in the packaged Iris app at an idle search boundary. Current continuous session: `mvvhvr03-614ag5`. All application history and previous chats were preserved.

Latest user scope: ONLY LinkedIn, Indeed, Handshake and company career pages for job discovery. Employer application links from those sources are allowed for completing forms. This replaces the earlier wider source list. Current session: `mvvihhh6-81coum`. Canonical prompt remains `docs/iris-job-search-task.txt` and `~/ai/iris-run/task.txt`.
