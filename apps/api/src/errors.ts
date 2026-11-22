export class ApiFailure extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export const unauthorized = () => new ApiFailure(401, 'UNAUTHORIZED', 'Authentication required');
export const forbidden = () =>
  new ApiFailure(403, 'FORBIDDEN', 'This role cannot perform this operation');
export const notFound = () => new ApiFailure(404, 'NOT_FOUND', 'Resource not found');
