export type StepType =
  | "tool_group"
  | "tool"
  | "subagent"
  | "handoff"
  | "todo_list"
  | "clarification"
  | "thought"
  | "result"
  | "error";
export interface TodoItem {
  id: string;
  text: string;
  state: "pending" | "in_progress" | "done" | "skipped" | "blocked" | "failed";
  children?: TodoItem[];
  evidence?: {
    filesTouched?: string[];
    commandsRun?: string[];
    testOutput?: string;
    screenshots?: string[];
  };
  assignedTo?: string;
  retries?: number;
  blockedBy?: string[];
}
export interface DiffHunk {
  added: boolean;
  removed: boolean;
  value: string;
  oldStart?: number;
  newStart?: number;
}
export interface ProcessStep {
  id: string;
  type: StepType;
  title: string;
  ts?: number;
  durationMs?: number;
  pending?: boolean;
  content?: string;
  command?: string;
  output?: string;
  runAfterCommand?: string;
  runAfterOutput?: string;
  toolName?: string;
  filePath?: string;
  diffHunks?: DiffHunk[];
  fromModel?: string;
  toModel?: string;
  reason?: string;
  modelId?: string;
  modelLabel?: string;
  todos?: TodoItem[];
  options?: string[];
  children?: ProcessStep[];
  interrupted?: boolean;
  groupTitle?: string;
  groupTitleMode?: string;
}