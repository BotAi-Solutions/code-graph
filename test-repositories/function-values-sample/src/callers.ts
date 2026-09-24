import * as helpers from './helpers.js';
import {
  combine,
  double,
  formatName,
  formatters,
  identity,
  label,
  legacyFormat,
  legacyLoad,
  loadUser,
  mutable,
  settings,
  wrapped,
} from './helpers.js';

// Invocations: each of these is a call.

export function callsArrow() {
  formatName();
}

export async function awaitsAsyncArrow() {
  await loadUser('1');
}

export function callsFunctionExpression() {
  legacyFormat();
}

export async function awaitsAsyncFunctionExpression() {
  return await legacyLoad('2');
}

export function returnsCall() {
  return double(2);
}

export function callsGeneric() {
  return identity<number>(1);
}

export function callsParenthesized() {
  return wrapped();
}

export function callsOptionally() {
  return combine?.(1, 2);
}

export function callsThroughNamespace() {
  return helpers.double(3);
}

// Value uses: each of these is a reference, not a call.

export const alias = formatName;

function register(callback: (a: number, b: number) => number) {
  return callback;
}

export function registersCallback() {
  return register(combine);
}

export function bindsHelper() {
  return double.bind(null);
}

export function returnsHelper() {
  return legacyFormat;
}

export function callsAndPasses() {
  formatName();
  return [formatName];
}

// Non-callable variables stay variables, whatever the syntax around them.

export function readsObject() {
  return settings;
}

export function readsPrimitive() {
  return label.length;
}

export function callsObjectMember() {
  return formatters.upper('x');
}

export function callsMutable() {
  return mutable();
}

// Locals are not graph nodes; calling one must not break attribution.

export function callsLocal() {
  const inner = () => 1;
  return inner() + double(1);
}
