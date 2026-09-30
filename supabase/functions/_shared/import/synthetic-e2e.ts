// Frozen synthetic provider answers for task 24; reachable only through the loopback-gated test transport.
// No runtime fixture imports, network, or user-controlled ready payload. Kept equal to tests/fixtures/import/e2e/*.json by tests/import-e2e-fixtures.test.ts.
export const e2eProposals = {
  "workout": {
    "schemaVersion": "1.0",
    "kind": "workout",
    "outcome": "extracted",
    "title": "Scheda E2E sintetica",
    "guidance": [],
    "schedule": "unknown",
    "cycle": {
      "startDate": null,
      "weeks": null
    },
    "sessions": [
      {
        "label": "A",
        "title": "Seduta A",
        "weekday": null,
        "notes": [],
        "exercises": [
          {
            "name": "Squat",
            "variant": null,
            "equipment": null,
            "measurementMode": "reps",
            "sets": 3,
            "optionalSets": null,
            "repetitions": {
              "min": 8,
              "max": 10
            },
            "durationSeconds": null,
            "restSeconds": null,
            "rir": null,
            "rpe": null,
            "perSide": null,
            "loadUnit": null,
            "loadConvention": null,
            "loadInstruction": null,
            "tempoInstruction": null,
            "prescriptionText": "Squat | 3 x 8-10 | recupero non indicato",
            "notes": []
          }
        ]
      }
    ],
    "complexRules": [],
    "evidence": [
      {
        "path": "/title",
        "spans": [
          {
            "blockId": "p:1",
            "quote": "Scheda E2E sintetica"
          }
        ]
      },
      {
        "path": "/sessions/0/label",
        "spans": [
          {
            "blockId": "p:2",
            "quote": "Seduta A"
          }
        ]
      },
      {
        "path": "/sessions/0/title",
        "spans": [
          {
            "blockId": "p:2",
            "quote": "Seduta A"
          }
        ]
      },
      {
        "path": "/sessions/0/exercises/0/name",
        "spans": [
          {
            "blockId": "t:1:r:1",
            "quote": "Squat"
          }
        ]
      },
      {
        "path": "/sessions/0/exercises/0/measurementMode",
        "spans": [
          {
            "blockId": "t:1:r:1",
            "quote": "3 x 8-10"
          }
        ]
      },
      {
        "path": "/sessions/0/exercises/0/sets",
        "spans": [
          {
            "blockId": "t:1:r:1",
            "quote": "3 x 8-10"
          }
        ]
      },
      {
        "path": "/sessions/0/exercises/0/repetitions",
        "spans": [
          {
            "blockId": "t:1:r:1",
            "quote": "3 x 8-10"
          }
        ]
      },
      {
        "path": "/sessions/0/exercises/0/prescriptionText",
        "spans": [
          {
            "blockId": "t:1:r:1",
            "quote": "Squat | 3 x 8-10 | recupero non indicato"
          }
        ]
      }
    ],
    "issues": [
      {
        "code": "missing",
        "path": "/sessions/0/exercises/0/restSeconds",
        "sourceRefs": [
          "t:1:r:1"
        ],
        "message": "Recupero non indicato nella fonte."
      }
    ],
    "unassigned": []
  },
  "diet": {
    "schemaVersion": "1.0",
    "kind": "diet",
    "outcome": "extracted",
    "title": "Dieta E2E sintetica",
    "guidance": [],
    "days": [
      {
        "name": "Giorno 1",
        "dayType": null,
        "notes": [],
        "meals": [
          {
            "name": "Colazione",
            "timeText": null,
            "foods": [
              {
                "name": "yogurt bianco",
                "quantityText": null,
                "notes": []
              }
            ],
            "alternatives": [
              "In alternativa allo yogurt: latte 200 ml."
            ],
            "additions": [],
            "notes": []
          }
        ]
      }
    ],
    "globalRules": [
      {
        "kind": "addition",
        "text": "Nei giorni di allenamento lungo aggiungere 20 g di frutta secca a scelta.",
        "sourceRefs": [
          "global"
        ]
      }
    ],
    "evidence": [
      {
        "path": "/title",
        "spans": [
          {
            "blockId": "p:1",
            "quote": "Dieta E2E sintetica"
          }
        ]
      },
      {
        "path": "/days/0/name",
        "spans": [
          {
            "blockId": "p:2",
            "quote": "Giorno 1"
          }
        ]
      },
      {
        "path": "/days/0/meals/0/name",
        "spans": [
          {
            "blockId": "p:3",
            "quote": "Colazione"
          }
        ]
      },
      {
        "path": "/days/0/meals/0/foods/0/name",
        "spans": [
          {
            "blockId": "p:3",
            "quote": "yogurt bianco"
          }
        ]
      },
      {
        "path": "/days/0/meals/0/alternatives/0",
        "spans": [
          {
            "blockId": "p:3",
            "quote": "In alternativa allo yogurt: latte 200 ml."
          }
        ]
      },
      {
        "path": "/globalRules/0/text",
        "spans": [
          {
            "blockId": "global",
            "quote": "Nei giorni di allenamento lungo aggiungere 20 g di frutta secca a scelta."
          }
        ]
      }
    ],
    "issues": [],
    "unassigned": []
  }
} as const
export function e2eExtraction(kind: 'workout' | 'diet', blocks: readonly { id: string; text: string }[]): unknown | null {
  if (!blocks.some(b => b.text === e2eProposals[kind].title)) return null
  const value = JSON.parse(JSON.stringify(e2eProposals[kind]))
  const refs = new Map<string, string>()
  for (const entry of value.evidence) for (const span of entry.spans) {
    const block = blocks.find(b => b.text.includes(span.quote))
    if (!block) throw new Error('Incomplete synthetic E2E source')
    refs.set(span.blockId, block.id)
    span.blockId = block.id
  }
  for (const issue of value.issues) issue.sourceRefs = issue.sourceRefs.map((id: string) => refs.get(id) ?? id)
  for (const rule of value.globalRules ?? []) rule.sourceRefs = rule.sourceRefs.map((id: string) => refs.get(id) ?? id)
  return value
}
