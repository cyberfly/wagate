export interface AppEvent {
  id: number;
  type: string;
  timestamp: number;
  data: unknown;
}
export class EventBus {
  private listeners = new Set<(event: AppEvent) => void>();
  private sequence = 0;
  publish(type: string, data: unknown) {
    const event = { id: ++this.sequence, type, timestamp: Date.now(), data };
    for (const fn of this.listeners) {
      try {
        fn(event);
      } catch {
        /* isolate transport subscribers */
      }
    }
  }
  subscribe(fn: (event: AppEvent) => void) {
    this.listeners.add(fn);
    return () => {
      this.listeners.delete(fn);
    };
  }
}
