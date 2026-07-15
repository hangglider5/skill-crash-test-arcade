export class ExactActiveAuthority<T extends object> {
  readonly #active = new Map<string, T>();

  current(key: string): T | undefined {
    return this.#active.get(key);
  }

  replace(key: string, value: T): T | undefined {
    const previous = this.#active.get(key);
    this.#active.set(key, value);
    return previous;
  }

  release(key: string, value: T): boolean {
    if (this.#active.get(key) !== value) return false;
    return this.#active.delete(key);
  }
}
