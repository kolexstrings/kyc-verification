export interface RetryOptions {
  retries?: number;
  delayMs?: number;
  maxDelayMs?: number;
  backoffFactor?: number;
  shouldRetry?: (error: any, attempt: number) => boolean;
  onRetry?: (params: { attempt: number; error: any; delayMs: number }) => void;
}

const defaultOptions: Required<Omit<RetryOptions, 'shouldRetry' | 'onRetry'>> = {
  retries: 3,
  delayMs: 500,
  maxDelayMs: 4000,
  backoffFactor: 2,
};

function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  operation: () => Promise<T>,
  options: RetryOptions = {}
): Promise<T> {
  const { retries, delayMs, maxDelayMs, backoffFactor } = {
    ...defaultOptions,
    ...options,
  };

  let attempt = 0;
  let currentDelay = delayMs;

  while (true) {
    try {
      return await operation();
    } catch (error) {
      attempt += 1;
      const shouldRetry = options.shouldRetry?.(error, attempt) ?? attempt <= retries;

      if (!shouldRetry || attempt > retries) {
        throw error;
      }

      options.onRetry?.({ attempt, error, delayMs: currentDelay });

      await sleep(currentDelay);
      currentDelay = Math.min(currentDelay * backoffFactor, maxDelayMs);
    }
  }
}
