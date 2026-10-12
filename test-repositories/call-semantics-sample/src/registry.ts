import { format, Square } from './geometry.js';
import * as geometry from './geometry.js';

export function register(callback: (value: number) => string): (value: number) => string {
  return callback;
}

// Invocations.

export function invokes(): string {
  return format(1);
}

export function callsThroughNamespace(): string {
  return geometry.format(2);
}

export function buildsSquare(): number {
  return new Square(3).area();
}

export function callsStatic(): number {
  return Square.area(4);
}

// A value use: `format` is passed, not called.

export function passesAsValue(): (value: number) => string {
  return register(format);
}
