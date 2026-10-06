import { UserError } from './errors.mjs';

export class Locks {
  #busy = new Set();
  async run(key, action) {
    if (this.#busy.has(key)) throw new UserError('Deze actie wordt al verwerkt. Probeer over een paar seconden opnieuw.');
    this.#busy.add(key);
    try { return await action(); }
    finally { this.#busy.delete(key); }
  }
}
