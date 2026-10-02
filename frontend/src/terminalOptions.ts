export const COMPLETED_TERMINAL_MARK = "✓";

export type TerminalOption = {
  /** Original terminal name. Used for API calls and CSV lookup. Never contains the mark. */
  value: string;
  /** Display text only. Completed terminals are prefixed with a check mark. */
  label: string;
  completed: boolean;
};

export function buildTerminalOptions(terminals: string[], completedTerminals: string[]): TerminalOption[] {
  const completed = new Set(completedTerminals);
  return terminals.map((terminal) => {
    const isCompleted = completed.has(terminal);
    return {
      value: terminal,
      label: isCompleted ? `${COMPLETED_TERMINAL_MARK} ${terminal}` : terminal,
      completed: isCompleted,
    };
  });
}
