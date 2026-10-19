insert into auth.users(id,email) values
 ('b9600000-0000-4000-8f78-000000000001','import-race-a@test.local'),
 ('b9600000-0000-4000-8f78-000000000002','import-race-b@test.local');
insert into public.user_roles(user_id,role_id) select u.id,r.id from auth.users u cross join public.app_roles r
 where u.id in ('b9600000-0000-4000-8f78-000000000001','b9600000-0000-4000-8f78-000000000002') and r.code='accountant';
insert into public.counterparties(id,roles,legal_name,country,tax_id) values
 ('b9700000-0000-4000-8f78-000000000001',array['customer'],'Import Race Synthetic','KZ','990000001078');
