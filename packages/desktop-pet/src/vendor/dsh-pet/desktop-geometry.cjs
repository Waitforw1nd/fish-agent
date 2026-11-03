/**
 * Adapted from PC2005-cloud/dsh-pet runtime/electron-helper/desktop-geometry.js
 * commit 3229ab287d82d7621af2ee51544a0e746c2e40fd, Copyright (c) 2026 PC2005-cloud.
 * MIT, license included in package licenses/dsh-pet-MIT.txt.
 * Fish changes: use OS work areas on all platforms, remove character constants
 * and menu-bar overlap; add safe single-window clamping.
 */
'use strict';
function buildDeskGeometry(displays, primaryId) {
  const workAreas = displays.map(display => ({ ...display.workArea }));
  const panels = displays.map(display => ({ ...display.bounds }));
  const x = Math.min(...workAreas.map(area => area.x));
  const y = Math.min(...workAreas.map(area => area.y));
  return {
    hull: { x, y, width: Math.max(...workAreas.map(a => a.x + a.width)) - x,
      height: Math.max(...workAreas.map(a => a.y + a.height)) - y },
    areas: workAreas, workAreas, panels,
    primaryIndex: Math.max(0, displays.findIndex(display => display.id === primaryId))
  };
}
function clampToWorkArea(bounds, area) {
  const width = Math.max(1, Math.min(Math.round(bounds.width), area.width));
  const height = Math.max(1, Math.min(Math.round(bounds.height), area.height));
  return { x: Math.round(Math.min(Math.max(bounds.x, area.x), area.x + area.width - width)),
    y: Math.round(Math.min(Math.max(bounds.y, area.y), area.y + area.height - height)), width, height };
}
module.exports = { buildDeskGeometry, clampToWorkArea };
