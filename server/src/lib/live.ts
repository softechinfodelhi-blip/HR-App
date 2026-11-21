// In-process event bus behind the live board's Server-Sent Events stream.
// One Node process serves everything, so no external broker is needed.
import { EventEmitter } from 'node:events';

export interface LiveEvent {
  /** punch: a punch was stored. device: a terminal was registered, changed or removed. day: an attendance day was recomputed. */
  type: 'punch' | 'device' | 'day';
  /** Offices that should hear this: the terminal's office and the employee's office. */
  officeIds: string[];
  data: Record<string, unknown>;
}

const bus = new EventEmitter();
bus.setMaxListeners(0);

export function publish(e: LiveEvent): void { bus.emit('event', e); }
/** Returns the function that stops listening. */
export function subscribe(fn: (e: LiveEvent) => void): () => void {
  bus.on('event', fn);
  return () => bus.off('event', fn);
}
