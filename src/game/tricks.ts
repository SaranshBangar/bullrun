// Finance-themed trick table + the picker that names a landed jump from its
// shape (flips, airtime, grab, launch context).

export interface TrickDef {
  name: string;
  base: number;
  multAdd: number;
}

export const TRICKS: Record<string, TrickDef> = {
  bullFlip: { name: "Bull Flip", base: 800, multAdd: 0.5 },
  shortSqueeze: { name: "Short Squeeze", base: 1200, multAdd: 0.6 },
  diamondHands: { name: "Diamond Hands", base: 1500, multAdd: 0.8 },
  deadCat: { name: "Dead Cat Bounce", base: 600, multAdd: 0.4 },
  toTheMoon: { name: "To The Moon", base: 3000, multAdd: 1.2 },
};

export interface Jump {
  flips: number;
  airtimeMs: number;
  maxHeight: number;
  grabHeldMs: number;
  launch: "earnings" | "dip" | "normal";
}

export function nameTrick(j: Jump): TrickDef | null {
  if (j.airtimeMs < 320 && j.flips === 0 && j.grabHeldMs < 300) return null; // a hop, not a trick
  if (j.launch === "earnings" && j.maxHeight > 160) return TRICKS.toTheMoon;
  if (j.grabHeldMs >= 1000) return TRICKS.diamondHands;
  if (j.launch === "dip" && j.flips >= 1) return TRICKS.shortSqueeze;
  if (j.maxHeight < 90 && j.flips >= 1) return TRICKS.deadCat;
  if (j.flips >= 1) return TRICKS.bullFlip;
  // airtime/grab with no flip still counts as a small trick
  return TRICKS.deadCat;
}
