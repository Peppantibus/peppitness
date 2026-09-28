/**
 * Marchio (manubrio con viso e pizzetto) in SVG inline: i colori vengono dai token
 * `--logo-body` e `--logo-detail`, così resta leggibile sia nel tema chiaro sia in quello scuro.
 * Stessa geometria di `public/logo.svg`, che resta la fonte per favicon e icone dell'app.
 */
export function BrandLogo({ className = 'brand-logo', title }: { className?: string; title?: string }) {
  return <svg className={className} viewBox="0 0 128 104" width="128" height="104" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
    <g className="logo-body">
      <rect x="6" y="34" width="13" height="34" rx="5" />
      <rect x="22" y="22" width="19" height="58" rx="7" />
      <rect x="87" y="22" width="19" height="58" rx="7" />
      <rect x="109" y="34" width="13" height="34" rx="5" />
      <rect x="36" y="43" width="56" height="16" rx="5" />
      <rect x="46" y="33" width="36" height="39" rx="12" />
      <path d="M54 69h20v9c0 7-6 12-10 16-4-4-10-9-10-16v-9Z" />
    </g>
    <g className="logo-detail">
      <rect x="28" y="31" width="4" height="39" rx="2" />
      <rect x="93" y="31" width="4" height="39" rx="2" />
      <circle cx="57" cy="48" r="2.5" />
      <circle cx="71" cy="48" r="2.5" />
      <path d="M61 73h6v6l-3 5-3-5v-6Z" />
    </g>
    <path className="logo-smile" d="M58 58c3 3 9 3 12 0" strokeWidth="3" strokeLinecap="round" fill="none" />
  </svg>
}
