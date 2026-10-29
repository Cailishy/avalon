export const DIALOG_ENTRANCE_MS = 560;

export class DialogMotion {
  private key: string | null = null;
  private openedAt = 0;

  update(key: string | null, now = Date.now()): number | null {
    if (key !== this.key) {
      this.key = key;
      this.openedAt = now;
    }
    if (key === null) return null;
    const elapsed = Math.max(0, now - this.openedAt);
    return elapsed < DIALOG_ENTRANCE_MS ? elapsed : null;
  }
}
