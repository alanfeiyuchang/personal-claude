import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useStore, wsSend } from '../store';
import type { SessionSummary, SkillMeta } from '../types';
import { MintyBrain } from './MintyBrain';
import { AUTOMATIONS, type Automation } from '../automations';

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
  const skillMeta = useStore((s) => s.skillMeta);

  useEffect(() => {
    wsSend({ type: 'get_skill_meta', dir: session.dir });
  }, [session.dir]);

  const lookup = (name: string): SkillMeta | undefined => {
    const key = name.replace(/^\//, '');
    return skillMeta[key] ?? skillMeta[key.split(':').pop() ?? key];
  };

  return (
    <aside className="skills glass">
      <div className="skills-scroll">
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
            <Section
              title={`Skills (${info.skills.length})`}
              items={info.skills}
              lookup={lookup}
              collapsedByDefault
            />
            <Section
              title={`Slash commands (${info.slashCommands.length})`}
              items={info.slashCommands.map((c) => '/' + c)}
              lookup={lookup}
              collapsedByDefault
            />
            <Section title={`Plugins (${info.plugins.length})`} items={info.plugins} collapsedByDefault />
            <Section title={`Tools (${info.tools.length})`} items={info.tools} collapsedByDefault />
          </>
        )}

        <Automations session={session} onRun={onDescribe} />
      </div>

      <MintyBrain />
    </aside>
  );
}

function Automations({
  session,
  onRun,
}: {
  session: SessionSummary;
  onRun: (text: string) => void;
}) {
  const [ranId, setRanId] = useState<string | null>(null);
  const [asking, setAsking] = useState<Automation | null>(null);
  const [inputVal, setInputVal] = useState('');
  const disabled = session.state === 'closed' || !session.alive;

  const fire = (a: Automation, input?: string) => {
    onRun(a.prompt(session, input));
    setRanId(a.id);
    setTimeout(() => setRanId((cur) => (cur === a.id ? null : cur)), 1600);
  };

  const run = (id: string) => {
    const a = AUTOMATIONS.find((x) => x.id === id);
    if (!a || disabled) return;
    if (a.input) {
      setInputVal('');
      setAsking(a);
      return;
    }
    fire(a);
  };

  const submitInput = () => {
    if (!asking || !inputVal.trim()) return;
    fire(asking, inputVal.trim());
    setAsking(null);
  };

  return (
    <details className="skills-section automations" open>
      <summary>Automations ({AUTOMATIONS.length})</summary>
      <div className="automation-list">
        {AUTOMATIONS.map((a) => (
          <button
            key={a.id}
            className={`automation-item ${ranId === a.id ? 'ran' : ''}`}
            disabled={disabled}
            title={a.description}
            onClick={() => run(a.id)}
          >
            <span className="automation-icon">{a.icon}</span>
            <span className="automation-body">
              <span className="automation-name">{a.name}</span>
              <span className="automation-desc">{a.description}</span>
            </span>
            <span className="automation-go">{ranId === a.id ? '✓ sent' : '▶'}</span>
          </button>
        ))}
      </div>
      {asking &&
        createPortal(
          <div className="modal-backdrop" onClick={() => setAsking(null)}>
            <div className="modal glass" onClick={(e) => e.stopPropagation()}>
              <h2>
                {asking.icon} {asking.name}
              </h2>
              <label>{asking.input!.label}</label>
              <input
                type="text"
                autoFocus
                value={inputVal}
                placeholder="https://…"
                onChange={(e) => setInputVal(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') submitInput();
                  if (e.key === 'Escape') setAsking(null);
                }}
              />
              <div className="modal-actions">
                <button className="btn" onClick={() => setAsking(null)}>
                  Cancel
                </button>
                <button className="btn btn-primary" disabled={!inputVal.trim()} onClick={submitInput}>
                  Run ▶
                </button>
              </div>
            </div>
          </div>,
          document.body
        )}
    </details>
  );
}

function Section({
  title,
  items,
  collapsedByDefault,
  lookup,
}: {
  title: string;
  items: string[];
  collapsedByDefault?: boolean;
  lookup?: (name: string) => SkillMeta | undefined;
}) {
  const [selected, setSelected] = useState<string | null>(null);
  const meta = selected && lookup ? lookup(selected) : undefined;

  return (
    <details className="skills-section" open={!collapsedByDefault}>
      <summary>{title}</summary>
      <div className="skills-tags">
        {items.map((it) =>
          lookup ? (
            <button
              key={it}
              className={`tag tag-btn ${selected === it ? 'selected' : ''}`}
              onClick={() => setSelected(selected === it ? null : it)}
            >
              {it}
            </button>
          ) : (
            <span key={it} className="tag">
              {it}
            </span>
          )
        )}
      </div>
      {selected && (
        <div className="skill-detail">
          <div className="skill-detail-name">{selected}</div>
          <div className="skill-detail-desc">
            {meta?.description || 'No description available — this one is built into the CLI.'}
          </div>
          {meta && (
            <div className="skill-detail-source" title={meta.path ?? undefined}>
              {meta.source}
              {meta.path ? ` · ${meta.path.replace(/^\/Users\/[^/]+/, '~')}` : ''}
            </div>
          )}
        </div>
      )}
    </details>
  );
}
