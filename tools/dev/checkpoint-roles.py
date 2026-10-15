"""Pinned fresh-cluster role policy; pure SQL construction, no runtime access."""
import re

BOOTSTRAP = 'smartlearning_dev_owner'
MIGRATION = 'smartlearning_dev_migrator'
APPLICATION = 'smartlearning_dev_app'
DATABASE = 'smartlearning_dev'


def setup(migration_password, application_password):
    for password in (migration_password, application_password):
        if not isinstance(password, str) or not re.fullmatch('[0-9a-f]{64}', password):
            raise ValueError('Invalid role credential')
    if migration_password == application_password:
        raise ValueError('Role credentials must differ')
    return f"""
SET log_statement = 'none';
SET log_min_error_statement = 'panic';
BEGIN;
CREATE ROLE {MIGRATION} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '{migration_password}';
CREATE ROLE {APPLICATION} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS NOINHERIT PASSWORD '{application_password}';
REVOKE ALL ON DATABASE {DATABASE} FROM PUBLIC;
REVOKE ALL ON DATABASE postgres FROM PUBLIC;
REVOKE ALL ON DATABASE template1 FROM PUBLIC;
ALTER DATABASE {DATABASE} OWNER TO {MIGRATION};
ALTER SCHEMA public OWNER TO {MIGRATION};
REVOKE ALL ON SCHEMA public FROM PUBLIC;
GRANT CONNECT ON DATABASE {DATABASE} TO {APPLICATION};
GRANT USAGE ON SCHEMA public TO {APPLICATION};
ALTER DEFAULT PRIVILEGES FOR ROLE {MIGRATION} REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
COMMIT;
SELECT to_json(true);
"""


GRANTS = f"""
BEGIN;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC, {APPLICATION};
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM PUBLIC, {APPLICATION};
REVOKE ALL ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC, {APPLICATION};
DO $$ DECLARE t record; BEGIN
FOR t IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' LOOP
EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON public.%I TO {APPLICATION}',t.tablename);
END LOOP; END $$;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO {APPLICATION};
COMMIT;
SELECT to_json(true);
"""

# Evaluate effective privileges, not merely explicit ACL entries. Empty lists
# cannot establish a completed migration; the executor checks its manifest first.
AUDIT = f"""
SELECT to_json(
(SELECT count(*)=3 AND bool_and(rolcanlogin AND
 CASE WHEN rolname='{BOOTSTRAP}' THEN rolsuper ELSE
 NOT (rolsuper OR rolcreatedb OR rolcreaterole OR rolreplication OR rolbypassrls OR rolinherit) END)
 FROM pg_roles WHERE rolname IN ('{BOOTSTRAP}','{MIGRATION}','{APPLICATION}'))
AND NOT EXISTS (SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('{MIGRATION}','{APPLICATION}'))
AND (SELECT pg_get_userbyid(datdba)='{MIGRATION}' FROM pg_database WHERE datname='{DATABASE}')
AND (SELECT pg_get_userbyid(nspowner)='{MIGRATION}' FROM pg_namespace WHERE nspname='public')
AND has_database_privilege('{APPLICATION}','{DATABASE}','CONNECT')
AND NOT has_database_privilege('{APPLICATION}','{DATABASE}','CREATE')
AND NOT has_database_privilege('{APPLICATION}','{DATABASE}','TEMP')
AND NOT has_database_privilege('{APPLICATION}','postgres','CONNECT')
AND NOT has_database_privilege('{APPLICATION}','template1','CONNECT')
AND has_schema_privilege('{APPLICATION}','public','USAGE')
AND NOT has_schema_privilege('{APPLICATION}','public','CREATE')
AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tableowner <> '{MIGRATION}')
AND NOT EXISTS (SELECT 1 FROM pg_tables WHERE schemaname='public' AND tablename <> '_prisma_migrations' AND
 (EXISTS (SELECT 1 FROM unnest(ARRAY['SELECT','INSERT','UPDATE','DELETE']) AS p(privilege) WHERE NOT has_table_privilege('{APPLICATION}',format('public.%I',tablename),p.privilege))
 OR has_table_privilege('{APPLICATION}',format('public.%I',tablename),'TRUNCATE,REFERENCES,TRIGGER')))
AND NOT has_table_privilege('{APPLICATION}','public._prisma_migrations','SELECT,INSERT,UPDATE,DELETE,TRUNCATE,REFERENCES,TRIGGER')
AND NOT EXISTS (SELECT 1 FROM pg_sequences WHERE schemaname='public' AND
 (sequenceowner <> '{MIGRATION}' OR NOT has_sequence_privilege('{APPLICATION}',format('public.%I',sequencename),'USAGE')
 OR NOT has_sequence_privilege('{APPLICATION}',format('public.%I',sequencename),'SELECT')
 OR has_sequence_privilege('{APPLICATION}',format('public.%I',sequencename),'UPDATE')))
AND NOT EXISTS (SELECT 1 FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname='public'
 AND has_function_privilege('{APPLICATION}',p.oid,'EXECUTE')));
"""
