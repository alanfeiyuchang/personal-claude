// One-click automations for the panel. Each is a self-contained prompt sent
// to the active session — execution is visible in the transcript, so it can
// be watched or interrupted like any other turn. Derived from real usage
// patterns (36/475 historical prompts were "commit and push").

import type { SessionSummary } from './types';

export interface Automation {
  id: string;
  icon: string;
  name: string;
  description: string;
  /** When set, clicking the automation first asks for this value via a popup. */
  input?: { label: string };
  prompt: (session: SessionSummary, input?: string) => string;
}

export const AUTOMATIONS: Automation[] = [
  {
    id: 'ship',
    icon: '🚀',
    name: 'Ship it',
    description: 'Review the diff, commit in this repo’s style, and push.',
    prompt: () =>
      'Ship this project: review the working tree (git status + git diff), stage the relevant changes ' +
      '(respect .gitignore; never stage build artifacts, secrets, or unrelated files), write a commit ' +
      "message matching this repo's existing commit style, commit, and push to the current branch's " +
      'remote. If there is nothing to commit, say so. Finish with a one-line summary of what shipped.',
  },
  {
    id: 'brief',
    icon: '🧭',
    name: 'Brief me',
    description: 'Cross-project git status, plan limits, and what needs attention.',
    prompt: () =>
      'Give me a brief: 1) for each repo under ~/Desktop/Development with activity in the last 7 days, ' +
      'one line — branch, dirty file count, unpushed commits; 2) current Claude plan limit percentages; ' +
      '3) anything that looks like it needs my attention (failing state, stale branches, near limits). ' +
      'Keep it tight and scannable — no fluff.',
  },
  {
    id: 'typecheck',
    icon: '🧪',
    name: 'Verify build',
    description: 'Detect the toolchain, run typecheck + build, report errors only.',
    prompt: () =>
      'Verify this project compiles: detect the toolchain (package.json scripts, xcodebuild, etc.), ' +
      'run the typecheck and build, and report any errors with file:line. Do not fix anything — ' +
      'just report. If it is clean, say "build clean" and stop.',
  },
  {
    id: 'usage',
    icon: '📊',
    name: 'Usage advisor',
    description: 'Check limit burn rate and recommend model shifts to stretch the week.',
    prompt: () =>
      'Check my Claude usage: current 5-hour, weekly, and model-scoped limit percentages and how fast ' +
      "they're moving. If the weekly or model-scoped limit is on pace to run out early, recommend " +
      'specifically which of my current work should shift to a cheaper model. Be concrete and brief.',
  },
  {
    id: 'resume-filler',
    icon: '📄',
    name: 'Resume filler',
    description: 'Ask for a job application URL, open it in Chrome, and fill it from fact.md.',
    input: { label: 'Job application URL' },
    prompt: (_session, url) =>
      `Fill out the job application at ${url} for me. Follow ` +
      '/Users/changfeiyu/Desktop/Development/resume-filler/PLAYBOOK.md exactly. ' +
      'My info lives in /Users/changfeiyu/Desktop/Development/resume-filler/fact.md — every answer ' +
      'comes from there; if the form asks something it does not cover, ask me and write my answer ' +
      'back into fact.md. Open the page in a visible Chrome via CDP so the window survives for my ' +
      'review, attach my latest resume, write a tailored cover letter if there is a cover letter ' +
      'field, fill every field including EEO dropdowns, then show me screenshots of the filled form. ' +
      'Do NOT click Submit — leave that to me.',
  },
  {
    id: 'janitor',
    icon: '🧹',
    name: 'Janitor',
    description: 'List, then clean: stale /tmp test transcripts, orphaned dev servers, demo artifacts.',
    prompt: () =>
      'Clean up my Claude Code clutter. First LIST what you found, then delete: ' +
      '1) stale test transcripts under ~/.claude/projects/-private-tmp*/ older than 3 days; ' +
      '2) orphaned dev-server processes listening on ports 4390-4399; ' +
      '3) leftover demo artifacts (minty-*.mp4, cover-*.png, shot*.png) in ~/Desktop/Development/personal-claude. ' +
      'Do NOT touch anything else. End with a summary of what was removed.',
  },
];
