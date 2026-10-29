import type { RoleKey, ServantVariant } from "../shared/game";

const roleCells: Record<RoleKey, number> = {
  merlin: 0, percival: 1, servant: 2, morgana: 3,
  assassin: 4, minion: 5, mordred: 6, oberon: 7,
};

export function rolePortraitCell(role: RoleKey, servantVariant?: ServantVariant | null): number {
  if (role === "servant" && servantVariant === "female") return 8;
  return roleCells[role];
}

// Public portraits depend only on seat position, never on a secret role.
export function seatPortraitCell(position: number): number {
  return position % 10;
}

export function seatPortraitMarkup(position: number, className = ""): string {
  const cell = seatPortraitCell(position);
  return `<span class="portrait public-portrait ${className}" style="--portrait-x:${cell % 5 * 25}%;--portrait-y:${Math.floor(cell / 5) * 100}%" aria-hidden="true"></span>`;
}

export function portraitMarkup(cell: number, className = ""): string {
  if (cell >= 8) return `<span class="portrait portrait-guest ${className}" style="--portrait-x:${(cell - 8) * 100}%;--portrait-y:0%" aria-hidden="true"></span>`;
  return `<span class="portrait ${className}" style="--portrait-x:${(cell % 4) * 100 / 3}%;--portrait-y:${Math.floor(cell / 4) * 100}%" aria-hidden="true"></span>`;
}
