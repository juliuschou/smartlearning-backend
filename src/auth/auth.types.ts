import { Request } from 'express';

export interface PermissionSnapshot {
  roleIds: string[];
  roleCodes: string[];
  permissionCodes: string[];
}

export interface AuthenticatedSession {
  sessionId: string;
  userAccountId: string;
  permissionSnapshot: PermissionSnapshot;
}

export interface AuthenticatedRequest extends Request {
  auth: AuthenticatedSession;
}
