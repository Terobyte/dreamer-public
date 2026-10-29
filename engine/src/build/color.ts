/** FNV-1a 32 bit over the UTF-8 bytes of `id`, folded into a mid-range gray */
export function grayOf(materialId: string): string {
  const bytes = new TextEncoder().encode(materialId);
  let h = 0x811c9dc5;
  for (const b of bytes) {
    h ^= b;
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  const gg = 0x60 + (h % 0x61);
  const hex = gg.toString(16).padStart(2, "0");
  return `#${hex}${hex}${hex}`;
}
