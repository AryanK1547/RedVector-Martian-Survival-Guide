// Binary min-heap of (priority, id). Always pops the smallest priority;
// equal priorities pop the smaller id first, so results are deterministic.
// "Binary heap": a tree stored in an array where the children of slot i sit at
// 2i+1 and 2i+2 and every parent is <= its children. Push and pop cost O(log n).
export class MinHeap {
  private pri: number[] = [];
  private ids: number[] = [];

  get size(): number {
    return this.ids.length;
  }

  private less(a: number, b: number): boolean {
    return this.pri[a] < this.pri[b] || (this.pri[a] === this.pri[b] && this.ids[a] < this.ids[b]);
  }

  private swap(a: number, b: number): void {
    [this.pri[a], this.pri[b]] = [this.pri[b], this.pri[a]];
    [this.ids[a], this.ids[b]] = [this.ids[b], this.ids[a]];
  }

  push(priority: number, id: number): void {
    this.pri.push(priority);
    this.ids.push(id);
    let i = this.ids.length - 1;
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (!this.less(i, parent)) break;
      this.swap(i, parent);
      i = parent;
    }
  }

  // Removes and returns the smallest entry. Call only when size > 0.
  pop(): { priority: number; id: number } {
    const top = { priority: this.pri[0], id: this.ids[0] };
    const lastPri = this.pri.pop()!;
    const lastId = this.ids.pop()!;
    if (this.ids.length > 0) {
      this.pri[0] = lastPri;
      this.ids[0] = lastId;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < this.ids.length && this.less(l, m)) m = l;
        if (r < this.ids.length && this.less(r, m)) m = r;
        if (m === i) break;
        this.swap(i, m);
        i = m;
      }
    }
    return top;
  }
}
