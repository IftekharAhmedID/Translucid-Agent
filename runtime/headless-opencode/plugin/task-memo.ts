export function completedTaskMemo(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const memo = value.trim();
  if (!memo) return undefined;
  const taskResult = memo.match(/<task_result>([\s\S]*?)<\/task_result>/i);
  if (taskResult && !taskResult[1]?.trim()) return undefined;
  return memo;
}
