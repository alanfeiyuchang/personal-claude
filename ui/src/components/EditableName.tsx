import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from 'react';

export interface EditableNameHandle {
  startEdit: () => void;
}

export const EditableName = forwardRef<
  EditableNameHandle,
  {
    value: string;
    onCommit: (v: string) => void;
    className?: string;
    inputClassName?: string;
  }
>(function EditableName({ value, onCommit, className, inputClassName }, ref) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const inputRef = useRef<HTMLInputElement>(null);

  useImperativeHandle(ref, () => ({
    startEdit: () => {
      setDraft(value);
      setEditing(true);
    },
  }));

  useEffect(() => {
    if (!editing) return;
    const raf = requestAnimationFrame(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    });
    return () => cancelAnimationFrame(raf);
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const trimmed = draft.trim();
    if (trimmed && trimmed !== value) onCommit(trimmed);
  };

  if (!editing) {
    return (
      <span
        className={className}
        title="Double-click to rename"
        onDoubleClick={(e) => {
          e.stopPropagation();
          setDraft(value);
          setEditing(true);
        }}
      >
        {value}
      </span>
    );
  }

  return (
    <input
      ref={inputRef}
      className={inputClassName ?? className}
      value={draft}
      onChange={(e) => setDraft(e.target.value)}
      onClick={(e) => e.stopPropagation()}
      onPointerDown={(e) => e.stopPropagation()}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          setEditing(false);
        }
      }}
      onBlur={commit}
    />
  );
});
