import { Response } from 'express';

export interface ApiResponse<T = any> {
  success: boolean;
  data?: T;
  message?: string;
  error?: string;
}

export class ResponseHandler {
  static success<T>(res: Response, data: T, message?: string, statusCode = 200) {
    const response: ApiResponse<T> = {
      success: true,
      data,
    };

    if (message) {
      response.message = message;
    }

    return res.status(statusCode).json(response);
  }

  static error<T>(res: Response, message: string, statusCode = 500, error?: string, data?: T) {
    const response: ApiResponse<T> = {
      success: false,
      message,
    };

    if (error) {
      response.error = error;
    }

    if (typeof data !== 'undefined') {
      response.data = data;
    }

    return res.status(statusCode).json(response);
  }

  static validationError(res: Response, errors: string[]) {
    return this.error(res, 'Validation failed', 400, errors.join(', '));
  }

  static notFound(res: Response, resource = 'Resource') {
    return this.error(res, `${resource} not found`, 404);
  }

  static unauthorized(res: Response, message = 'Unauthorized access') {
    return this.error(res, message, 401);
  }

  static forbidden(res: Response, message = 'Forbidden access') {
    return this.error(res, message, 403);
  }
}
