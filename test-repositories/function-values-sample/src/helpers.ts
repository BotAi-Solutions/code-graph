// Function-valued variables: each of these is a callable declaration.

export const formatName = () => 'name';

export const loadUser = async (id: string) => ({ id });

export const double = (x: number) => x * 2;

export const legacyFormat = function () {
  return 'legacy';
};

export const legacyLoad = async function (id: string) {
  return { id };
};

export const combine = (a: number, b: number) => {
  const sum = a + b;
  return sum;
};

export const identity = <T>(value: T): T => value;

export const wrapped = (() => 'wrapped');

// Values that are not functions, however they are used.

export const settings = {};

export const names: string[] = [];

export const limit = 123;

export const label = 'foo';

/** An object whose members are functions is still an object. */
export const formatters = {
  upper: (value: string) => value.toUpperCase(),
};

/** `let` can be reassigned to anything, so it is not treated as a declaration of a function. */
export let mutable = () => 'mutable';
