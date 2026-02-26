export type SseEvent = {
  sessionId: string;
  type: 'status' | 'created' | 'deleted';
  status?: string;
  html?: string;
};

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
