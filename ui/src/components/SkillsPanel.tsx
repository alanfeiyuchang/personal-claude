import { useState } from 'react';
import type { SessionSummary } from '../types';

// Read-only v1 of the Skills & Automations panel (PLAN.md §5.3): lists what's
// live in this session from the init event. "Create by describing" lands in a
// later phase — the CTA below routes the description into the session itself.

export function SkillsPanel({
  session,
  onDescribe,
}: {
  session: SessionSummary;
  onDescribe: (text: string) => void;
}) {
  const info = session.initInfo;
  const [draft, setDraft] = useState('');

  return (
    <aside className="skills glass">
      <div className="panel-title">Skills &amp; Automations</div>

      <div className="describe-box">
        <textarea
          value={draft}
          rows={3}
          placeholder='Describe a skill or automation… e.g. "whenever a Swift build succeeds, run the tests and summarize failures"'
          onChange={(e) => setDraft(e.target.value)}
        />
        <button
          className="btn btn-primary"
          disabled={!draft.trim() || !info}
          onClick={() => {
            onDescribe(
              `Create a Claude Code skill or automation from this description. ` +
                `Decide whether it should be a skill (~/.claude/skills/*/SKILL.md), a hook in settings.json, or a scheduled task. ` +
                `Show me the files you would write and ask for approval before writing them.\n\nDescription: ${draft.trim()}`
            );
            setDraft('');
          }}
        >
          Draft it →
        </button>
      </div>

      {!info ? (
        <div className="skills-empty">Send a first message to load this session's context.</div>
      ) : (
        <>
          <Section title={`Skills (${info.skills.length})`} items={info.skills} />
          <Section
            title={`Slash commands (${info.slashCommands.length})`}
            items={info.slashCommands.map((c) => '/' + c)}
          />
          <Section title={`Plugins (${info.plugins.length})`} items={info.plugins} />
          <Section title={`Tools (${info.tools.length})`} items={info.tools} collapsedByDefault />
        </>
      )}
    </aside>
  );
}

function Section({
  title,
  items,
  collapsedByDefault,
}: {
  title: string;
  items: string[];
  collapsedByDefault?: boolean;
}) {
  return (
    <details className="skills-section" open={!collapsedByDefault}>
      <summary>{title}</summary>
      <div className="skills-tags">
        {items.map((it) => (
          <span key={it} className="tag">
            {it}
          </span>
        ))}
      </div>
    </details>
  );
}
