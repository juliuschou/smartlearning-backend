-- M02 role-management authorization catalog. M04 owns runtime permission maintenance;
-- this versioned migration supplies the initial V1 permission definitions and mapping.
INSERT INTO app.role (role_code, name, description, is_system_reserved, status)
VALUES
  ('SYSTEM_ADMIN', '系統管理者', '管理平台帳號、角色、功能授權及系統設定；不自動取得授課能力。', TRUE, 'ENABLED'::app.role_status_e),
  ('TEACHER', '老師', '維護自己的題庫、建立並主持教學活動、檢視自己的報表。', TRUE, 'ENABLED'::app.role_status_e)
ON CONFLICT (role_code) DO NOTHING;

INSERT INTO app.permission (permission_code, name, description, module_category, status)
VALUES
  ('M02_READ', '角色檢視', '查詢固定角色清單、角色明細及角色目前的功能授權摘要。', '角色', 'ENABLED'::app.permission_status_e),
  ('M02_WRITE', '角色狀態維護', '啟用或停用固定角色；不得修改角色基本資料或刪除角色。', '角色', 'ENABLED'::app.permission_status_e)
ON CONFLICT (permission_code) DO NOTHING;

INSERT INTO app.role_permission (role_id, permission_id)
SELECT role_record.id, permission_record.id
FROM app.role AS role_record
CROSS JOIN app.permission AS permission_record
WHERE role_record.role_code = 'SYSTEM_ADMIN'
  AND permission_record.permission_code IN ('M02_READ', 'M02_WRITE')
ON CONFLICT (role_id, permission_id) DO NOTHING;
