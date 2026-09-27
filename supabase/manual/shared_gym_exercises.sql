-- Pool condiviso di esercizi per tutti gli account autenticati.
-- Eseguire nel SQL Editor DOPO la migrazione 20260927230000_shared_exercise_catalog.sql.
-- Non modifica esercizi personali, programmi o diario. Rieseguibile: aggiunge solo i template mancanti.
-- Il carico dei manubri e' il peso di UN manubrio; i carichi di bilancieri/macchine sono totali.
-- Serie, ripetizioni previste e recupero si configurano nei programmi, non nel catalogo.

begin;

with suggested(name, variant, equipment, load_convention, measurement_mode, per_side) as (
    values
      -- Gambe e glutei
      ('Squat con bilanciere', 'Back squat', 'Bilanciere', 'total', 'reps', false),
      ('Squat frontale', 'Front squat', 'Bilanciere', 'total', 'reps', false),
      ('Goblet squat', '', 'Manubrio', 'single-dumbbell', 'reps', false),
      ('Pressa 45°', '', 'Pressa', 'total', 'reps', false),
      ('Hack squat', '', 'Macchina hack squat', 'total', 'reps', false),
      ('Affondi in camminata', '', 'Manubri', 'single-dumbbell', 'reps', true),
      ('Affondi indietro', '', 'Manubri', 'single-dumbbell', 'reps', true),
      ('Split squat bulgaro', '', 'Manubri', 'single-dumbbell', 'reps', true),
      ('Step-up', '', 'Manubri', 'single-dumbbell', 'reps', true),
      ('Leg extension', '', 'Macchina leg extension', 'total', 'reps', false),
      ('Leg curl seduto', '', 'Macchina leg curl', 'total', 'reps', false),
      ('Leg curl sdraiato', '', 'Macchina leg curl', 'total', 'reps', false),
      ('Stacco da terra', 'Convenzionale', 'Bilanciere', 'total', 'reps', false),
      ('Stacco sumo', '', 'Bilanciere', 'total', 'reps', false),
      ('Stacco rumeno', '', 'Bilanciere', 'total', 'reps', false),
      ('Stacco rumeno', 'Manubri', 'Manubri', 'single-dumbbell', 'reps', false),
      ('Hip thrust', '', 'Bilanciere', 'total', 'reps', false),
      ('Glute bridge', '', 'Corpo libero', 'bodyweight', 'reps', false),
      ('Abduzioni dell’anca', '', 'Macchina abduttori', 'total', 'reps', false),
      ('Adduzioni dell’anca', '', 'Macchina adduttori', 'total', 'reps', false),
      ('Calf raise in piedi', '', 'Macchina polpacci', 'total', 'reps', false),
      ('Calf raise seduto', '', 'Macchina polpacci', 'total', 'reps', false),
      -- Petto
      ('Panca piana', '', 'Bilanciere', 'total', 'reps', false),
      ('Panca inclinata', '', 'Bilanciere', 'total', 'reps', false),
      ('Panca piana', 'Manubri', 'Manubri', 'single-dumbbell', 'reps', false),
      ('Panca inclinata', 'Manubri', 'Manubri', 'single-dumbbell', 'reps', false),
      ('Chest press', '', 'Macchina chest press', 'total', 'reps', false),
      ('Croci ai cavi', '', 'Cavi', 'total', 'reps', false),
      ('Pec deck', '', 'Macchina pec deck', 'total', 'reps', false),
      ('Dip alle parallele', 'Petto', 'Parallele', 'bodyweight', 'reps', false),
      ('Piegamenti sulle braccia', '', 'Corpo libero', 'bodyweight', 'reps', false),
      -- Schiena
      ('Trazioni alla sbarra', 'Presa prona', 'Sbarra', 'bodyweight', 'reps', false),
      ('Trazioni alla sbarra', 'Presa supina', 'Sbarra', 'bodyweight', 'reps', false),
      ('Lat machine', 'Presa larga', 'Macchina lat machine', 'total', 'reps', false),
      ('Lat machine', 'Presa neutra', 'Macchina lat machine', 'total', 'reps', false),
      ('Lat machine', 'Presa supina', 'Macchina lat machine', 'total', 'reps', false),
      ('Rematore con bilanciere', '', 'Bilanciere', 'total', 'reps', false),
      ('Rematore con manubrio', 'Unilaterale', 'Manubrio', 'single-dumbbell', 'reps', true),
      ('Rematore al cavo', 'Seduto', 'Cavo basso', 'total', 'reps', false),
      ('Rematore con petto supportato', '', 'Macchina rematore', 'total', 'reps', false),
      ('Pulley basso', '', 'Cavo basso', 'total', 'reps', false),
      ('High row', '', 'Macchina high row', 'total', 'reps', false),
      ('Pulldown a braccia tese', '', 'Cavo alto', 'total', 'reps', false),
      ('Iperestensioni lombari', '', 'Panca romana', 'bodyweight', 'reps', false),
      -- Spalle
      ('Military press', '', 'Bilanciere', 'total', 'reps', false),
      ('Shoulder press', 'Manubri', 'Manubri', 'single-dumbbell', 'reps', false),
      ('Shoulder press', 'Macchina', 'Macchina shoulder press', 'total', 'reps', false),
      ('Alzate laterali', 'Manubri', 'Manubri', 'single-dumbbell', 'reps', false),
      ('Alzate laterali', 'Unilaterali al cavo', 'Cavo basso', 'total', 'reps', true),
      ('Alzate posteriori', '', 'Manubri', 'single-dumbbell', 'reps', false),
      ('Reverse pec deck', '', 'Macchina reverse pec deck', 'total', 'reps', false),
      ('Face pull', '', 'Cavo alto', 'total', 'reps', false),
      ('Scrollate', '', 'Manubri', 'single-dumbbell', 'reps', false),
      -- Braccia
      ('Curl con bilanciere', '', 'Bilanciere', 'total', 'reps', false),
      ('Curl con bilanciere EZ', '', 'Bilanciere EZ', 'total', 'reps', false),
      ('Curl alternato', '', 'Manubri', 'single-dumbbell', 'reps', true),
      ('Curl a martello', '', 'Manubri', 'single-dumbbell', 'reps', false),
      ('Curl su panca inclinata', '', 'Manubri', 'single-dumbbell', 'reps', false),
      ('Curl al cavo', '', 'Cavo basso', 'total', 'reps', false),
      ('Curl alla panca Scott', '', 'Panca Scott', 'total', 'reps', false),
      ('Pushdown tricipiti', 'Corda', 'Cavo alto', 'total', 'reps', false),
      ('Pushdown tricipiti', 'Barra', 'Cavo alto', 'total', 'reps', false),
      ('Estensioni tricipiti sopra la testa', '', 'Cavo alto', 'total', 'reps', false),
      ('French press', '', 'Bilanciere EZ', 'total', 'reps', false),
      ('Dip alle parallele', 'Tricipiti', 'Parallele', 'bodyweight', 'reps', false),
      -- Addome e stabilita'
      ('Crunch', '', 'Corpo libero', 'bodyweight', 'reps', false),
      ('Crunch al cavo', '', 'Cavo alto', 'total', 'reps', false),
      ('Plank', '', 'Corpo libero', 'bodyweight', 'seconds', false),
      ('Plank laterale', '', 'Corpo libero', 'bodyweight', 'seconds', true),
      ('Sollevamento gambe alla sbarra', '', 'Sbarra', 'bodyweight', 'reps', false),
      ('Sollevamento ginocchia alla sbarra', '', 'Sbarra', 'bodyweight', 'reps', false),
      ('Pallof press', '', 'Cavo', 'total', 'reps', true),
      ('Dead bug', '', 'Corpo libero', 'bodyweight', 'reps', true),
      -- Cardio a tempo
      ('Camminata su tapis roulant', '', 'Tapis roulant', 'bodyweight', 'seconds', false),
      ('Cyclette', '', 'Cyclette', 'bodyweight', 'seconds', false),
      ('Vogatore', '', 'Vogatore', 'bodyweight', 'seconds', false)
  ), prepared as (
    select s.*,
      pg_catalog.md5('shared-gym-v1|' || s.name || '|' || s.variant || '|'
        || s.equipment || '|' || s.load_convention || '|' || s.measurement_mode || '|' || s.per_side::text)::uuid as id
    from suggested s
  ), inserted as (
    insert into public.shared_exercises
      (id, name, variant, equipment, load_convention, load_unit, measurement_mode, per_side, note)
    select s.id, s.name, s.variant, s.equipment, s.load_convention, 'kg', s.measurement_mode, s.per_side, ''
    from prepared s
    where not exists (
      select 1 from public.shared_exercises existing
      where existing.id = s.id or (
        pg_catalog.lower(existing.name) = pg_catalog.lower(s.name)
        and pg_catalog.lower(existing.variant) = pg_catalog.lower(s.variant)
        and pg_catalog.lower(existing.equipment) = pg_catalog.lower(s.equipment)
        and existing.load_convention = s.load_convention
        and existing.load_unit = 'kg'
        and existing.measurement_mode = s.measurement_mode
        and existing.per_side = s.per_side
      )
    )
    on conflict (id) do nothing
    returning id
  )
select pg_catalog.count(*) as esercizi_aggiunti from inserted;

commit;
