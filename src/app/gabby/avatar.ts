const CRITTERS = ['🦊', '🐙', '🦉', '🐸', '🦜', '🐢', '🦈', '🐝'];

/** Deterministic courier-critter avatar for a node name. */
export function critterFor(name: string): string {
  let hash = 0;
  for (const ch of name.toLowerCase()) {
    hash = (hash * 31 + ch.codePointAt(0)!) >>> 0;
  }
  return CRITTERS[hash % CRITTERS.length];
}
