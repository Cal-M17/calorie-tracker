-- Plate tracker: Supabase schema. Run once in the SQL editor (Supabase dashboard > SQL Editor).
-- Model: one household shared by both of you. Foods, recipes, diary entries, settings, goals and weights
-- are all usable by anyone in the household, so one person can track for both profiles.

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null default 'Home',
  created_at timestamptz not null default now()
);

create table public.household_members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  display_name text not null,
  primary key (household_id, user_id)
);

create table public.user_settings (
  user_id uuid primary key references auth.users(id) on delete cascade,
  calorie_target int not null default 2000,
  macro_targets jsonb not null default '{}'::jsonb,
  nutrient_targets jsonb not null default '{}'::jsonb,
  goal jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

-- Nutrition values are per 100 g. Optional label nutrients are null when unknown.
create table public.foods (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  kcal numeric not null default 0,
  protein numeric not null default 0,
  carbs numeric not null default 0,
  fat numeric not null default 0,
  fibre numeric,
  sugars numeric,
  saturates numeric,
  salt numeric,
  serving_g numeric,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recipes (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  name text not null,
  cooked_weight_g numeric,
  servings numeric not null default 1,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.recipe_ingredients (
  id uuid primary key default gen_random_uuid(),
  recipe_id uuid not null references public.recipes(id) on delete cascade,
  food_id uuid not null references public.foods(id) on delete restrict,
  grams numeric not null check (grams > 0),
  sort int not null default 0
);

-- Diary entries store a snapshot of the nutrition at the time of logging.
create table public.entries (
  id uuid primary key default gen_random_uuid(),
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null references auth.users(id) on delete cascade,
  entry_date date not null,
  meal text not null default 'Snacks' check (meal in ('Breakfast','Lunch','Dinner','Snacks')),
  name text not null,
  label text,
  grams numeric,
  kcal numeric not null default 0,
  protein numeric not null default 0,
  carbs numeric not null default 0,
  fat numeric not null default 0,
  fibre numeric,
  sugars numeric,
  saturates numeric,
  salt numeric,
  incomplete jsonb,
  food_id uuid references public.foods(id) on delete set null,
  recipe_id uuid references public.recipes(id) on delete set null,
  created_at timestamptz not null default now()
);

create table public.weights (
  user_id uuid not null references auth.users(id) on delete cascade,
  weigh_date date not null,
  kg numeric not null check (kg > 0),
  primary key (user_id, weigh_date)
);

create index entries_user_date on public.entries (user_id, entry_date);
create index entries_household_date on public.entries (household_id, entry_date);
create index foods_household on public.foods (household_id);
create index recipes_household on public.recipes (household_id);
create index recipe_ingredients_recipe on public.recipe_ingredients (recipe_id);

-- Row level security: this is what keeps the data private, because the public key ships in the web page.
create or replace function public.in_household(h uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.household_members m
    where m.household_id = h and m.user_id = auth.uid()
  );
$$;

alter table public.households enable row level security;
alter table public.household_members enable row level security;
alter table public.user_settings enable row level security;
alter table public.foods enable row level security;
alter table public.recipes enable row level security;
alter table public.recipe_ingredients enable row level security;
alter table public.entries enable row level security;
alter table public.weights enable row level security;

create policy "members read household" on public.households
  for select using (public.in_household(id));
create policy "members read members" on public.household_members
  for select using (public.in_household(household_id));

-- Settings and weights: you can use your own, and anyone in your household can use theirs too
-- (so one person can track for both profiles).
create or replace function public.shares_household(u uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select u = auth.uid() or exists (
    select 1 from public.household_members a
    join public.household_members b on a.household_id = b.household_id
    where a.user_id = auth.uid() and b.user_id = u
  );
$$;
create policy "household settings" on public.user_settings
  for all using (public.shares_household(user_id)) with check (public.shares_household(user_id));
create policy "household weights" on public.weights
  for all using (public.shares_household(user_id)) with check (public.shares_household(user_id));

create policy "household foods" on public.foods
  for all using (public.in_household(household_id)) with check (public.in_household(household_id));
create policy "household recipes" on public.recipes
  for all using (public.in_household(household_id)) with check (public.in_household(household_id));
create policy "household recipe ingredients" on public.recipe_ingredients
  for all using (exists (select 1 from public.recipes r where r.id = recipe_id and public.in_household(r.household_id)))
  with check (exists (select 1 from public.recipes r where r.id = recipe_id and public.in_household(r.household_id)));

-- Entries: anyone in the household can read and write, but the entry must belong to a household member.
create policy "household entries" on public.entries
  for all using (public.in_household(household_id))
  with check (
    public.in_household(household_id)
    and exists (select 1 from public.household_members m where m.household_id = entries.household_id and m.user_id = entries.user_id)
  );

-- ONE-OFF SETUP: after you have both created accounts (see README), edit the two emails and run this block.
-- with h as (insert into public.households (name) values ('Home') returning id),
-- m as (
--   insert into public.household_members (household_id, user_id, display_name)
--   select h.id, u.id, case u.email when 'YOUR_EMAIL' then 'Me' else 'Partner' end
--   from h, auth.users u where u.email in ('YOUR_EMAIL', 'PARTNER_EMAIL')
--   returning user_id
-- )
-- insert into public.user_settings (user_id) select user_id from m;
