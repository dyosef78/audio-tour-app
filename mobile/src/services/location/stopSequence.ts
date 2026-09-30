/**
 * StopSequence - which stop narrates next (TASK-902).
 *
 * The geofence engine arms exactly ONE zone for entry: the first stop in the
 * visiting order that has not been passed. Crossing any other stop's boundary
 * does nothing, so a stop the routing provider scheduled for later cannot
 * narrate early just because the street happens to pass it.
 *
 * The order starts as the authored sort_order and may be replaced once, or
 * more, by the order route-stops actually routed (`waypoint_ids`). A stop is
 * PASSED when it was entered, or when the visitor jumped past it (reach() on a
 * later stop). Passed stops are never re-armed, whichever order arrives later.
 *
 * Pure and synchronous; LocationService owns the only instance per tour.
 */
export class StopSequence {
  private order: string[];
  private readonly passed = new Set<string>();

  constructor(order: readonly string[]) {
    this.order = [...order];
  }

  /** The stop armed for entry, or null once every stop is passed. */
  next(): string | null {
    return this.order.find((id) => !this.passed.has(id)) ?? null;
  }

  isPassed(id: string): boolean {
    return this.passed.has(id);
  }

  /** The current visiting order. */
  ids(): readonly string[] {
    return this.order;
  }

  /**
   * Adopt a new visiting order. Must contain exactly the same stops; anything
   * else is refused (false) and the current order stays. Progress is kept:
   * passed stops stay passed, and the new first unpassed stop is armed.
   */
  reorder(order: readonly string[]): boolean {
    if (order.length !== this.order.length || new Set(order).size !== order.length) return false;
    const known = new Set(this.order);
    if (!order.every((id) => known.has(id))) return false;
    this.order = [...order];
    return true;
  }

  /**
   * Mark `id` reached. Every unpassed stop BEFORE it in the order is skipped
   * with it - reaching stop 4 while stop 2 was armed means the visitor chose to
   * move on, and re-arming 2 afterwards would put the tour back behind them.
   * Reaching a stop already passed changes nothing.
   */
  /** The passed stops, in visiting order. For the session checkpoint (Epic 13). */
  passedIds(): string[] {
    return this.order.filter((id) => this.passed.has(id));
  }

  /**
   * Put back exactly the order and passed set a checkpoint recorded (Epic 13).
   *
   * Not reach() in a loop: after a reorder the passed stops need not be a
   * prefix of the order, and reach() would pass everything before each one.
   * All-or-nothing: refused (false, nothing changed) unless `order` names
   * exactly these stops and `passed` only stops among them.
   */
  restore(order: readonly string[], passed: readonly string[]): boolean {
    const known = new Set(this.order);
    if (!passed.every((id) => known.has(id))) return false;
    if (!this.reorder(order)) return false;
    this.passed.clear();
    for (const id of passed) this.passed.add(id);
    return true;
  }

  reach(id: string): void {
    const index = this.order.indexOf(id);
    if (index === -1 || this.passed.has(id)) return;
    for (let i = 0; i <= index; i++) this.passed.add(this.order[i] as string);
  }
}
