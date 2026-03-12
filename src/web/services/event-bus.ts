export type SessionSseEvent = {
  type: 'status' | 'created' | 'deleted';
  sessionId: string;
  status?: string;
  html?: string;
};

export type TaskSseEvent = {
  type: 'task-status' | 'task-updated';
  taskId: string;
  status?: string;
};

export type HandoffSseEvent = {
  type: 'handoff';
  sessionId: string;
  status: 'started' | 'completed';
  url?: string;
  message?: string;
};

export type SseEvent = SessionSseEvent | TaskSseEvent | HandoffSseEvent;

class EventBus {
  private subscribers = new Set<(event: SseEvent) => void>();

  subscribe(cb: (event: SseEvent) => void): () => void {
    this.subscribers.add(cb);
    return () => this.subscribers.delete(cb);
  }

  publish(event: SseEvent): void {
    for (const cb of this.subscribers) {
      cb(event);
    }
  }
}

export const eventBus = new EventBus();
