/**
 * Pagination contract — used by list/query endpoints (Phase 8 archive queries
 * and later). Defined now as a stable type so handlers stay consistent.
 */

export interface PageRequest {
  /** 1-based page number. */
  page: number;
  /** Items per page. */
  pageSize: number;
}

export interface Page<T> {
  data: T[];
  meta: {
    page: number;
    pageSize: number;
    total: number;
    totalPages: number;
  };
}

export const MAX_PAGE_SIZE = 100;
export const DEFAULT_PAGE_SIZE = 20;

export function normalizePageRequest(raw: {
  page?: number;
  pageSize?: number;
}): PageRequest {
  const page = Math.max(1, Math.floor(raw.page ?? 1));
  const pageSize = Math.min(
    MAX_PAGE_SIZE,
    Math.max(1, Math.floor(raw.pageSize ?? DEFAULT_PAGE_SIZE)),
  );
  return { page, pageSize };
}

export function toPage<T>(data: T[], total: number, req: PageRequest): Page<T> {
  return {
    data,
    meta: {
      page: req.page,
      pageSize: req.pageSize,
      total,
      totalPages: Math.ceil(total / req.pageSize) || 0,
    },
  };
}
