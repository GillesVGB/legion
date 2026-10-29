import { UserError } from './errors.mjs';

export class Locks {
  #busy = new Set();
  #waiters = new Map();
  async run(key, action, {wait=false}={}) {
    while(wait&&this.#busy.has(key))await new Promise(resolve=>{
      const pending=this.#waiters.get(key)||[];pending.push(resolve);this.#waiters.set(key,pending);
    });
    if (this.#busy.has(key)) throw new UserError('Deze actie wordt al verwerkt. Probeer over een paar seconden opnieuw.');
    this.#busy.add(key);
    try { return await action(); }
    finally {
      this.#busy.delete(key);
      const pending=this.#waiters.get(key)||[];this.#waiters.delete(key);
      for(const resolve of pending)resolve();
    }
  }
}
