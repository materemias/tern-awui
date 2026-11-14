// omp's titles, `<glyph> TAG: rest`, split for display. No Node imports: the web app uses it too.

// Nerd-font icons live in the private use areas; the app ships the symbols font for them.
const PUA = /[\u{E000}-\u{F8FF}\u{F0000}-\u{10FFFF}]/u;
const PUA_ALL = new RegExp(PUA.source, "gu");

/** An omp title such as `<glyph> RDP: Diagnose login` as its icon, uppercase tag and the rest. */
export function splitTitle(raw: string): { icon: string | null; tag: string | null; title: string } {
  const icon = PUA.exec(raw)?.[0] ?? null;
  const clean = raw.replace(PUA_ALL, "").trim();
  const m = /^([\p{Lu}\d_-]{2,14}):\s+(.*)$/u.exec(clean);
  return { icon, tag: m ? m[1] : null, title: m ? m[2] : clean };
}
