/**
 * Proprietà di stile necessarie alla struttura: livello di struttura (titoli), numerazione
 * (elenchi) e testo nascosto. Nessun rendering: solo ciò che cambia blocchi e diagnostica.
 */
import { elementChildren, firstChild, type XmlElement } from './xml.ts'

interface RawStyle {
  type: string
  name: string
  basedOn: string | null
  outlineLevel: number | null
  numbered: boolean | null
  hidden: boolean | null
}

export interface ParagraphStyle { name: string; outlineLevel: number | null; numbered: boolean; hidden: boolean }

/** Proprietà on/off di WordprocessingML: presente senza valore significa attiva. */
export function onOff(element: XmlElement | undefined): boolean | null {
  if (!element) return null
  const value = element.attributes['w:val']
  return value === undefined || !['false', '0', 'off'].includes(value.toLowerCase())
}

export const attribute = (element: XmlElement | undefined, name = 'w:val'): string | undefined => element?.attributes[name]

export function integerAttribute(element: XmlElement | undefined, name = 'w:val'): number | null {
  const value = attribute(element, name)
  if (value === undefined || !/^-?\d{1,9}$/.test(value.trim())) return null
  return Number.parseInt(value, 10)
}

/** Numerazione diretta: true/false se dichiarata (numId 0 la disattiva), null se ereditata. */
export function numberingOf(pPr: XmlElement | undefined): boolean | null {
  const numPr = pPr && firstChild(pPr, 'w:numPr')
  const numId = numPr && firstChild(numPr, 'w:numId')
  if (!numId) return null
  const value = attribute(numId)
  return value !== undefined && value.trim() !== '0'
}

const MAX_STYLE_CHAIN = 32

export class StyleSheet {
  private readonly styles = new Map<string, RawStyle>()
  private readonly defaultParagraph: string | null
  private readonly defaultHidden: boolean

  constructor(root: XmlElement | null) {
    let defaultParagraph: string | null = null
    let defaultHidden = false
    if (root?.name === 'w:styles') {
      const docDefaults = firstChild(root, 'w:docDefaults')
      const rPrDefault = docDefaults && firstChild(docDefaults, 'w:rPrDefault')
      const defaultRPr = rPrDefault && firstChild(rPrDefault, 'w:rPr')
      defaultHidden = onOff(defaultRPr && firstChild(defaultRPr, 'w:vanish')) ?? false
      for (const style of elementChildren(root)) {
        if (style.name !== 'w:style') continue
        const id = style.attributes['w:styleId']
        if (!id || this.styles.has(id)) continue
        const type = style.attributes['w:type'] ?? 'paragraph'
        const pPr = firstChild(style, 'w:pPr')
        const rPr = firstChild(style, 'w:rPr')
        const outline = integerAttribute(pPr && firstChild(pPr, 'w:outlineLvl'))
        this.styles.set(id, {
          type,
          name: (attribute(firstChild(style, 'w:name')) ?? '').trim().toLowerCase(),
          basedOn: attribute(firstChild(style, 'w:basedOn')) ?? null,
          outlineLevel: outline,
          numbered: numberingOf(pPr),
          hidden: onOff(rPr && firstChild(rPr, 'w:vanish')),
        })
        const isDefault = style.attributes['w:default']
        if (type === 'paragraph' && isDefault !== undefined && !['false', '0', 'off'].includes(isDefault.toLowerCase())) defaultParagraph ??= id
      }
    }
    this.defaultParagraph = defaultParagraph
    this.defaultHidden = defaultHidden
  }

  /** Prima proprietà definita lungo la catena basedOn, con protezione dai cicli. */
  private inherited<K extends 'outlineLevel' | 'numbered' | 'hidden'>(styleId: string | null, key: K, type: string): RawStyle[K] | null {
    const seen = new Set<string>()
    let id = styleId
    for (let hops = 0; id !== null && hops < MAX_STYLE_CHAIN && !seen.has(id); hops++) {
      seen.add(id)
      const style = this.styles.get(id)
      if (!style || style.type !== type) return null
      if (style[key] !== null) return style[key]
      id = style.basedOn
    }
    return null
  }

  paragraph(styleId: string | undefined): ParagraphStyle {
    const id = styleId ?? this.defaultParagraph
    const style = id === null ? undefined : this.styles.get(id)
    return {
      name: style?.type === 'paragraph' ? style.name : '',
      outlineLevel: id === null ? null : this.inherited(id, 'outlineLevel', 'paragraph'),
      numbered: id === null ? false : this.inherited(id, 'numbered', 'paragraph') ?? false,
      hidden: (id === null ? null : this.inherited(id, 'hidden', 'paragraph')) ?? this.defaultHidden,
    }
  }

  /** Stile di carattere nascosto; null se lo stile non lo dichiara. */
  characterHidden(styleId: string | undefined): boolean | null {
    return styleId === undefined ? null : this.inherited(styleId, 'hidden', 'character')
  }
}
