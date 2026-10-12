// Imported and re-exported, but never called here.
export { format } from './geometry.js';
import { invokes, register } from './registry.js';

// A value use at module level.
export const formatter = register;

// A call at module level.
invokes();
