-- Solo stack locale: tutti i dati sintetici vengono annullati.
begin;
create extension if not exists pgtap with schema extensions;
set local search_path=public,extensions,pg_catalog;
select no_plan();
insert into auth.users(id,aud,role,email) values
 ('15111111-1111-4111-8111-111111111111','authenticated','authenticated','meal-period-a@example.invalid'),
 ('15222222-2222-4222-8222-222222222222','authenticated','authenticated','meal-period-b@example.invalid');
set local role authenticated;
select set_config('request.jwt.claim.sub','15111111-1111-4111-8111-111111111111',true);
insert into public.meal_plans(id,name,document) values ('15000000-0000-4000-8000-000000000001','Piano test',
 '{"guidance":"","days":[{"id":"15000000-0000-4000-8000-000000000002","name":"Ogni giorno","dayType":"any","note":"","meals":[{"id":"15000000-0000-4000-8000-000000000003","name":"Colazione","time":"","foods":[{"name":"Alimento","quantity":"100 g"}],"alternatives":[],"additions":[],"note":""}]}]}');
select is((select revision::integer from meal_plans where id='15000000-0000-4000-8000-000000000001'),1,'Legacy V1 salvabile senza metadati');
select lives_ok($$update meal_plans set document=document||'{"cycle":{"start":"2026-10-02","weeks":4},"dailyCalories":2000}'::jsonb,revision=2 where id='15000000-0000-4000-8000-000000000001'$$,'Periodo e target salvabili');
select is((select (document#>>'{cycle,weeks}')::integer from meal_plans where id='15000000-0000-4000-8000-000000000001'),4,'Durata persistita');
select is((select (document->>'dailyCalories')::integer from meal_plans where id='15000000-0000-4000-8000-000000000001'),2000,'Target persistito');
select throws_ok($$update meal_plans set revision=3,document=jsonb_set(document,'{cycle,start}','"2026-02-30"') where id='15000000-0000-4000-8000-000000000001'$$,'23514','Invalid meal plan period','Data inesistente respinta');
select throws_ok($$update meal_plans set revision=3,document=jsonb_set(document,'{cycle,weeks}','53') where id='15000000-0000-4000-8000-000000000001'$$,'23514','Invalid meal plan period','Oltre 52 settimane respinto');
select throws_ok($$update meal_plans set revision=3,document=jsonb_set(document,'{cycle}','{"start":"2100-12-31","weeks":1}') where id='15000000-0000-4000-8000-000000000001'$$,'23514','Invalid meal plan period end','Fine periodo oltre limite respinta');
select throws_ok($$update meal_plans set revision=3,document=jsonb_set(document,'{cycle}','{"start":"2026-10-02","weeks":4,"extra":1}') where id='15000000-0000-4000-8000-000000000001'$$,'23514','Invalid meal plan period','Chiave periodo estranea respinta');
select throws_ok($$update meal_plans set revision=3,document=jsonb_set(document,'{dailyCalories}','"2000"') where id='15000000-0000-4000-8000-000000000001'$$,'23514','Invalid daily calorie target','Target testuale respinto');
select throws_ok($$update meal_plans set revision=3,document=jsonb_set(document,'{dailyCalories}','0') where id='15000000-0000-4000-8000-000000000001'$$,'23514','Invalid daily calorie target','Target zero respinto');
select throws_ok($$update meal_plans set revision=3,document=jsonb_set(document,'{dailyCalories}','20000.1') where id='15000000-0000-4000-8000-000000000001'$$,'23514','Invalid daily calorie target','Target non intero respinto');
select lives_ok($$update meal_plans set revision=3,document=jsonb_set(document,'{days,0,meals,0,foods,0,kcalPer100g}','200.5') where id='15000000-0000-4000-8000-000000000001'$$,'Valore confezione decimale salvabile');
select throws_ok($$update meal_plans set revision=4,document=jsonb_set(document,'{days,0,meals,0,foods,0,kcalPer100g}','1001') where id='15000000-0000-4000-8000-000000000001'$$,'23514','Invalid food energy','Energia alimento fuori limite respinta');
select lives_ok($$insert into meal_logs(diary_date,meal_id,meal_plan_id,status,note,day_type,meal_snapshot) values('2026-10-02','15000000-0000-4000-8000-000000000003','15000000-0000-4000-8000-000000000001','followed','','rest','{"id":"15000000-0000-4000-8000-000000000003","name":"Colazione","items":["Alimento · 100 g"],"energy":{"version":1,"kcal":200,"missing":0},"energyOverrides":[200]}')$$,'Snapshot energetico salvabile');
select is((select (meal_snapshot#>>'{energy,kcal}')::integer from meal_logs where diary_date='2026-10-02'),200,'Calorie snapshot persistite');
select throws_ok($$update meal_logs set revision=2,meal_snapshot=jsonb_set(meal_snapshot,'{energy,kcal}','201') where diary_date='2026-10-02'$$,'42501','permission denied for table meal_logs','Utente senza permesso di riscrivere energia annotata');
reset role;
select throws_ok($$update meal_logs set revision=2,meal_snapshot=jsonb_set(meal_snapshot,'{energy,kcal}','201') where diary_date='2026-10-02'$$,'23514','Meal log context cannot change','Trigger conserva energia annotata anche con privilegi maggiori');
set local role authenticated;
select lives_ok($$update meal_logs set revision=2,status='skipped' where diary_date='2026-10-02'$$,'Stato modificabile senza riscrivere energia');
select throws_ok($$insert into meal_logs(diary_date,meal_id,meal_plan_id,status,note,day_type,meal_snapshot) values('2026-10-03','15000000-0000-4000-8000-000000000003','15000000-0000-4000-8000-000000000001','followed','','rest','{"id":"15000000-0000-4000-8000-000000000003","name":"Colazione","energy":{"version":1,"missing":0}}')$$,'23514','Invalid meal energy snapshot','Snapshot senza kcal respinto');
select throws_ok($$insert into meal_logs(diary_date,meal_id,meal_plan_id,status,note,day_type,meal_snapshot) values('2026-10-03','15000000-0000-4000-8000-000000000003','15000000-0000-4000-8000-000000000001','followed','','rest','{"id":"15000000-0000-4000-8000-000000000003","name":"Colazione","energy":{"version":2,"kcal":200,"missing":0}}')$$,'23514','Invalid meal energy snapshot','Versione energetica sconosciuta respinta');
select throws_ok($$insert into meal_logs(diary_date,meal_id,meal_plan_id,status,note,day_type,meal_snapshot) values('2026-10-03','15000000-0000-4000-8000-000000000003','15000000-0000-4000-8000-000000000001','followed','','rest','{"id":"15000000-0000-4000-8000-000000000003","name":"Colazione","items":["Alimento"],"energyOverrides":[-1]}')$$,'23514','Invalid meal energy override','Override negativo respinto');
select lives_ok($$insert into meal_logs(diary_date,meal_id,meal_plan_id,status,note,day_type,meal_snapshot) values('2026-10-03','15000000-0000-4000-8000-000000000003','15000000-0000-4000-8000-000000000001','followed','','rest','{"id":"15000000-0000-4000-8000-000000000003","name":"Colazione"}')$$,'Snapshot storico senza energia valido');
select lives_ok($$update meal_plans set document=jsonb_set(jsonb_set(document,'{cycle}','null'),'{dailyCalories}','null'),revision=4 where id='15000000-0000-4000-8000-000000000001'$$,'Periodo e target cancellabili esplicitamente');
select is((select (meal_snapshot#>>'{energy,kcal}')::integer from meal_logs where diary_date='2026-10-02'),200,'Modifica piano conserva snapshot');
select set_config('request.jwt.claim.sub','15222222-2222-4222-8222-222222222222',true);
select is((select count(*)::integer from meal_plans where id='15000000-0000-4000-8000-000000000001'),0,'Piano isolato da B');
select is((select count(*)::integer from meal_logs where meal_plan_id='15000000-0000-4000-8000-000000000001'),0,'Stime annotate isolate da B');
reset role;
select ok(not has_function_privilege('authenticated','peppitness_private.meal_energy_number(jsonb,numeric,numeric,boolean)','execute'),'Helper non esposto');
select ok(not has_function_privilege('anon','peppitness_private.meal_period_date(jsonb)','execute'),'Anonimo senza helper');
select * from finish();
rollback;
