import { EventEmitter } from 'node:events';

/**
 * The application's event bus. Domain events are published here and handled
 * elsewhere, so nothing in the call graph connects the two — which is exactly
 * why the graph needs event nodes.
 */
export const events = new EventEmitter();

export const USER_CREATED = 'user.created';
