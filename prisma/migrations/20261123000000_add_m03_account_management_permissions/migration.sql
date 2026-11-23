-- M03 account-management authorization catalog. M04 owns runtime permission maintenance;
-- this versioned migration mirrors the M02 precedent (20261122000000) by supplying the
-- initial V1 permission definitions needed by M03 teacher-account creation, mapped only
-- to SYSTEM_ADMIN.
INSERT INTO app.permission (permission_code, name, description, module_category, status)
VALUES
  ('M03_READ', '老師帳號查詢', '查詢老師帳號清單、明細及帳號狀態。', '老師維護', 'ENABLED'::app.permission_status_e),
  ('M03_WRITE', '老師帳號建立與維護', '建立老師正式帳號、維護基本資料及發起邀請；角色指派依 M03 流程執行。', '老師維護', 'ENABLED'::app.permission_status_e)
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO app.role_permission (role_id, permission_id)
SELECT role_record.id, permission_record.id
FROM app.role AS role_record
CROSS JOIN app.permission AS permission_record
WHERE role_record.role_code = 'SYSTEM_ADMIN'
  AND permission_record.permission_code IN ('M03_READ', 'M03_WRITE')
ON CONFLICT (role_id, permission_id) DO NOTHING;
