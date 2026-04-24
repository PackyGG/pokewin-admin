export type PaginatedSlice<T> = {
  data: T[];
  total: number;
  page: number;
  perPage: number;
  totalPages: number;
};
