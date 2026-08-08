/** Maps to an HTTP response in app.onError — mirrors FastAPI's HTTPException. */
export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly detail: string,
  ) {
    super(detail);
    this.name = 'ApiError';
  }
}
