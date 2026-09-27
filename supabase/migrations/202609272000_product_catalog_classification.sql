-- Product catalogue classification and filter indexes.

alter table public.products
  add column if not exists category text not null default 'Прочее';

update public.products
set category = case
  when lower(name ->> 'ru') ~ '(ирис|конфет|пралине|трюфел|драже|батончик|адвент-календар)' then 'Конфеты'
  when lower(name ->> 'ru') ~ '(мармелад)' then 'Мармелад'
  when lower(name ->> 'ru') ~ '(шоколад)' and lower(name ->> 'ru') !~ '(паста|крем)' then 'Шоколад'
  when lower(name ->> 'ru') ~ '(печенье|крекер|вафл|сухар|хлебц)' then 'Печенье и снеки'
  when lower(name ->> 'ru') ~ '(паста|крем)' then 'Пасты и кремы'
  when lower(name ->> 'ru') ~ '(смузи|напиток|тоник)' then 'Напитки'
  when lower(name ->> 'ru') ~ '(вода)' then 'Вода'
  else 'Прочее'
end
where category = 'Прочее';

alter table public.products
  drop constraint if exists products_category_nonempty;
alter table public.products
  add constraint products_category_nonempty check (length(trim(category)) between 1 and 100);

create index if not exists products_category_idx on public.products(category);
create index if not exists products_brand_lower_idx on public.products(lower(brand)) where brand is not null;

comment on column public.products.category is 'Business catalogue category used for filtering and nested product navigation';
