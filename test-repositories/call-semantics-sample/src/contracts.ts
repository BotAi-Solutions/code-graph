// Interfaces only. `NamedShape` inherits from two interfaces with `extends`.

export interface Shape {
  area(): number;
}

export interface Named {
  readonly label: string;
}

export interface NamedShape extends Shape, Named {}
