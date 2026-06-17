// The jointed stick-man. Pure drawing: a neutral skeleton deformed by three
// scalars (crouch / extend / splay) then rotated by the board heading. Matches
// the character sheet — white ink, 5px round stroke, filled head, flexing board.

export interface Pose {
  crouch: number; // 0 ride .. 1 deep tuck
  extend: number; // 0 .. 1 launch pop
  splay: number; // 0 .. 1 wipeout flail
  grab: number; // 0 .. 1 hand reaches board
}

export const POSES: Record<string, Pose> = {
  ride: { crouch: 0.15, extend: 0, splay: 0, grab: 0 },
  tuck: { crouch: 0.85, extend: 0, splay: 0, grab: 0 },
  launch: { crouch: 0, extend: 1, splay: 0, grab: 0 },
  air: { crouch: 0.25, extend: 0.1, splay: 0, grab: 0 },
  grab: { crouch: 0.5, extend: 0, splay: 0, grab: 1 },
  wipeout: { crouch: 0, extend: 0, splay: 1, grab: 0 },
};

export function lerpPose(a: Pose, b: Pose, t: number): Pose {
  const l = (x: number, y: number) => x + (y - x) * t;
  return {
    crouch: l(a.crouch, b.crouch),
    extend: l(a.extend, b.extend),
    splay: l(a.splay, b.splay),
    grab: l(a.grab, b.grab),
  };
}

// Draws the rider centred on the board contact point (px,py) at the given world
// scale, rotated by `heading` radians. Colour is the ink (white over terrain).
export function drawRider(
  ctx: CanvasRenderingContext2D,
  px: number,
  py: number,
  heading: number,
  pose: Pose,
  scale: number,
  color = "#fff"
) {
  const { crouch, extend, splay, grab } = pose;
  ctx.save();
  ctx.translate(px, py);
  ctx.rotate(heading);
  ctx.scale(scale, scale);
  ctx.lineWidth = 5;
  ctx.lineCap = "round";
  ctx.lineJoin = "round";
  ctx.strokeStyle = color;
  ctx.fillStyle = color;

  // local space: board contact at (0,0), body rises in -y.
  const legLen = 26 - crouch * 11;
  const torso = 30 - crouch * 6 + extend * 4;
  const hipY = -10 - legLen * 0.4;
  const shoulderY = hipY - torso;
  const headY = shoulderY - 14;

  // board (flexes down on compression)
  const flex = 6 + crouch * 10 - extend * 4;
  ctx.beginPath();
  ctx.lineWidth = 6;
  ctx.moveTo(-26, 2);
  ctx.quadraticCurveTo(0, 2 + flex, 26, 2);
  ctx.stroke();
  ctx.lineWidth = 5;

  // legs: hip -> knee -> foot (both feet near board ends)
  const footSpread = 16 + splay * 10;
  ctx.beginPath();
  ctx.moveTo(0, hipY);
  ctx.lineTo(-6 - splay * 8, hipY + legLen * 0.6);
  ctx.lineTo(-footSpread, 0);
  ctx.moveTo(0, hipY);
  ctx.lineTo(8 + splay * 8, hipY + legLen * 0.6);
  ctx.lineTo(footSpread, 0);
  ctx.stroke();

  // torso
  ctx.beginPath();
  ctx.moveTo(0, hipY);
  ctx.lineTo(0, shoulderY);
  ctx.stroke();

  // arms: shoulder -> elbow -> hand. grab pulls a hand to the board.
  ctx.beginPath();
  if (grab > 0.5) {
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(-10, shoulderY + 14);
    ctx.lineTo(-12, 0); // hand grabs board
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(16 + extend * 10, shoulderY - 6 - extend * 14);
    ctx.lineTo(26 + extend * 16, shoulderY - 10 - extend * 22);
  } else {
    const reach = 14 + extend * 14 + splay * 14;
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(-12, shoulderY + 8 - extend * 18);
    ctx.lineTo(-12 - reach, shoulderY + 4 - extend * 24 - splay * 16);
    ctx.moveTo(0, shoulderY);
    ctx.lineTo(12, shoulderY + 8 - extend * 18);
    ctx.lineTo(12 + reach, shoulderY + 4 - extend * 24 - splay * 16);
  }
  ctx.stroke();

  // head (filled)
  ctx.beginPath();
  ctx.arc(0, headY, 9, 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}
