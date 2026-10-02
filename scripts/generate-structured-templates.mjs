import { mkdir, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { buildDocx, para, tbl, tc, tr } from './lib/docx-fixtures.mjs'
import { markers, compilation, columns } from '../src/import/structured/parser.ts'

export const syntheticExamples = {
  workout: { title: 'Esempio sintetico forza', sections: {
    Allenamento: [['A', 'Squat esempio', '2', '8-10', '', '90', 'Terza facoltativa da S5.'], ['A', 'Plank esempio', '3', '', '30', '45', 'Respirazione regolare.'], ['B', 'Squat esempio', '3', '6', '', '120', 'Dose iniziale della seduta B.']],
    Istruzioni: [['Progressioni solo su indicazione: le dosi della tabella sono quelle iniziali.']],
  } },
  diet: { title: 'Esempio sintetico alimentazione', sections: {
    Giornate: [['Allenamento', 'Palestra'], ['Riposo', 'Riposo']],
    Alimenti: [['Allenamento', 'Colazione', 'Yogurt esempio', '170 g', 'Bianco.'], ['Allenamento', 'Colazione', 'Fiocchi esempio', '40 g', ''], ['Allenamento', 'Pranzo', 'Riso esempio', '80 g a crudo', ''], ['Riposo', 'Colazione', 'Pane esempio', '2 fette', ''], ['Riposo', 'Cena', 'Verdure esempio', '', 'Quantità non prescritta.']],
    Istruzioni: [['Gli esempi servono a compilare il modello; non costituiscono un piano personale.']],
    Alternative: [['Allenamento', 'Colazione', 'In alternativa allo yogurt esempio: latte esempio 200 ml.']],
    Aggiunte: [['Riposo', 'Cena', 'Solo se indicato: aggiungere olio esempio 10 g.']],
  } },
}
export function structuredDocx(kind, example = syntheticExamples[kind]) {
  const body = [para(markers[kind]), para(`Titolo: ${example.title}`, { style: 'Titolo' }), para(compilation[kind])]
  for (const [section, rows] of Object.entries(example.sections)) {
    body.push(para(section, { style: 'Titolo1' }))
    body.push(tbl(columns[section].length, [tr(columns[section].map(c => tc(c)), { header: true }), ...rows.map(row => tr(row.map(c => tc(c))))]))
  }
  return buildDocx({ body: body.join('') })
}
if (process.argv[1] === fileURLToPath(import.meta.url)) {
  await mkdir('public/templates', { recursive: true })
  for (const kind of ['workout', 'diet']) await writeFile(`public/templates/peppitness-${kind}-v1.docx`, structuredDocx(kind))
  console.log('Due template sintetici DOCX v1 generati.')
}
