import type { MealFood } from '../domain/meal-plans'
import { useId } from 'react'
import { estimateFoods } from '../domain/food-energy'

export function FoodEnergyPreview({ foods, onChange }: { foods: MealFood[]; onChange?: (foods: MealFood[]) => void }) {
  const prefix = useId()
  const result = estimateFoods(foods), { kcal, missing } = result.energy
  return <section className="food-energy-info" aria-label="Stima calorie del pasto">
    <p className="meal-kcal">{kcal === null ? 'Calorie da stimare' : `≈ ${kcal} kcal`}{missing > 0 && kcal !== null ? ' · stima parziale' : ''}</p>
    <details className="energy-details"><summary>Come vengono stimate{onChange ? ' · correggi i valori' : ''}</summary>
      <p className="small muted">Valori di riferimento per alimenti generici. Pasta e riso si intendono a crudo, carne e pesce come specificato sotto. Marche e preparazioni possono differire; alternative e aggiunte non vengono conteggiate automaticamente.</p>
      <ul className="energy-source-list">{result.foods.map((food, i) => <li key={i}><strong>{food.name}</strong><span>{food.kcal === null ? food.issue : `≈ ${Math.round(food.kcal)} kcal · ${food.reference}`}</span>{food.assumption && <small>{food.assumption}</small>}{food.sourceUrl && <a href={food.sourceUrl} target="_blank" rel="noopener noreferrer">Valore di riferimento</a>}{onChange && <label htmlFor={`${prefix}-food-energy-${i}`}>kcal per 100 g dalla confezione (facoltative)<input id={`${prefix}-food-energy-${i}`} type="number" min={0} max={1000} step="any" value={foods[i]?.kcalPer100g ?? ''} onChange={e => onChange(foods.map((item, index) => index === i ? { ...item, kcalPer100g: e.target.value === '' ? null : Number(e.target.value) } : item))} /></label>}</li>)}</ul>
    </details>
  </section>
}

