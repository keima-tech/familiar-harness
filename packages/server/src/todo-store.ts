import type { TodoItem, TodoStore } from "@familiar/protocol";

/** In-memory, per-session todo state (M2; persistence arrives in M3+). */
export class SessionTodoStore implements TodoStore {
  private readonly state = new Map<string, TodoItem[]>();

  get(sessionId: string): TodoItem[] {
    return this.state.get(sessionId) ?? [];
  }

  set(sessionId: string, items: TodoItem[]): void {
    this.state.set(sessionId, items);
  }

  drop(sessionId: string): void {
    this.state.delete(sessionId);
  }
}
