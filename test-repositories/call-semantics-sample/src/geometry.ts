import type { NamedShape } from './contracts.js';

export function format(value: number): string {
  return value.toFixed(2);
}

export abstract class BaseShape implements NamedShape {
  abstract readonly label: string;

  abstract area(): number;

  describe(): string {
    return `${this.label}: ${format(this.area())}`;
  }
}

export class Square extends BaseShape {
  readonly label = 'square';

  constructor(private readonly side: number) {
    super();
  }

  area(): number {
    return this.side * this.side;
  }

  // Same name as the instance method above, on the constructor instead.
  static area(side: number): number {
    return side * side;
  }
}
