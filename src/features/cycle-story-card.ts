interface CardContent {
  program: string
  range: string
  metrics: { label: string; value: string }[]
  detail: string
}

export function saveCycleStoryCard({ program, range, metrics, detail }: CardContent): boolean {
  const canvas = document.createElement('canvas')
  canvas.width = 960
  canvas.height = 1200
  const context = canvas.getContext('2d')
  if (!context) return false

  const ink = '#172921', lime = '#e2f582', lilac = '#d3c7f3', cream = '#fff7e7'
  context.fillStyle = ink
  context.fillRect(0, 0, canvas.width, canvas.height)
  context.lineWidth = 26
  context.strokeStyle = '#315046'
  for (const radius of [252, 310, 368]) {
    context.beginPath()
    context.arc(938, 86, radius, 0, Math.PI * 2)
    context.stroke()
  }

  const text = (value: string, x: number, y: number, font: string, color: string, width = 816) => {
    context.fillStyle = color
    context.font = font
    context.fillText(value, x, y, width)
  }
  text('peppitness.', 72, 110, '800 39px system-ui', lilac)
  text('Il tuo ciclo.', 72, 262, '800 126px system-ui', cream)
  text(program, 74, 340, '650 39px system-ui', cream)
  text(range, 74, 402, '500 30px system-ui', lilac)

  for (const [index, { label, value }] of metrics.entries()) {
    const y = 485 + index * 158
    context.fillStyle = index === 1 ? lilac : lime
    context.fillRect(72, y, 816, 128)
    text(value, 105, y + 87, '800 68px system-ui', ink, 240)
    text(label, 375, y + 79, '650 30px system-ui', ink, 470)
  }
  if (detail) text(detail, 74, 1070, '650 31px system-ui', cream)

  try {
    const link = document.createElement('a')
    link.download = 'peppitness-il-tuo-ciclo.png'
    link.href = canvas.toDataURL('image/png')
    document.body.append(link)
    link.click()
    link.remove()
    return true
  } catch {
    return false
  }
}
