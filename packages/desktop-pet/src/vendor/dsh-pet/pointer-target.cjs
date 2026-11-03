/**
 * Adapted from PC2005-cloud/dsh-pet runtime/electron-helper/pointer-target.js
 * commit 3229ab287d82d7621af2ee51544a0e746c2e40fd, Copyright (c) 2026 PC2005-cloud.
 * MIT; see ../../../licenses/dsh-pet-MIT.txt (package root licenses).
 * Fish changes: replace all character geometry with caller-provided rectangles;
 * retain the pointer zoning, busy lease and delayed margin-release algorithm.
 */
'use strict';
const POINTER_POLL_MS = 60;
const OFF_BODY_RELEASE_MS = 400;
function contains(rect, point) {
  return point.x >= rect.x && point.x < rect.x + rect.width &&
    point.y >= rect.y && point.y < rect.y + rect.height;
}
function spriteHitRect(bounds, local) {
  return { x: bounds.x + local.x, y: bounds.y + local.y, width: local.width, height: local.height };
}
function pointerZone(bounds, point, body) {
  if (!contains(bounds, point)) return 'outside';
  return body && contains(spriteHitRect(bounds, body), point) ? 'body' : 'margin';
}
function decideWindowIgnore(bounds, point, ignoring, busy, offBodyMs = 0, input = {}) {
  // Dragging and a focused text editor must never lose input mid-interaction.
  if (busy) return false;
  if ((input.rects || []).some(rect => contains(spriteHitRect(bounds, rect), point))) return false;
  const zone = pointerZone(bounds, point, input.body);
  if (zone === 'outside') return true;
  if (zone === 'body') return false;
  if (offBodyMs >= OFF_BODY_RELEASE_MS) return true;
  return ignoring;
}
module.exports = { POINTER_POLL_MS, OFF_BODY_RELEASE_MS, contains, spriteHitRect, pointerZone, decideWindowIgnore };
