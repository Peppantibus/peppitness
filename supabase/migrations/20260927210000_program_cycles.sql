-- Ciclo del programma: data di inizio e durata in settimane (entrambe presenti o entrambe assenti).
-- La settimana tipo si ripete per tutta la durata; nessuna copia dei giorni. Programmi esistenti invariati.
alter table public.workout_plans
  add column cycle_start date,
  add column cycle_weeks smallint check (cycle_weeks between 1 and 52),
  add constraint workout_plans_cycle_complete check ((cycle_start is null) = (cycle_weeks is null)),
  add constraint workout_plans_cycle_range check (cycle_start is null or cycle_start between date '2000-01-01' and date '2200-01-01');

-- Modifica diretta con revisione letta + 1 (trigger stamp_record gia presente), solo proprietario.
grant update(cycle_start, cycle_weeks) on public.workout_plans to authenticated;

comment on column public.workout_plans.cycle_start is 'Primo giorno del ciclo; la Scheda calcola la settimana corrente da qui.';
comment on column public.workout_plans.cycle_weeks is 'Durata del ciclo in settimane (1-52).';
