/**
 * Mela con manubrio e battito in SVG inline: i colori vengono dai token
 * `--logo-body`, `--logo-detail` e `--logo-leaf`, uguali nel tema chiaro e in quello scuro.
 * Stessa geometria di `public/logo.svg`, che resta la fonte per favicon e icone dell'app.
 */
export function BrandLogo({ className = 'brand-logo', title }: { className?: string; title?: string }) {
  return <svg className={className} viewBox="0 0 128 128" width="128" height="128" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
    <path className="logo-body" d="M64 38C54 30 36 30 28 46C18 64 24 94 40 108C48 114 56 112 64 108C72 112 80 114 88 108C104 94 110 64 100 46C92 30 74 30 64 38Z" />
    <path className="logo-body-stroke" fill="none" strokeWidth="6" strokeLinecap="round" d="M64 38C64 30 67 23 73 18" />
    <path className="logo-leaf" d="M70 27C70 14 82 9 94 11C94 23 83 30 70 27Z" />
    <g className="logo-detail">
      <rect x="40" y="55" width="9" height="38" rx="4" /><rect x="31" y="62" width="7" height="24" rx="3.5" />
      <rect x="79" y="55" width="9" height="38" rx="4" /><rect x="90" y="62" width="7" height="24" rx="3.5" />
    </g>
    <path className="logo-detail-stroke" fill="none" strokeWidth="5" strokeLinecap="round" strokeLinejoin="round" d="M49 74H56L60 63L67 87L71 74H79" />
  </svg>
}
