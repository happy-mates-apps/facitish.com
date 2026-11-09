-- Administrative roles (app/admin_roles.py): an admin has one or more roles that decide which parts of /admin they
-- may use. 'fuld' is everything, as before; existing admins keep it. The column means nothing for role = 'user'.

alter table users add column admin_roles text[] not null default '{}'
    check (admin_roles <@ array['fuld', 'support', 'indhold', 'produkt', 'data', 'privatliv', 'drift']::text[]);

update users set admin_roles = '{fuld}' where role = 'admin';

-- An admin always has at least one role (new admins get 'fuld', as before), a user has none, and the super admin
-- always has 'fuld'. Kept in the database so every path that makes an admin (first login, /admin, MCP) agrees.
create function gaer_admin_roles_default() returns trigger language plpgsql as $$
begin
    if new.role = 'admin' then
        if coalesce(cardinality(new.admin_roles), 0) = 0 then
            new.admin_roles := '{fuld}';
        end if;
    else
        new.admin_roles := '{}';
    end if;
    if new.super_admin and not ('fuld' = any (new.admin_roles)) then
        new.admin_roles := new.admin_roles || '{fuld}'::text[];
    end if;
    return new;
end $$;

create trigger users_admin_roles before insert or update of role, admin_roles, super_admin on users
    for each row execute function gaer_admin_roles_default();
