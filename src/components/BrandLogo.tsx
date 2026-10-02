/**
 * Monogramma P con foglia in SVG inline: i colori vengono dai token
 * `--logo-body` e `--logo-detail`, così resta leggibile sia nel tema chiaro sia in quello scuro.
 * Stessa geometria di `public/logo.svg`, che resta la fonte per favicon e icone dell'app.
 */
export function BrandLogo({ className = 'brand-logo', title }: { className?: string; title?: string }) {
  return <svg className={className} viewBox="0 0 128 128" width="128" height="128" role={title ? 'img' : undefined} aria-label={title} aria-hidden={title ? undefined : true} focusable="false">
    <path className="logo-body" fillRule="evenodd" d="M28 106V38c0-12 10-22 22-22h20c24 0 40 16 40 38S94 92 70 92H52v14c0 7-5 12-12 12s-12-5-12-12ZM52 40v28h17c11 0 17-5 17-14s-6-14-17-14H52Z" />
    <path className="logo-detail" d="M55 65c0-16 9-23 28-23 0 16-9 23-28 23Z" />
  </svg>
}
