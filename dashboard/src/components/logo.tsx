/** The GSClaw mark (three rising talons), inline so it inherits no external requests. */
export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 512 512" aria-hidden="true" focusable="false">
      <defs>
        <linearGradient id="gsclaw-talon" x1="0" y1="1" x2="1" y2="0">
          <stop offset="0" stop-color="#14B8A6" />
          <stop offset="1" stop-color="#A78BFA" />
        </linearGradient>
      </defs>
      <g fill="url(#gsclaw-talon)" transform="translate(-3 7)">
        <path d="M88 406Q88 424 106 424L162 424Q180 424 180 406C184 330.5 190.6 274.4 184.6 254C120.2 288 82 339 88 406Z" />
        <path d="M210 406Q210 424 228 424L284 424Q302 424 302 406C306 282.1 312.6 197 306.6 166C242.2 217.6 204 295 210 406Z" />
        <path d="M332 406Q332 424 350 424L406 424Q424 424 424 406C428 231.5 434.6 116 428.6 74C364.2 144 326 249 332 406Z" />
      </g>
    </svg>
  );
}
