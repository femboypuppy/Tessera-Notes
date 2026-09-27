/**
 * The logo's four tiles (`assets/brand/logo-mark.svg`, drawn by `docs/scripts/brand.ts`; a docs
 * check keeps these paths identical): two quarter-round tiles that make a leaf, two square tiles.
 */
const TILES = [
  {
    tone: 'leaf',
    d: 'M13.4 14.9L2.855 14.9A1.5 1.5 0 0 1 1.383 13.109A14.9 14.9 0 0 1 13.109 1.383A1.5 1.5 0 0 1 14.9 2.855L14.9 13.4A1.5 1.5 0 0 1 13.4 14.9Z',
  },
  {
    tone: 'tile',
    d: 'M18.6 1.1H29.4A1.5 1.5 0 0 1 30.9 2.6V13.4A1.5 1.5 0 0 1 29.4 14.9H18.6A1.5 1.5 0 0 1 17.1 13.4V2.6A1.5 1.5 0 0 1 18.6 1.1Z',
  },
  {
    tone: 'tile',
    d: 'M2.6 17.1H13.4A1.5 1.5 0 0 1 14.9 18.6V29.4A1.5 1.5 0 0 1 13.4 30.9H2.6A1.5 1.5 0 0 1 1.1 29.4V18.6A1.5 1.5 0 0 1 2.6 17.1Z',
  },
  {
    tone: 'leaf',
    d: 'M18.6 17.1L29.145 17.1A1.5 1.5 0 0 1 30.617 18.891A14.9 14.9 0 0 1 18.891 30.617A1.5 1.5 0 0 1 17.1 29.145L17.1 18.6A1.5 1.5 0 0 1 18.6 17.1Z',
  },
] as const;

/**
 * The Tessera Notes mark in the theme's tones: the leaf in the accent text color (deep indigo, or
 * lavender in the dark theme), the squares quieter. Decorative: the product name is always
 * written next to it.
 */
export function LogoMark({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 32 32" className={className} aria-hidden="true" focusable="false">
      {TILES.map((tile) => (
        <path
          key={tile.d}
          d={tile.d}
          className={tile.tone === 'leaf' ? 'fill-accent-text' : 'fill-accent/50 dark:fill-accent'}
        />
      ))}
    </svg>
  );
}
