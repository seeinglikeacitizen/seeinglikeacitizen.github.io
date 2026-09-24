// One small shape per way of getting a post. Colour carries the branch; shape carries the method.
// Shapes are drawn in a 16x16 box centred on (8, 8).

const SHAPES = {
  citizens: (c) => `<circle cx="5" cy="8" r="2.6" fill="${c}"/><circle cx="11" cy="8" r="2.6" fill="${c}"/><circle cx="8" cy="4" r="2.6" fill="${c}"/>`,
  direct_election: (c) => `<circle cx="8" cy="8" r="5.5" fill="${c}"/>`,
  indirect_election: (c) => `<circle cx="8" cy="8" r="6" fill="none" stroke="${c}" stroke-width="1.6"/><circle cx="8" cy="8" r="2.8" fill="${c}"/>`,
  appointment: (c) => `<rect x="3" y="3" width="10" height="10" fill="${c}"/>`,
  committee: (c) => `<path d="M8 2.5 L13.5 13 L2.5 13 Z" fill="${c}"/>`,
  collegium: (c) => `<path d="M8 2.5 L13.5 13 L2.5 13 Z" fill="none" stroke="${c}" stroke-width="1.6"/><path d="M8 7 L10.4 11.4 L5.6 11.4 Z" fill="${c}"/>`,
  career_posting: (c) => `<path d="M8 2 L14 8 L8 14 L2 8 Z" fill="${c}"/>`,
  ex_officio: (c) => `<rect x="3" y="3" width="10" height="10" fill="none" stroke="${c}" stroke-width="1.6"/><circle cx="8" cy="8" r="2" fill="${c}"/>`,
  recognition: (c) => `<rect x="3" y="3" width="10" height="10" fill="none" stroke="${c}" stroke-width="1.6" stroke-dasharray="2 1.5"/>`,
  composite: (c) => `<rect x="2.5" y="4" width="11" height="8" rx="4" fill="none" stroke="${c}" stroke-width="1.6"/>`,
  mixed: (c) => `<path d="M8 2.5 A5.5 5.5 0 0 0 8 13.5 Z" fill="${c}"/><circle cx="8" cy="8" r="5.5" fill="none" stroke="${c}" stroke-width="1.4"/>`,
};

export const METHOD_ORDER = ["citizens", "direct_election", "indirect_election", "appointment", "committee",
  "collegium", "career_posting", "ex_officio", "recognition", "composite", "mixed"];

export function glyphInner(method, color) {
  return (SHAPES[method] || SHAPES.appointment)(color);
}

export function glyph(method, color, size = 16, title = "") {
  const t = title ? `<title>${title}</title>` : "";
  return `<svg class="glyph" width="${size}" height="${size}" viewBox="0 0 16 16" aria-hidden="${title ? "false" : "true"}">${t}${glyphInner(method, color)}</svg>`;
}
